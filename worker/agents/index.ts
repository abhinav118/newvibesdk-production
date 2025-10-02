
/// <reference path="../../worker-configuration.d.ts" />
import { CodeGenState } from './core/state';
import { generateId } from '../utils/idGenerator';
import { StructuredLogger } from '../logger';
import { InferenceContext } from './inferutils/config.types';
import { SandboxSdkClient } from '../services/sandbox/sandboxSdkClient';
import { selectTemplate } from './planning/templateSelector';
import { getSandboxService } from '../services/sandbox/factory';
import { TemplateDetails } from '../services/sandbox/sandboxTypes';
import { TemplateSelection } from './schemas';

// Utility function to get Durable Object stub by name
async function getAgentByName(
    namespace: any,
    name: string,
    options?: {
        locationHint?: string;
        jurisdiction?: string;
    }
): Promise<any> {
    const id = namespace.idFromName(name);
    return namespace.get(id, options);
}

export async function getAgentStub(env: Env, agentId: string, searchInOtherJurisdictions: boolean = false, logger: StructuredLogger) : Promise<any> {
    logger.info('🔧 Starting getAgentStub', { agentId, searchInOtherJurisdictions });
    
    // Check if CodeGenObject namespace is available
    if (!env.CodeGenObject) {
        logger.error('❌ CodeGenObject namespace not available in environment');
        throw new Error('CodeGenObject namespace not available in environment');
    }
    logger.info('✅ CodeGenObject namespace is available');
    
    if (searchInOtherJurisdictions) {
        // Try multiple jurisdictions until we find the agent
        const jurisdictions = [undefined, 'eu'];
        for (const jurisdiction of jurisdictions) {
            try {
                logger.info(`🔍 Agent ${agentId} retrieving from jurisdiction ${jurisdiction}`);
                const stub = await getAgentByName(env.CodeGenObject, agentId, {
                    locationHint: 'enam',
                    jurisdiction: jurisdiction,
                });
                const isInitialized = await stub.isInitialized()
                if (isInitialized) {
                    logger.info(`✅ Agent ${agentId} found in jurisdiction ${jurisdiction}`);
                    return stub
                }
            } catch (error) {
                logger.info(`❌ Agent ${agentId} not found in jurisdiction ${jurisdiction}:`, error);
            }
        }
        // If all jurisdictions fail, throw an error
        // throw new Error(`Agent ${agentId} not found in any jurisdiction`);
    }
    
    logger.info(`🎯 Agent ${agentId} retrieving directly`);
    try {
        const stub = await getAgentByName(env.CodeGenObject, agentId, {
            locationHint: 'enam'
        });
        logger.info(`✅ Agent ${agentId} stub created successfully`);
        return stub;
    } catch (error) {
        logger.error(`❌ Failed to create agent stub for ${agentId}:`, error);
        throw error;
    }
}

export async function getAgentState(env: Env, agentId: string, searchInOtherJurisdictions: boolean = false, logger: StructuredLogger) : Promise<CodeGenState> {
    const agentInstance = await getAgentStub(env, agentId, searchInOtherJurisdictions, logger);
    return agentInstance.getFullState() as CodeGenState;
}

export async function cloneAgent(env: Env, agentId: string, logger: StructuredLogger) : Promise<{newAgentId: string, newAgent: any}> {
    const agentInstance = await getAgentStub(env, agentId, true, logger);
    if (!agentInstance || !await agentInstance.isInitialized()) {
        throw new Error(`Agent ${agentId} not found`);
    }
    const newAgentId = generateId();

    const newAgent = await getAgentStub(env, newAgentId, false, logger);
    const originalState = await agentInstance.getFullState() as CodeGenState;
    const newState = {
        ...originalState,
        sessionId: newAgentId,
        sandboxInstanceId: undefined,
        pendingUserInputs: [],
        currentDevState: 0,
        generationPromise: undefined,
        shouldBeGenerating: false,
        // latestScreenshot: undefined,
        clientReportedErrors: [],
    };

    await newAgent.setState(newState);
    return {newAgentId, newAgent};
}

export async function getTemplateForQuery(
    env: Env,
    inferenceContext: InferenceContext,
    query: string,
    logger: StructuredLogger,
) : Promise<{sandboxSessionId: string, templateDetails: TemplateDetails, selection: TemplateSelection}> {
    logger.info('🎯 Starting getTemplateForQuery', { query, agentId: inferenceContext.agentId });
    
    // Fetch available templates
    logger.info('📋 Fetching available templates from sandbox service...');
    const templatesResponse = await SandboxSdkClient.listTemplates();
    logger.info('📋 Templates response received:', { 
        success: templatesResponse?.success, 
        templatesCount: templatesResponse?.templates?.length || 0,
        error: templatesResponse?.error
    });
    
    if (!templatesResponse || !templatesResponse.success) {
        logger.error('❌ Failed to fetch templates from sandbox service:', {
            response: templatesResponse,
            error: templatesResponse?.error
        });
        throw new Error(`Failed to fetch templates from sandbox service: ${templatesResponse?.error || 'Unknown error'}`);
    }

    const sandboxSessionId = generateId();
    logger.info('🆔 Generated sandbox session ID:', { sandboxSessionId });
        
    logger.info('🤖 Starting template selection and sandbox service initialization...');
    const [analyzeQueryResponse, sandboxClient] = await Promise.all([
            selectTemplate({
                env: env,
                inferenceContext,
                query,
                availableTemplates: templatesResponse.templates,
            }), 
            getSandboxService(sandboxSessionId)
        ]);
        
    logger.info('✅ Template selection and sandbox service completed:', { 
        selectedTemplate: analyzeQueryResponse,
        sandboxClientType: typeof sandboxClient,
        hasSandboxClient: !!sandboxClient
    });
            
    // Find the selected template by name in the available templates
    logger.info('🔍 Validating selected template...', { 
        selectedTemplateName: analyzeQueryResponse.selectedTemplateName,
        reasoning: analyzeQueryResponse.reasoning 
    });
    
    if (!analyzeQueryResponse.selectedTemplateName) {
        logger.error('❌ No suitable template found for code generation:', {
            analyzeQueryResponse,
            availableTemplates: templatesResponse.templates.map(t => t.name)
        });
        throw new Error('No suitable template found for code generation');
    }
            
    const selectedTemplate = templatesResponse.templates.find(template => template.name === analyzeQueryResponse.selectedTemplateName);
    logger.info('🎯 Template lookup result:', { 
        selectedTemplateName: analyzeQueryResponse.selectedTemplateName,
        found: !!selectedTemplate,
        templateDetails: selectedTemplate ? {
            name: selectedTemplate.name,
            language: selectedTemplate.language,
            frameworks: selectedTemplate.frameworks
        } : null
    });
    
    if (!selectedTemplate) {
        logger.error('❌ Selected template not found in available templates:', {
            selectedTemplateName: analyzeQueryResponse.selectedTemplateName,
            availableTemplates: templatesResponse.templates.map(t => t.name)
        });
        throw new Error(`Selected template '${analyzeQueryResponse.selectedTemplateName}' not found in available templates`);
    }
    // Now fetch all the files from the instance
    logger.info('📁 Fetching template details...', { templateName: selectedTemplate.name });
    const templateDetailsResponse = await sandboxClient.getTemplateDetails(selectedTemplate.name);
    logger.info('📁 Template details response:', { 
        success: templateDetailsResponse.success,
        hasTemplateDetails: !!templateDetailsResponse.templateDetails,
        filesCount: templateDetailsResponse.templateDetails?.files?.length || 0,
        error: templateDetailsResponse.error
    });
    
    if (!templateDetailsResponse.success || !templateDetailsResponse.templateDetails) {
        logger.error('❌ Failed to fetch template details:', { 
            templateDetailsResponse,
            templateName: selectedTemplate.name
        });
        throw new Error(`Failed to fetch template details: ${templateDetailsResponse.error || 'Unknown error'}`);
    }
            
    const templateDetails = templateDetailsResponse.templateDetails;
    logger.info('✅ getTemplateForQuery completed successfully:', {
        sandboxSessionId,
        templateName: templateDetails.name,
        filesCount: templateDetails.files?.length || 0,
        selectedTemplateName: analyzeQueryResponse.selectedTemplateName
    });
    
    return { sandboxSessionId, templateDetails, selection: analyzeQueryResponse };
}