/// <reference path="../../../worker-configuration.d.ts" />
import type { ToolDefinition } from './types';

export async function executeToolWithDefinition<TArgs, TResult>(
    toolDef: ToolDefinition<TArgs, TResult>,
    args: TArgs,
    env: Env
): Promise<TResult> {
    toolDef.onStart?.(args);
    const result = await toolDef.implementation(args, env);  // Pass env here
    toolDef.onComplete?.(args, result);
    return result;
}
