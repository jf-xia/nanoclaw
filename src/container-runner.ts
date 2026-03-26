import fs from 'fs';
import path from 'path';
import { approveAll, CopilotClient } from '@github/copilot-sdk';
import type { CopilotSession, SessionConfig, SessionEvent } from '@github/copilot-sdk';

import {
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  PROJECT_ROOT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  renderGlobalAgentInstructions,
  renderMainAgentInstructions,
} from './runtime-assets/agents.js';
import { RUNTIME_SKILLS } from './runtime-assets/skills.js';
import { RegisteredGroup } from './types.js';

const IPC_POLL_MS = 500;
const INSTRUCTION_FILENAMES = ['AGENTS.md'];
const COPILOT_CLI_BINARY = process.platform === 'win32' ? 'copilot.cmd' : 'copilot';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentContext {
  agentId: string;
  groupDir: string;
  groupIpcDir: string;
  groupSessionsDir: string;
  globalDir: string;
  inputDir: string;
  logsDir: string;
  skillsDst: string;
}

interface TimeoutController {
  abort: (message?: string) => void;
  reset: () => void;
  signal: AbortSignal;
}

interface QueryResult {
  closedDuringQuery: boolean;
}

type SessionProviderConfig = NonNullable<SessionConfig['provider']>;

function createAgentContext(group: RegisteredGroup): AgentContext {
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  return {
    agentId: `nanoclaw-${group.folder.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`,
    groupDir,
    groupIpcDir,
    groupSessionsDir: path.join(DATA_DIR, 'sessions', group.folder, '.copilot'),
    globalDir: path.join(GROUPS_DIR, 'global'),
    inputDir: path.join(groupIpcDir, 'input'),
    logsDir: path.join(groupDir, 'logs'),
    skillsDst: path.join(DATA_DIR, 'sessions', group.folder, '.copilot', 'skills'),
  };
}

function ensureRuntimeDirs(context: AgentContext): void {
  fs.mkdirSync(context.groupDir, { recursive: true });
  fs.mkdirSync(path.join(context.groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(context.groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(context.inputDir, { recursive: true });
  fs.mkdirSync(context.groupSessionsDir, { recursive: true });
  fs.mkdirSync(context.logsDir, { recursive: true });
  fs.mkdirSync(context.skillsDst, { recursive: true });
}

function syncRuntimeSkills(context: AgentContext): void {
  for (const [skillName, skillContent] of Object.entries(RUNTIME_SKILLS)) {
    const skillDir = path.join(context.skillsDst, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${skillContent.trim()}\n`);
  }
}

function buildSdkEnv(
  context: AgentContext,
  isMain: boolean,
): Record<string, string | undefined> {
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    TZ: TIMEZONE,
    NANOCLAW_IPC_DIR: context.groupIpcDir,
    NANOCLAW_SESSION_DIR: context.groupSessionsDir,
    NANOCLAW_GROUP_DIR: context.groupDir,
  };

  delete sdkEnv.GITHUB_TOKEN;
  delete sdkEnv.NANOCLAW_COPILOT_GITHUB_TOKEN;
  delete sdkEnv.COPILOT_GITHUB_TOKEN;

  if (!isMain && fs.existsSync(context.globalDir)) {
    sdkEnv.NANOCLAW_GLOBAL_DIR = context.globalDir;
  }
  if (isMain) {
    sdkEnv.NANOCLAW_PROJECT_DIR = PROJECT_ROOT;
  }

  const envSecrets = readEnvFile(['ANTHROPIC_API_KEY']);
  if (!sdkEnv.ANTHROPIC_API_KEY && envSecrets.ANTHROPIC_API_KEY) {
    sdkEnv.ANTHROPIC_API_KEY = envSecrets.ANTHROPIC_API_KEY;
  }

  return sdkEnv;
}

function shouldClose(inputDir: string): boolean {
  const closeSentinelPath = path.join(inputDir, '_close');
  if (!fs.existsSync(closeSentinelPath)) return false;
  try {
    fs.unlinkSync(closeSentinelPath);
  } catch (err) {
    logger.warn({ closeSentinelPath, err }, 'Failed to remove close sentinel');
  }
  return true;
}

function drainIpcInput(inputDir: string): string[] {
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const files = fs
      .readdirSync(inputDir)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(inputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          text?: string;
          type?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        logger.warn({ filePath, err }, 'Failed to process agent IPC input file');
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          logger.warn(
            { filePath, err: unlinkErr },
            'Failed to clean up invalid agent IPC input file',
          );
        }
      }
    }

    return messages;
  } catch (err) {
    logger.warn({ inputDir, err }, 'Failed to drain agent IPC input');
    return [];
  }
}

function waitForIpcMessage(
  inputDir: string,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (pollTimer) clearTimeout(pollTimer);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'Agent aborted')),
      );
    };

    const poll = () => {
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (shouldClose(inputDir)) {
        cleanup();
        resolve(null);
        return;
      }
      const messages = drainIpcInput(inputDir);
      if (messages.length > 0) {
        cleanup();
        resolve(messages.join('\n'));
        return;
      }
      pollTimer = setTimeout(poll, IPC_POLL_MS);
    };

    signal.addEventListener('abort', onAbort, { once: true });
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
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

function summarizeMessages(messages: ParsedMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  if (!firstUserMessage) return generateFallbackName();

  const summary = firstUserMessage.content.replace(/\s+/g, ' ').trim().slice(0, 60);
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

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (date: Date) =>
    date.toLocaleString('en-US', {
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
    const content =
      message.content.length > 2000
        ? `${message.content.slice(0, 2000)}...`
        : message.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function archiveConversation(
  session: CopilotSession,
  groupDir: string,
  assistantName?: string,
): Promise<void> {
  try {
    const events = await session.getMessages();
    const messages = parseSessionMessages(events);
    if (messages.length === 0) return;

    const summary = summarizeMessages(messages);
    const name = sanitizeFilename(summary) || generateFallbackName();
    const conversationsDir = path.join(groupDir, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(conversationsDir, `${timestamp}-${name}.md`);
    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
    fs.writeFileSync(filePath, markdown);
  } catch (err) {
    logger.warn({ err, groupDir }, 'Failed to archive Copilot conversation');
  }
}

function findMountedExtraDirectories(): string[] {
  const extraDirs: string[] = [];
  const extraBase = process.env.NANOCLAW_EXTRA_DIR;
  if (!extraBase || !fs.existsSync(extraBase)) return extraDirs;

  for (const entry of fs.readdirSync(extraBase)) {
    const fullPath = path.join(extraBase, entry);
    try {
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    } catch (err) {
      logger.warn({ fullPath, err }, 'Failed to stat extra runtime directory');
    }
  }

  return extraDirs;
}

function instructionPathsFor(dir: string): string[] {
  return INSTRUCTION_FILENAMES.map((filename) => path.join(dir, filename));
}

function loadAgentInstructions(
  input: ContainerInput,
  context: AgentContext,
  extraDirs: string[],
): string | undefined {
  const contextSections: string[] = [];
  const candidatePaths = instructionPathsFor(context.groupDir);

  contextSections.push('# Built-in Instructions');
  contextSections.push('');
  contextSections.push(
    input.isMain
      ? renderMainAgentInstructions(input.assistantName || 'Assistant')
      : renderGlobalAgentInstructions(input.assistantName || 'Assistant'),
  );
  contextSections.push('');

  if (input.isMain) {
    candidatePaths.push(...instructionPathsFor(PROJECT_ROOT));
  } else if (fs.existsSync(context.globalDir)) {
    candidatePaths.push(...instructionPathsFor(context.globalDir));
  }

  for (const dir of extraDirs) {
    candidatePaths.push(...instructionPathsFor(dir));
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

function buildCliArgs(
  input: ContainerInput,
  context: AgentContext,
  extraDirs: string[],
): string[] {
  const args = ['--no-auto-update'];
  const readableDirs = new Set<string>(extraDirs);

  if (input.isMain && fs.existsSync(PROJECT_ROOT)) {
    readableDirs.add(PROJECT_ROOT);
  }
  if (!input.isMain && fs.existsSync(context.globalDir)) {
    readableDirs.add(context.globalDir);
  }

  for (const dir of readableDirs) {
    args.push('--add-dir', dir);
  }

  return args;
}

function resolveCopilotCliPath(): string {
  const cliPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', COPILOT_CLI_BINARY);
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Bundled Copilot CLI not found at ${cliPath}`);
  }
  return cliPath;
}

function buildCopilotCliEnv(
  sdkEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const cliEnv = { ...sdkEnv };
  delete cliEnv.GITHUB_TOKEN;
  delete cliEnv.COPILOT_GITHUB_TOKEN;
  delete cliEnv.NANOCLAW_COPILOT_GITHUB_TOKEN;

  return {
    ...cliEnv,
  };
}

function resolveProviderConfig(
  sdkEnv: Record<string, string | undefined>,
): SessionProviderConfig | undefined {
  const baseUrl = sdkEnv.ANTHROPIC_BASE_URL;
  const apiKey = sdkEnv.ANTHROPIC_API_KEY;
  const bearerToken = sdkEnv.ANTHROPIC_AUTH_TOKEN;

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

function resolveModel(sdkEnv: Record<string, string | undefined>): string | undefined {
  return (
    sdkEnv.NANOCLAW_MODEL ||
    sdkEnv.COPILOT_MODEL ||
    sdkEnv.GITHUB_MODEL ||
    sdkEnv.ANTHROPIC_MODEL ||
    undefined
  );
}

function buildSessionConfig(
  input: ContainerInput,
  context: AgentContext,
  sdkEnv: Record<string, string | undefined>,
  mcpServerPath: string,
  extraDirs: string[],
): SessionConfig {
  const provider = resolveProviderConfig(sdkEnv);
  const model = resolveModel(sdkEnv);
  const systemMessage = loadAgentInstructions(input, context, extraDirs);

  return {
    clientName: 'nanoclaw-agent-runner',
    configDir: context.groupSessionsDir,
    workingDirectory: context.groupDir,
    model,
    provider,
    streaming: true,
    onPermissionRequest: approveAll,
    infiniteSessions: { enabled: true },
    systemMessage: systemMessage ? { content: systemMessage } : undefined,
    mcpServers: {
      nanoclaw: {
        type: 'stdio',
        command: process.execPath,
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: input.chatJid,
          NANOCLAW_GROUP_FOLDER: input.groupFolder,
          NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: context.groupIpcDir,
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
  context: AgentContext,
  assistantName: string | undefined,
  archivedCompactions: Set<string>,
  emitOutput: (output: ContainerOutput) => void,
): () => void {
  return session.on((event) => {
    logger.debug({ agentId: context.agentId, event: describeEvent(event) }, 'Copilot event');

    if (event.type === 'assistant.message' && !event.data.parentToolCallId) {
      const result = event.data.content.trim();
      if (result) {
        emitOutput({
          status: 'success',
          result,
          newSessionId: session.sessionId,
        });
      }
      return;
    }

    if (
      event.type === 'session.compaction_complete' &&
      !archivedCompactions.has(event.id)
    ) {
      archivedCompactions.add(event.id);
      void archiveConversation(session, context.groupDir, assistantName);
    }
  });
}

async function createSession(
  client: CopilotClient,
  sessionId: string | undefined,
  config: SessionConfig,
): Promise<CopilotSession> {
  if (sessionId) {
    logger.info({ sessionId }, 'Resuming Copilot session');
    try {
      return await client.resumeSession(sessionId, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('Session not found') ||
        message.includes('No authentication')
      ) {
        logger.warn({ sessionId, message }, 'Session resume failed, creating fresh session');
      } else {
        throw err;
      }
    }
  }

  logger.info('Creating new Copilot session');
  return client.createSession(config);
}

function createTimeoutController(timeoutMs: number): TimeoutController {
  const controller = new AbortController();
  let timeout = setTimeout(() => {
    controller.abort(new Error(`Agent timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    reset: () => {
      if (controller.signal.aborted) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        controller.abort(new Error(`Agent timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    },
    abort: (message?: string) => {
      if (controller.signal.aborted) return;
      clearTimeout(timeout);
      controller.abort(new Error(message || `Agent timed out after ${timeoutMs}ms`));
    },
  };
}

async function runQuery(
  session: CopilotSession,
  prompt: string,
  inputDir: string,
  signal: AbortSignal,
): Promise<QueryResult> {
  let closedDuringQuery = false;
  let ipcTimer: ReturnType<typeof setTimeout> | undefined;
  let ipcPolling = true;

  const cleanupFns: Array<() => void> = [];
  const done = new Promise<void>((resolve, reject) => {
    cleanupFns.push(session.on('session.idle', () => resolve()));
    cleanupFns.push(
      session.on('session.error', (event) => reject(new Error(event.data.message))),
    );
  });

  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'Agent aborted')),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const pollIpcDuringQuery = async () => {
    if (!ipcPolling || signal.aborted) return;

    if (shouldClose(inputDir)) {
      logger.debug('Close sentinel detected during active Copilot query');
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }

    const messages = drainIpcInput(inputDir);
    for (const text of messages) {
      logger.debug({ chars: text.length }, 'Queueing IPC message into active Copilot session');
      await session.send({ prompt: text, mode: 'enqueue' });
    }

    ipcTimer = setTimeout(() => {
      void pollIpcDuringQuery();
    }, IPC_POLL_MS);
  };

  try {
    await session.send({ prompt, mode: 'immediate' });
    ipcTimer = setTimeout(() => {
      void pollIpcDuringQuery();
    }, IPC_POLL_MS);
    await Promise.race([done, abortPromise]);
  } finally {
    ipcPolling = false;
    if (ipcTimer) clearTimeout(ipcTimer);
    for (const cleanup of cleanupFns) cleanup();
  }

  return { closedDuringQuery };
}

function buildInitialPrompt(input: ContainerInput, inputDir: string): string {
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput(inputDir);
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  return prompt;
}

function writeRunLog(
  context: AgentContext,
  group: RegisteredGroup,
  input: ContainerInput,
  status: 'success' | 'error',
  durationMs: number,
  error?: string,
): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(context.logsDir, `agent-${timestamp}.log`);
  const lines = [
    '=== Agent Run Log ===',
    `Timestamp: ${new Date().toISOString()}`,
    `Group: ${group.name}`,
    `AgentId: ${context.agentId}`,
    `IsMain: ${input.isMain}`,
    `Duration: ${durationMs}ms`,
    `Status: ${status}`,
    `Session ID: ${input.sessionId || 'new'}`,
    `Prompt length: ${input.prompt.length} chars`,
  ];

  if (error) {
    lines.push('', '=== Error ===', error);
  }

  fs.writeFileSync(logFile, lines.join('\n'));
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (agentId: string, groupFolder: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const context = createAgentContext(group);
  ensureRuntimeDirs(context);
  syncRuntimeSkills(context);

  const sdkEnv = buildSdkEnv(context, input.isMain);
  const cliPath = resolveCopilotCliPath();
  const mcpServerPath = path.join(PROJECT_ROOT, 'src', 'ipc-mcp-stdio.mjs');
  const extraDirs = findMountedExtraDirectories();
  const sessionConfig = buildSessionConfig(
    input,
    context,
    sdkEnv,
    mcpServerPath,
    extraDirs,
  );
  const client = new CopilotClient({
    cwd: context.groupDir,
    cliPath,
    env: buildCopilotCliEnv(sdkEnv),
    cliArgs: buildCliArgs(input, context, extraDirs),
    logLevel: 'warning',
    useLoggedInUser: true,
  });

  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
  const timeoutController = createTimeoutController(timeoutMs);
  const archivedCompactions = new Set<string>();

  let session: CopilotSession | undefined;
  let latestOutput: ContainerOutput = {
    status: 'success',
    result: null,
    newSessionId: input.sessionId,
  };
  let hadStreamingOutput = false;
  let outputChain = Promise.resolve();

  const queueOutput = (output: ContainerOutput) => {
    latestOutput = output;
    if (output.result) {
      hadStreamingOutput = true;
    }
    timeoutController.reset();
    if (onOutput) {
      outputChain = outputChain.then(() => onOutput(output));
    }
  };

  logger.info(
    {
      group: group.name,
      agentId: context.agentId,
      isMain: input.isMain,
    },
    'Starting in-process agent',
  );
  onProcess(context.agentId, group.folder);
  timeoutController.reset();

  try {
    await client.start();
    session = await createSession(client, input.sessionId, sessionConfig);
    const detachSessionHandlers = attachSessionHandlers(
      session,
      context,
      input.assistantName,
      archivedCompactions,
      queueOutput,
    );

    try {
      let prompt = buildInitialPrompt(input, context.inputDir);

      while (true) {
        const queryResult = await runQuery(
          session,
          prompt,
          context.inputDir,
          timeoutController.signal,
        );

        if (queryResult.closedDuringQuery) {
          break;
        }

        queueOutput({
          status: 'success',
          result: null,
          newSessionId: session.sessionId,
        });

        const nextMessage = await waitForIpcMessage(
          context.inputDir,
          timeoutController.signal,
        );
        if (nextMessage === null) {
          break;
        }
        prompt = nextMessage;
      }
    } finally {
      detachSessionHandlers();
    }

    await outputChain;
    writeRunLog(context, group, input, 'success', Date.now() - startTime);
    return latestOutput;
  } catch (err) {
    await outputChain;
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (timeoutController.signal.aborted && hadStreamingOutput) {
      logger.info(
        { group: group.name, agentId: context.agentId },
        'Agent timed out after emitting output; treating as idle cleanup',
      );
      writeRunLog(context, group, input, 'success', Date.now() - startTime);
      return {
        status: 'success',
        result: null,
        newSessionId: session?.sessionId ?? latestOutput.newSessionId,
      };
    }

    const errorOutput: ContainerOutput = {
      status: 'error',
      result: null,
      newSessionId: session?.sessionId ?? latestOutput.newSessionId,
      error: errorMessage,
    };
    if (onOutput) {
      await onOutput(errorOutput);
    }
    writeRunLog(
      context,
      group,
      input,
      'error',
      Date.now() - startTime,
      errorMessage,
    );
    return errorOutput;
  } finally {
    timeoutController.abort('Agent finished');
    if (session) {
      try {
        await session.disconnect();
      } catch (err) {
        logger.warn({ err, agentId: context.agentId }, 'Failed to disconnect Copilot session');
      }
    }
    try {
      await client.stop();
    } catch (err) {
      logger.warn({ err, agentId: context.agentId }, 'Failed to stop Copilot client');
    }
  }
}

