import { MessageRole } from '../inferutils/common';
import { TemplateListResponse} from '../../services/sandbox/sandboxTypes';
import { createLogger } from '../../logger';
import { executeInference } from '../inferutils/infer';
import { InferenceContext } from '../inferutils/config.types';
import { RateLimitExceededError, SecurityError } from 'shared/types/errors';
import { TemplateSelection, TemplateSelectionSchema } from '../../agents/schemas';
import { generateSecureToken } from 'worker/utils/cryptoUtils';

const logger = createLogger('TemplateSelector');
interface SelectTemplateArgs {
    env: Env;
    query: string;
    availableTemplates: TemplateListResponse['templates'];
    inferenceContext: InferenceContext;
}

/**
 * Uses AI to select the most suitable template for a given query.
 */
export async function selectTemplate({ env, query, availableTemplates, inferenceContext }: SelectTemplateArgs): Promise<TemplateSelection> {
    logger.info("🎯 Starting template selection", { 
        query, 
        availableTemplatesCount: availableTemplates.length,
        agentId: inferenceContext.agentId
    });
    
    if (availableTemplates.length === 0) {
        logger.error("❌ No templates available for selection");
        return { selectedTemplateName: null, reasoning: "No templates were available to choose from.", useCase: null, complexity: null, styleSelection: null, projectName: '' };
    }

    logger.info("📋 Available templates:", { 
        templateNames: availableTemplates.map(t => t.name),
        templateDetails: availableTemplates.map(t => ({
            name: t.name,
            language: t.language,
            frameworks: t.frameworks,
            description: t.description?.selection?.substring(0, 100) + '...'
        }))
    });

    try {
        logger.info("🤖 Asking AI to select a template", { 
            query, 
            queryLength: query.length,
            availableTemplates: availableTemplates.map(t => t.name),
            templateCount: availableTemplates.length 
        });

        const templateDescriptions = availableTemplates.map((t, index) =>
            `- Template #${index + 1} \n Name - ${t.name} \n Language: ${t.language}, Frameworks: ${t.frameworks?.join(', ') || 'None'}\n ${t.description.selection}`
        ).join('\n\n');

        const systemPrompt = `You are an Expert Software Architect at Cloudflare specializing in template selection for rapid development. Your task is to select the most suitable starting template based on user requirements.

## SELECTION EXAMPLES:

**Example 1 - Game Request:**
User: "Build a 2D puzzle game with scoring"
Templates: ["react-dashboard", "react-game-starter", "vue-blog"]
Selection: "react-game-starter"
complexity: "simple"
Reasoning: "Game starter template provides canvas setup, state management, and scoring systems"

**Example 2 - Business Dashboard:**
User: "Create an analytics dashboard with charts"
Templates: ["react-dashboard", "nextjs-blog", "vanilla-js"]
Selection: "react-dashboard"
complexity: "simple" // Because single page application
Reasoning: "Dashboard template includes chart components, grid layouts, and data visualization setup"

**Example 3 - No Perfect Match:**
User: "Build a recipe sharing app"
Templates: ["react-social", "vue-blog", "angular-todo"]
Selection: "react-social"
complexity: "simple" // Because single page application
Reasoning: "Social template provides user interactions, content sharing, and community features closest to recipe sharing needs"

## SELECTION CRITERIA:
1. **Feature Alignment** - Templates with similar core functionality
2. **Tech Stack Match** - Compatible frameworks and dependencies  
3. **Architecture Fit** - Similar application structure and patterns
4. **Minimal Modification** - Template requiring least changes

## STYLE GUIDE:
- **Minimalist Design**: Clean, simple interfaces
- **Brutalism**: Bold, raw, industrial aesthetics
- **Retro**: Vintage, nostalgic design elements
- **Illustrative**: Rich graphics and visual storytelling
- **Kid_Playful**: Colorful, fun, child-friendly interfaces

## RULES:
- ALWAYS select a template (never return null)
- Ignore misleading template names - analyze actual features
- Focus on functionality over naming conventions
- Provide clear, specific reasoning for selection`

        const userPrompt = `**User Request:** "${query}"

**Available Templates:**
${templateDescriptions}

**Task:** Select the most suitable template and provide:
1. Template name (exact match from list)
2. Clear reasoning for why it fits the user's needs
3. Appropriate style for the project type. Try to come up with unique styles that might look nice and unique. Be creative about your choices.
4. Descriptive project name

Analyze each template's features, frameworks, and architecture to make the best match.

ENTROPY SEED: ${generateSecureToken(64)} - for unique results`;

        const messages = [
            { role: "system" as MessageRole, content: systemPrompt },
            { role: "user" as MessageRole, content: userPrompt }
        ];

        logger.info("🧠 Executing AI inference for template selection...");
        const { object: selection } = await executeInference({
            env,
            messages,
            agentActionName: "templateSelection",
            schema: TemplateSelectionSchema,
            context: inferenceContext,
            maxTokens: 2000,
        });

        logger.info("✅ AI template selection completed:", {
            selectedTemplateName: selection.selectedTemplateName,
            reasoning: selection.reasoning,
            useCase: selection.useCase,
            complexity: selection.complexity,
            projectName: selection.projectName
        });
        return selection;

    } catch (error) {
        logger.error("❌ Error during AI template selection:", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            query,
            availableTemplatesCount: availableTemplates.length
        });
        
        if (error instanceof RateLimitExceededError || error instanceof SecurityError) {
            throw error;
        }
        
        // Fallback to no template selection in case of error
        logger.error("🔄 AI template selection failed, falling back to default selection");
        return { selectedTemplateName: null, reasoning: "An error occurred during the template selection process.", useCase: null, complexity: null, styleSelection: null, projectName: '' };
    }
}