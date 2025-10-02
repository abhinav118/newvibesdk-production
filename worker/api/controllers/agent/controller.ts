import { WebSocketMessageResponses } from '../../../agents/constants';
import { BaseController } from '../baseController';
import { generateId } from '../../../utils/idGenerator';
import { CodeGenState } from '../../../agents/core/state';
import { getAgentStub, getTemplateForQuery } from '../../../agents';
import { routeAgentRequest } from 'agents';
import { AgentConnectionData, AgentPreviewResponse, CodeGenArgs } from './types';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { ModelConfigService } from '../../../database';
import { ModelConfig } from '../../../agents/inferutils/config.types';
import { RateLimitService } from '../../../services/rate-limit/rateLimits';
import { validateWebSocketOrigin } from '../../../middleware/security/websocket';
import { createLogger } from '../../../logger';
import { getPreviewDomain } from 'worker/utils/urls';

const defaultCodeGenArgs: CodeGenArgs = {
    query: '',
    language: 'typescript',
    frameworks: ['react', 'vite'],
    selectedTemplate: 'auto',
    agentMode: 'deterministic',
};


/**
 * CodingAgentController to handle all code generation related endpoints
 */
export class CodingAgentController extends BaseController {
    static logger = createLogger('CodingAgentController');
    /**
     * Start the incremental code generation process
     */
    static async startCodeGeneration(request: Request, env: Env, _: ExecutionContext, context: RouteContext): Promise<Response> {
        try {
            this.logger.info('🚀 Starting code generation process');
            this.logger.info('Request details:', {
                method: request.method,
                url: request.url,
                userAgent: request.headers.get('user-agent'),
                contentType: request.headers.get('content-type'),
                authorization: request.headers.get('authorization') ? 'present' : 'missing'
            });

            const url = new URL(request.url);
            const hostname = url.hostname === 'localhost' ? `localhost:${url.port}`: getPreviewDomain(env);
            this.logger.info('Hostname determined:', { hostname, originalHostname: url.hostname });
            
            // Parse the query from the request body
            let body: CodeGenArgs;
            try {
                this.logger.info('📝 Parsing request body...');
                body = await request.json() as CodeGenArgs;
                this.logger.info('Request body parsed successfully:', {
                    query: body.query,
                    language: body.language,
                    frameworks: body.frameworks,
                    agentMode: body.agentMode,
                    selectedTemplate: body.selectedTemplate
                });
            } catch (error) {
                this.logger.error('❌ Failed to parse request body:', error);
                return CodingAgentController.createErrorResponse(`Invalid JSON in request body: ${JSON.stringify(error, null, 2)}`, 400);
            }

            const query = body.query;
            if (!query) {
                this.logger.error('❌ Missing query field in request body');
                return CodingAgentController.createErrorResponse('Missing "query" field in request body', 400);
            }
            this.logger.info('✅ Query validated:', { query, queryLength: query.length });
            const { readable, writable } = new TransformStream({
                transform(chunk, controller) {
                    if (chunk === "terminate") {
                        controller.terminate();
                    } else {
                        const encoded = new TextEncoder().encode(JSON.stringify(chunk) + '\n');
                        controller.enqueue(encoded);
                    }
                }
            });
            const writer = writable.getWriter();
            // Handle both authenticated and anonymous users
            const user = context.user;
            this.logger.info('👤 User context:', { 
                hasUser: !!user, 
                userId: user?.id || 'anonymous',
                userEmail: user?.email || 'anonymous'
            });
            
            if (user) {
                try {
                    this.logger.info('🔒 Applying rate limiting for authenticated user...');
                    await RateLimitService.enforceAppCreationRateLimit(env, context.config.security.rateLimit, user, request);
                    this.logger.info('✅ Rate limiting passed for authenticated user');
                } catch (error) {
                    this.logger.error('❌ Rate limiting failed for authenticated user:', error);
                    if (error instanceof Error) {
                        return CodingAgentController.createErrorResponse(error, 429);
                    } else {
                        this.logger.error('Unknown error in enforceAppCreationRateLimit', error);
                        return CodingAgentController.createErrorResponse(JSON.stringify(error), 429);
                    }
                }
            } else {
                this.logger.info('🔓 Anonymous user - skipping rate limiting');
            }

            const agentId = generateId();
            this.logger.info('🆔 Generated agent ID:', { agentId });
            
            const modelConfigService = new ModelConfigService(env);
            this.logger.info('⚙️ Model config service initialized');
                                
            // Fetch all user model configs, api keys and agent instance at once
            let userConfigsRecord: any;
            let agentInstance: any;
            
            try {
                this.logger.info('🔄 Fetching user configs and creating agent stub...');
                [userConfigsRecord, agentInstance] = await Promise.all([
                    user ? modelConfigService.getUserModelConfigs(user.id) : Promise.resolve({}),
                    getAgentStub(env, agentId, false, this.logger)
                ]);
                this.logger.info('✅ User configs and agent stub created successfully:', {
                    userConfigsCount: Object.keys(userConfigsRecord).length,
                    agentInstanceType: typeof agentInstance,
                    hasAgentInstance: !!agentInstance
                });
            } catch (error) {
                this.logger.error('❌ Error fetching user configs or creating agent stub:', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    agentId
                });
                return CodingAgentController.createErrorResponse(`Failed to initialize agent: ${error instanceof Error ? error.message : String(error)}`, 500);
            }
                                
            // Convert Record to Map and extract only ModelConfig properties
            this.logger.info('🔧 Processing user model configs...');
            const userModelConfigs = new Map();
            for (const [actionKey, mergedConfig] of Object.entries(userConfigsRecord)) {
                if ((mergedConfig as any).isUserOverride) {
                    const modelConfig: ModelConfig = {
                        name: (mergedConfig as any).name,
                        max_tokens: (mergedConfig as any).max_tokens,
                        temperature: (mergedConfig as any).temperature,
                        reasoning_effort: (mergedConfig as any).reasoning_effort,
                        fallbackModel: (mergedConfig as any).fallbackModel
                    };
                    userModelConfigs.set(actionKey, modelConfig);
                    this.logger.info(`📋 Added model config for ${actionKey}:`, modelConfig);
                }
            }

            const inferenceContext = {
                userModelConfigs: Object.fromEntries(userModelConfigs),
                agentId: agentId,
                userId: user?.id || 'anonymous',
                enableRealtimeCodeFix: true, // For now disabled from the model configs itself
            }
                                
            this.logger.info(`✅ Initialized inference context for user ${user?.id || 'anonymous'}`, {
                modelConfigsCount: Object.keys(userModelConfigs).length,
                inferenceContext: {
                    agentId: inferenceContext.agentId,
                    userId: inferenceContext.userId,
                    enableRealtimeCodeFix: inferenceContext.enableRealtimeCodeFix,
                    userModelConfigsKeys: Object.keys(inferenceContext.userModelConfigs)
                }
            });

            let sandboxSessionId: string;
            let templateDetails: any;
            let selection: any;
            
            try {
                this.logger.info('🎯 Getting template for query...', { query, agentId });
                const templateResult = await getTemplateForQuery(env, inferenceContext, query, this.logger);
                sandboxSessionId = templateResult.sandboxSessionId;
                templateDetails = templateResult.templateDetails;
                selection = templateResult.selection;
                this.logger.info('✅ Template selection completed:', {
                    sandboxSessionId,
                    templateName: templateDetails?.name,
                    templateFiles: templateDetails?.files?.length || 0,
                    selectionReasoning: selection?.reasoning,
                    selectedTemplateName: selection?.selectedTemplateName
                });
            } catch (error) {
                this.logger.error('❌ Error getting template for query:', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    query,
                    agentId
                });
                return CodingAgentController.createErrorResponse(`Failed to get template for query: ${error instanceof Error ? error.message : String(error)}`, 500);
            }

            const websocketUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/agent/${agentId}/ws`;
            const httpStatusUrl = `${url.origin}/api/agent/${agentId}`;
            
            this.logger.info('🔗 Generated URLs:', { websocketUrl, httpStatusUrl });
        
            const initialResponse = {
                message: 'Code generation started',
                agentId: agentId,
                websocketUrl,
                httpStatusUrl,
                template: {
                    name: templateDetails.name,
                    files: templateDetails.files,
                }
            };
            
            this.logger.info('📤 Sending initial response to client:', initialResponse);
            writer.write(initialResponse);

            const agentInitParams = {
                query,
                language: body.language || defaultCodeGenArgs.language,
                frameworks: body.frameworks || defaultCodeGenArgs.frameworks,
                hostname,
                inferenceContext,
                onBlueprintChunk: (chunk: string) => {
                    this.logger.info('📋 Blueprint chunk received:', { chunkLength: chunk.length });
                    writer.write({chunk});
                },
                templateInfo: { templateDetails, selection },
                sandboxSessionId
            };
            
            this.logger.info('🚀 Initializing agent with params:', {
                agentId,
                query: agentInitParams.query,
                language: agentInitParams.language,
                frameworks: agentInitParams.frameworks,
                hostname: agentInitParams.hostname,
                sandboxSessionId: agentInitParams.sandboxSessionId,
                agentMode: body.agentMode || defaultCodeGenArgs.agentMode
            });
            
            const agentPromise = agentInstance.initialize(agentInitParams, body.agentMode || defaultCodeGenArgs.agentMode) as Promise<CodeGenState>;
            
            agentPromise.then(async (_state: CodeGenState) => {
                this.logger.info(`✅ Agent ${agentId} completed successfully`);
                writer.write("terminate");
                writer.close();
            }).catch((error) => {
                this.logger.error(`❌ Agent ${agentId} initialization failed:`, {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    agentId
                });
                writer.write({error: `Agent initialization failed: ${error instanceof Error ? error.message : String(error)}`});
                writer.close();
            });

            this.logger.info(`🎯 Agent ${agentId} initialization launched successfully`);
            
            return new Response(readable, {
                status: 200,
                headers: {
                    // Use SSE content-type to ensure Cloudflare disables buffering,
                    // while the payload remains NDJSON lines consumed by the client.
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    // Prevent intermediary caches/proxies from buffering or transforming
                    'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform',
                    'Pragma': 'no-cache',
                    'Connection': 'keep-alive'
                }
            });
        } catch (error) {
            this.logger.error('❌ Fatal error starting code generation:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                requestUrl: request.url,
                requestMethod: request.method
            });
            return CodingAgentController.handleError(error, 'start code generation');
        }
    }

    /**
     * Handle WebSocket connections for code generation
     * This routes the WebSocket connection directly to the Agent
     */
    static async handleWebSocketConnection(
        request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<Response> {
        try {
            const chatId = context.pathParams.agentId; // URL param is still agentId for backward compatibility
            if (!chatId) {
                return CodingAgentController.createErrorResponse('Missing agent ID parameter', 400);
            }

            // Ensure the request is a WebSocket upgrade request
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket upgrade', { status: 426 });
            }
            
            // Validate WebSocket origin
            if (!validateWebSocketOrigin(request, env)) {
                return new Response('Forbidden: Invalid origin', { status: 403 });
            }

            // Allow anonymous users for newly created agents
            // The ownership check will be handled by the agent itself

            this.logger.info(`WebSocket connection request for chat: ${chatId}`);
            
            // Log request details for debugging
            const headers: Record<string, string> = {};
            request.headers.forEach((value, key) => {
                headers[key] = value;
            });
            this.logger.info('WebSocket request details', {
                headers,
                url: request.url,
                chatId
            });

            try {
                // Use routeAgentRequest to properly route the WebSocket connection to the agent
                // This handles the namespace and room headers automatically
                const response = await routeAgentRequest(request, env, {
                    cors: true
                });
                
                if (response) {
                    this.logger.info(`Successfully routed WebSocket connection for chat: ${chatId}`);
                    return response;
                } else {
                    // Fallback to direct agent connection if routing fails
                    this.logger.info(`RouteAgentRequest returned null, falling back to direct connection for chat: ${chatId}`);
                    const agentInstance = await getAgentStub(env, chatId, true, this.logger);
                    
                    // Create a new request with the required namespace and room headers for the agents package
                    const modifiedRequest = new Request(request.url, {
                        method: request.method,
                        headers: {
                            ...Object.fromEntries(request.headers.entries()),
                            'namespace': 'CodeGenObject',
                            'room': chatId
                        },
                        body: request.body,
                        cf: request.cf
                    });

                    // Let the agent handle the WebSocket connection with proper headers
                    return agentInstance.fetch(modifiedRequest);
                }
            } catch (error) {
                this.logger.error(`Failed to get agent instance with ID ${chatId}:`, error);
                // Return an appropriate WebSocket error response
                // We need to emulate a WebSocket response even for errors
                const { 0: client, 1: server } = new WebSocketPair();

                server.accept();
                server.send(JSON.stringify({
                    type: WebSocketMessageResponses.ERROR,
                    error: `Failed to get agent instance: ${error instanceof Error ? error.message : String(error)}`
                }));

                server.close(1011, 'Agent instance not found');

                return new Response(null, {
                    status: 101,
                    webSocket: client
                });
            }
        } catch (error) {
            this.logger.error('Error handling WebSocket connection', error);
            return CodingAgentController.handleError(error, 'handle WebSocket connection');
        }
    }

    /**
     * Connect to an existing agent instance
     * Returns connection information for an already created agent
     */
    static async connectToExistingAgent(
        request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentConnectionData>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentConnectionData>('Missing agent ID parameter', 400);
            }

            this.logger.info(`Connecting to existing agent: ${agentId}`);

            try {
                // Verify the agent instance exists
                const agentInstance = await getAgentStub(env, agentId, true, this.logger);
                if (!agentInstance || !(await agentInstance.isInitialized())) {
                    return CodingAgentController.createErrorResponse<AgentConnectionData>('Agent instance not found or not initialized', 404);
                }
                this.logger.info(`Successfully connected to existing agent: ${agentId}`);

                // Construct WebSocket URL
                const url = new URL(request.url);
                const websocketUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/agent/${agentId}/ws`;

                const responseData: AgentConnectionData = {
                    websocketUrl,
                    agentId,
                };

                return CodingAgentController.createSuccessResponse(responseData);
            } catch (error) {
                this.logger.error(`Failed to connect to agent ${agentId}:`, error);
                return CodingAgentController.createErrorResponse<AgentConnectionData>(`Agent instance not found or unavailable: ${error instanceof Error ? error.message : String(error)}`, 404);
            }
        } catch (error) {
            this.logger.error('Error connecting to existing agent', error);
            return CodingAgentController.handleError(error, 'connect to existing agent') as ControllerResponse<ApiResponse<AgentConnectionData>>;
        }
    }

    static async deployPreview(
        _request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentPreviewResponse>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Missing agent ID parameter', 400);
            }

            this.logger.info(`Deploying preview for agent: ${agentId}`);

            try {
                // Get the agent instance
                const agentInstance = await getAgentStub(env, agentId, true, this.logger);
                
                // Deploy the preview
                const preview = await agentInstance.deployToSandbox();
                if (!preview) {
                    return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
                }
                this.logger.info('Preview deployed successfully', {
                    agentId,
                    previewUrl: preview.previewURL
                });

                return CodingAgentController.createSuccessResponse(preview);
            } catch (error) {
                this.logger.error('Failed to deploy preview', { agentId, error });
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
            }
        } catch (error) {
            this.logger.error('Error deploying preview', error);
            const appError = CodingAgentController.handleError(error, 'deploy preview') as ControllerResponse<ApiResponse<AgentPreviewResponse>>;
            return appError;
        }
    }
}