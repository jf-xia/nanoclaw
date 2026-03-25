/**
 * Step: agent-runner — Build the agent-runner TypeScript and verify dist/index.js exists.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const distEntry = path.join(agentRunnerDir, 'dist', 'index.js');

  let buildOk = false;
  logger.info('Building agent-runner');
  try {
    execSync('npm run build', {
      cwd: agentRunnerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Agent-runner build succeeded');
  } catch (err) {
    logger.error({ err }, 'Agent-runner build failed');
  }

  const verifyOk = buildOk && fs.existsSync(distEntry);

  const status = verifyOk ? 'success' : 'failed';

  emitStatus('SETUP_AGENT_RUNNER', {
    BUILD_OK: buildOk,
    VERIFY_OK: verifyOk,
    STATUS: status,
    DIST: distEntry,
  });

  if (status === 'failed') process.exit(1);
}

