import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface RemoteControlSession {
  sessionId: string;
  sharePath: string;
  resumeCommand: string;
  handoffMessage: string;
  cwd: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let activeSession: RemoteControlSession | null = null;

const URL_TIMEOUT_MS = 30_000;
const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');
const REMOTE_PROMPT = [
  'Prepare a NanoClaw maintenance handoff for a local operator.',
  'Summarize the current repository context and next likely debugging steps in under 120 words.',
  'Do not ask questions.',
].join(' ');

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(session));
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}

/**
 * Restore session from disk on startup.
 * If the process is still alive, adopt it. Otherwise, clean up.
 */
export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch {
    return;
  }

  try {
    const session: RemoteControlSession = JSON.parse(data);
    if (session.sessionId && session.resumeCommand) {
      activeSession = session;
      logger.info(
        { sessionId: session.sessionId, sharePath: session.sharePath },
        'Restored Copilot handoff session from previous run',
      );
    } else {
      clearState();
    }
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  activeSession = null;
}

/** @internal — exported for testing only */
export function _getStateFilePath(): string {
  return STATE_FILE;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    return { ok: true, url: activeSession.handoffMessage };
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sessionId = randomUUID();
  const sharePath = path.join(DATA_DIR, `remote-control-${sessionId}.md`);
  const resumeCommand = `cd ${quoteShellArg(cwd)} && copilot --resume=${sessionId}`;

  const result = spawnSync(
    'copilot',
    [
      '-p',
      REMOTE_PROMPT,
      `--resume=${sessionId}`,
      `--share=${sharePath}`,
      '--allow-all',
      '--add-dir',
      cwd,
      '--no-auto-update',
      '--stream',
      'off',
      '--silent',
    ],
    {
      cwd,
      encoding: 'utf-8',
      timeout: URL_TIMEOUT_MS,
    },
  );

  if (result.error) {
    return {
      ok: false,
      error: `Failed to start Copilot handoff: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    const details =
      (result.stderr || result.stdout || '').trim() ||
      `exit code ${result.status ?? 'unknown'}`;
    return { ok: false, error: `Copilot handoff failed: ${details}` };
  }

  const handoffMessage = [
    'Copilot handoff ready.',
    `Resume locally: ${resumeCommand}`,
    `Session note: ${sharePath}`,
  ].join('\n');

  const session: RemoteControlSession = {
    sessionId,
    sharePath,
    resumeCommand,
    handoffMessage,
    cwd,
    startedBy: sender,
    startedInChat: chatJid,
    startedAt: new Date().toISOString(),
  };
  activeSession = session;
  saveState(session);

  logger.info(
    { sessionId, sharePath, sender, chatJid },
    'Copilot handoff session started',
  );
  return { ok: true, url: handoffMessage };
}

export function stopRemoteControl():
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  if (!activeSession) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  const { sessionId, sharePath } = activeSession;
  try {
    fs.unlinkSync(sharePath);
  } catch {
    // ignore
  }
  activeSession = null;
  clearState();
  logger.info({ sessionId }, 'Copilot handoff session cleared');
  return { ok: true };
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
