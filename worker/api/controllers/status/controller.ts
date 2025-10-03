import { BaseController } from '../baseController';
import type { ApiResponse, ControllerResponse } from '../types';
import type { RouteContext } from '../../types/route-context';
import type { PlatformStatusData } from './types';
import { isDispatcherAvailable } from '../../../utils/dispatcherUtils';

export class StatusController extends BaseController {
    static async getPlatformStatus(
        _request: Request,
        _env: Env,
        _ctx: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<PlatformStatusData>>> {
        const messaging = context.config.globalMessaging ?? { globalUserMessage: '', changeLogs: '' };
        const globalUserMessage = messaging.globalUserMessage ?? '';
        const changeLogs = messaging.changeLogs ?? '';

        const data: PlatformStatusData = {
            globalUserMessage,
            changeLogs,
            hasActiveMessage: globalUserMessage.trim().length > 0,
        };

        return StatusController.createSuccessResponse(data);
    }

    /**
     * Test Workers for Platforms functionality
     */
    static async testWorkersForPlatforms(
        _request: Request,
        env: Env,
        _ctx: ExecutionContext,
        _context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<any>>> {
        try {
            // Check if dispatcher is available
            const dispatcherAvailable = isDispatcherAvailable(env);
            
            // Get namespace information
            const namespaceInfo = {
                binding: 'DISPATCHER',
                namespace: env.DISPATCH_NAMESPACE || 'vibesdk-default-namespace',
                available: dispatcherAvailable
            };

            // Test dispatcher functionality if available
            let dispatcherTest = null;
            if (dispatcherAvailable) {
                try {
                    // Check if dispatcher binding exists and is functional
                    const dispatcher = env.DISPATCHER;
                    if (dispatcher) {
                        dispatcherTest = {
                            status: 'available',
                            message: 'Dispatcher binding is available and functional',
                            bindingType: typeof dispatcher
                        };
                    } else {
                        dispatcherTest = {
                            status: 'error',
                            message: 'Dispatcher binding exists but is null/undefined'
                        };
                    }
                } catch (error) {
                    dispatcherTest = {
                        status: 'error',
                        message: `Dispatcher error: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            } else {
                dispatcherTest = {
                    status: 'unavailable',
                    message: 'Dispatcher binding not available - Workers for Platforms may not be enabled'
                };
            }

            const data = {
                workersForPlatforms: {
                    enabled: dispatcherAvailable,
                    namespace: namespaceInfo,
                    dispatcher: dispatcherTest,
                    timestamp: new Date().toISOString()
                }
            };

            return StatusController.createSuccessResponse(data);
        } catch (error) {
            return StatusController.createErrorResponse(
                `Error testing Workers for Platforms: ${error instanceof Error ? error.message : String(error)}`,
                500
            );
        }
    }
}
