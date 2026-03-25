/**
 * Agent runtime utilities for NanoClaw.
 * Replaced Docker/Apple Container abstraction with direct node process execution.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/** Returns the path to the compiled agent-runner entry point. */
export function getAgentRunnerPath(): string {
  return path.join(process.cwd(), 'container', 'agent-runner', 'dist', 'index.js');
}

/** Ensure the agent-runner is compiled and ready to run. */
export function ensureAgentRunnerReady(): void {
  const agentRunnerPath = getAgentRunnerPath();
  if (!fs.existsSync(agentRunnerPath)) {
    logger.error({ agentRunnerPath }, 'Agent runner not compiled');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Agent runner not compiled                              ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Run the following to build it:                                ║',
    );
    console.error(
      '║    cd container/agent-runner && npm run build                  ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Agent runner is not compiled', {
      cause: `Missing: ${agentRunnerPath}`,
    });
  }
  logger.debug({ agentRunnerPath }, 'Agent runner ready');
}
