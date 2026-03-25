/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted across the lifetime of a resumed session.
 *   Final marker after each idle period updates the tracked session id.
 */

import fs from 'fs';
import path from 'path';
import {
  approveAll,
  CopilotClient,
  type CopilotSession,
  type SessionConfig,
  type SessionEvent,
} from '@github/copilot-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Workspace paths — configurable via env vars for direct (non-container) execution.
// Defaults retain the original container paths for backwards compatibility.
// todo4fix: /workspace/ should be ./workspace/, and check that all file operations work correctly in direct execution mode.
const WORKSPACE_IPC_DIR = process.env.NANOCLAW_IPC_DIR || './workspace/ipc';
const WORKSPACE_SESSION_DIR = process.env.NANOCLAW_SESSION_DIR || './workspace/session';
const WORKSPACE_GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || './workspace/group';
const WORKSPACE_GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || './workspace/global';
const WORKSPACE_PROJECT_DIR = process.env.NANOCLAW_PROJECT_DIR || './workspace/project';
const WORKSPACE_EXTRA_DIR = process.env.NANOCLAW_EXTRA_DIR || './workspace/extra';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const SESSION_CONFIG_DIR = WORKSPACE_SESSION_DIR;
const GROUP_CLAUDE_MD_PATH = path.join(WORKSPACE_GROUP_DIR, 'CLAUDE.md');
const GLOBAL_CLAUDE_MD_PATH = path.join(WORKSPACE_GLOBAL_DIR, 'CLAUDE.md');
const PROJECT_CLAUDE_MD_PATH = path.join(WORKSPACE_PROJECT_DIR, 'CLAUDE.md');

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }

    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function summarizeMessages(messages: ParsedMessage[]): string {
  const firstUserMessage = messages.find(message => message.role === 'user');
  if (!firstUserMessage) return generateFallbackName();

  const summary = firstUserMessage.content
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  return summary || generateFallbackName();
}

function parseSessionMessages(events: SessionEvent[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const event of events) {
    if (event.type === 'user.message') {
      const content = event.data.content.trim();
      if (content) messages.push({ role: 'user', content });
      continue;
    }

    if (event.type === 'assistant.message') {
      if (event.data.parentToolCallId) continue;
      const content = event.data.content.trim();
      if (content) messages.push({ role: 'assistant', content });
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (date: Date) => date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    const sender = message.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = message.content.length > 2000
      ? `${message.content.slice(0, 2000)}...`
      : message.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function archiveConversation(session: CopilotSession, assistantName?: string): Promise<void> {
  try {
    const events = await session.getMessages();
    const messages = parseSessionMessages(events);

    if (messages.length === 0) {
      log('No session messages to archive');
      return;
    }

    const summary = summarizeMessages(messages);
    const name = sanitizeFilename(summary) || generateFallbackName();
  const conversationsDir = path.join(WORKSPACE_GROUP_DIR, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);
    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);

    fs.writeFileSync(filePath, markdown);
    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function findMountedExtraDirectories(): string[] {
  const extraDirs: string[] = [];
  const extraBase = WORKSPACE_EXTRA_DIR;

  if (!fs.existsSync(extraBase)) return extraDirs;

  for (const entry of fs.readdirSync(extraBase)) {
    const fullPath = path.join(extraBase, entry);
    try {
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    } catch {
      // Ignore transient mount issues.
    }
  }

  return extraDirs;
}

function loadClaudeMarkdownContext(containerInput: ContainerInput, extraDirs: string[]): string | undefined {
  const contextSections: string[] = [];
  const candidatePaths = [GROUP_CLAUDE_MD_PATH];

  if (containerInput.isMain) {
    candidatePaths.push(PROJECT_CLAUDE_MD_PATH);
  } else {
    candidatePaths.push(GLOBAL_CLAUDE_MD_PATH);
  }

  for (const dir of extraDirs) {
    candidatePaths.push(path.join(dir, 'CLAUDE.md'));
  }

  const uniquePaths = [...new Set(candidatePaths)];
  for (const candidatePath of uniquePaths) {
    if (!fs.existsSync(candidatePath)) continue;
    const content = fs.readFileSync(candidatePath, 'utf-8').trim();
    if (!content) continue;
    contextSections.push(`# Context from ${candidatePath}`);
    contextSections.push('');
    contextSections.push(content);
    contextSections.push('');
  }

  return contextSections.length > 0 ? contextSections.join('\n') : undefined;
}

function buildCliArgs(containerInput: ContainerInput, extraDirs: string[]): string[] {
  const args = ['--no-auto-update'];
  const readableDirs = new Set<string>(extraDirs);

  if (containerInput.isMain && fs.existsSync(WORKSPACE_PROJECT_DIR)) {
    readableDirs.add(WORKSPACE_PROJECT_DIR);
  }
  if (!containerInput.isMain && fs.existsSync(WORKSPACE_GLOBAL_DIR)) {
    readableDirs.add(WORKSPACE_GLOBAL_DIR);
  }

  for (const dir of readableDirs) {
    args.push('--add-dir', dir);
  }

  return args;
}

type SessionProviderConfig = NonNullable<SessionConfig['provider']>;

function resolveProviderConfig(sdkEnv: Record<string, string | undefined>): SessionProviderConfig | undefined {
  const baseUrl = sdkEnv.ANTHROPIC_BASE_URL;
  const apiKey = sdkEnv.ANTHROPIC_API_KEY;
  const bearerToken = sdkEnv.ANTHROPIC_AUTH_TOKEN || sdkEnv.CLAUDE_CODE_OAUTH_TOKEN;

  if (!baseUrl && !apiKey && !bearerToken) {
    return undefined;
  }

  return {
    type: 'anthropic',
    baseUrl: baseUrl || 'https://api.anthropic.com',
    apiKey,
    bearerToken,
  };
}

function resolveModel(sdkEnv: Record<string, string | undefined>, provider: SessionProviderConfig | undefined): string | undefined {
  return sdkEnv.NANOCLAW_MODEL
    || sdkEnv.COPILOT_MODEL
    || sdkEnv.ANTHROPIC_MODEL
    || (provider ? 'claude-sonnet-4.5' : undefined);
}

function buildSessionConfig(
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  mcpServerPath: string,
  extraDirs: string[],
): SessionConfig {
  const provider = resolveProviderConfig(sdkEnv);
  const model = resolveModel(sdkEnv, provider);
  const systemMessage = loadClaudeMarkdownContext(containerInput, extraDirs);

  return {
    clientName: 'nanoclaw-agent-runner',
    configDir: SESSION_CONFIG_DIR,
    workingDirectory: WORKSPACE_GROUP_DIR,
    model,
    provider,
    streaming: true,
    onPermissionRequest: approveAll,
    infiniteSessions: { enabled: true },
    systemMessage: systemMessage ? { content: systemMessage } : undefined,
    mcpServers: {
      nanoclaw: {
        type: 'stdio',
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: WORKSPACE_IPC_DIR,
        },
        tools: ['*'],
      },
    },
  };
}

function describeEvent(event: SessionEvent): string {
  switch (event.type) {
    case 'session.start':
      return `session.start id=${event.data.sessionId}`;
    case 'session.resume':
      return `session.resume events=${event.data.eventCount}`;
    case 'assistant.message':
      return `assistant.message chars=${event.data.content.length}`;
    case 'assistant.message_delta':
      return `assistant.message_delta chars=${event.data.deltaContent.length}`;
    case 'tool.execution_start':
      return `tool.execution_start name=${event.data.toolName}`;
    case 'tool.execution_complete':
      return `tool.execution_complete success=${event.data.success}`;
    case 'session.compaction_start':
      return 'session.compaction_start';
    case 'session.compaction_complete':
      return 'session.compaction_complete';
    case 'session.idle':
      return 'session.idle';
    case 'session.error':
      return `session.error type=${event.data.errorType} message=${event.data.message}`;
    default:
      return event.type;
  }
}

function attachSessionHandlers(
  session: CopilotSession,
  assistantName: string | undefined,
  archivedCompactions: Set<string>,
): () => void {
  return session.on((event) => {
    log(`[event] ${describeEvent(event)}`);

    if (event.type === 'assistant.message' && !event.data.parentToolCallId) {
      const result = event.data.content.trim();
      if (result) {
        writeOutput({
          status: 'success',
          result,
          newSessionId: session.sessionId,
        });
      }
      return;
    }

    if (event.type === 'session.compaction_complete' && !archivedCompactions.has(event.id)) {
      archivedCompactions.add(event.id);
      void archiveConversation(session, assistantName);
    }
  });
}

async function createSession(
  client: CopilotClient,
  sessionId: string | undefined,
  config: SessionConfig,
): Promise<CopilotSession> {
  if (sessionId) {
    log(`Resuming Copilot session ${sessionId}`);
    try {
      return await client.resumeSession(sessionId, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Session may have expired or been evicted — start fresh instead of failing
      if (msg.includes('Session not found') || msg.includes('No authentication')) {
        log(`Session resume failed (${msg}), starting new session`);
      } else {
        throw err;
      }
    }
  }

  log('Creating new Copilot session');
  return client.createSession(config);
}

async function runQuery(session: CopilotSession, prompt: string): Promise<{ closedDuringQuery: boolean }> {
  let closedDuringQuery = false;
  let ipcTimer: NodeJS.Timeout | undefined;
  let ipcPolling = true;

  const cleanupFns: Array<() => void> = [];
  const done = new Promise<void>((resolve, reject) => {
    cleanupFns.push(session.on('session.idle', () => resolve()));
    cleanupFns.push(session.on('session.error', (event) => reject(new Error(event.data.message))));
  });

  const pollIpcDuringQuery = async () => {
    if (!ipcPolling) return;

    if (shouldClose()) {
      log('Close sentinel detected during active Copilot query');
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }

    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Queueing IPC message into active Copilot session (${text.length} chars)`);
      await session.send({ prompt: text, mode: 'enqueue' });
    }

    ipcTimer = setTimeout(() => { void pollIpcDuringQuery(); }, IPC_POLL_MS);
  };

  try {
    await session.send({ prompt, mode: 'immediate' });
    ipcTimer = setTimeout(() => { void pollIpcDuringQuery(); }, IPC_POLL_MS);
    await done;
  } finally {
    ipcPolling = false;
    if (ipcTimer) clearTimeout(ipcTimer);
    for (const cleanup of cleanupFns) cleanup();
  }

  return { closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const extraDirs = findMountedExtraDirectories();
  const sessionConfig = buildSessionConfig(containerInput, sdkEnv, mcpServerPath, extraDirs);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  fs.mkdirSync(SESSION_CONFIG_DIR, { recursive: true });

  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += `\n${pending.join('\n')}`;
  }

  const client = new CopilotClient({
    cwd: WORKSPACE_GROUP_DIR,
    env: sdkEnv,
    cliArgs: buildCliArgs(containerInput, extraDirs),
    logLevel: 'warning',
    useLoggedInUser: false,
    ...(sdkEnv.GITHUB_TOKEN ? { githubToken: sdkEnv.GITHUB_TOKEN } : {}),
  });

  const archivedCompactions = new Set<string>();
  let session: CopilotSession | undefined;

  try {
    await client.start();
    session = await createSession(client, containerInput.sessionId, sessionConfig);
    const detachSessionHandlers = attachSessionHandlers(
      session,
      containerInput.assistantName,
      archivedCompactions,
    );

    try {
      while (true) {
        log(`Starting Copilot query (session: ${session.sessionId})...`);
        const queryResult = await runQuery(session, prompt);

        if (queryResult.closedDuringQuery) {
          log('Close sentinel consumed during query, exiting');
          break;
        }

        writeOutput({
          status: 'success',
          result: null,
          newSessionId: session.sessionId,
        });

        log('Query ended, waiting for next IPC message...');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received, exiting');
          break;
        }

        log(`Got new message (${nextMessage.length} chars), starting new query`);
        prompt = nextMessage;
      }
    } finally {
      detachSessionHandlers();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session?.sessionId ?? containerInput.sessionId,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    if (session) {
      try {
        await session.disconnect();
      } catch (err) {
        log(`Failed to disconnect session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      await client.stop();
    } catch (err) {
      log(`Failed to stop Copilot client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main();
