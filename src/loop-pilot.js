/**
 * Loop Pilot integration for Cal Gateway.
 *
 * This is intentionally advisory: it asks Loop Pilot for a planning hint before
 * a task starts, then gives that hint to the model as prompt context.
 */

import { getFeatureConfig } from './features.js';
import { getMCPClientManager } from './mcp-client.js';
import { logError } from './logger.js';

const SERVER_NAME = 'loop-pilot';
const TOOL_NAME = 'plan_task';

export function shouldInjectLoopPilotGuidance(options = {}) {
  if (options.internal || options.isHandoff) return false;

  const config = getFeatureConfig('loopPilot');
  if (!config?.enabled) return false;

  return config.mode === 'guidance';
}

export async function getLoopPilotGuidance(task, options = {}) {
  if (!shouldInjectLoopPilotGuidance(options)) return null;
  if (!task || typeof task !== 'string') return null;

  const manager = getMCPClientManager();
  if (!manager.isConnected(SERVER_NAME)) {
    console.warn('[LoopPilot] MCP server not connected; skipping guidance');
    return null;
  }

  try {
    const maxBudget = Number.isFinite(options.maxIterations) ? options.maxIterations : undefined;
    const raw = await manager.callTool(SERVER_NAME, TOOL_NAME, {
      task,
      ...(maxBudget ? { maxBudget } : {}),
    });
    const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!plan?.promptGuidance) return null;

    console.log(`[LoopPilot] Guidance ready: budget=${plan.prediction?.suggestedBudget ?? 'unknown'}, risk=${plan.prediction?.risk ?? 'unknown'}`);
    return formatLoopPilotGuidance(plan.promptGuidance, maxBudget);
  } catch (err) {
    console.warn('[LoopPilot] Guidance unavailable:', err.message);
    logError('looppilot_guidance_error', {
      session: options.sessionId || 'unknown',
      message: task.substring(0, 100),
      error: err.message,
      recovery: 'Continuing without Loop Pilot guidance',
    });
    return null;
  }
}

function formatLoopPilotGuidance(promptGuidance, maxIterations) {
  const maxIterationLine = maxIterations
    ? `\n\nHarness note: Cal's configured max-iteration limit for this run is ${maxIterations}. Loop Pilot is advisory only; do not treat the suggested budget as a hard limit.`
    : '';

  return `[SYSTEM: Loop Pilot is a behavior-memory planner. It looked at similar past Cal runs and produced this advisory note before the tool loop starts.\n\n${promptGuidance}${maxIterationLine}\n\nPrinciple: inform, then trust the model. Use this to plan your tool use, but continue to reason normally.]`;
}
