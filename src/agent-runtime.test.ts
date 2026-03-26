import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => {
  const mockReadEnvFile = vi.fn(() => ({}));
  const mockExistsSync = vi.fn((target: string) => {
    if (target.endsWith('/node_modules/.bin/copilot')) return true;
    if (target === '/tmp/nanoclaw-project') return true;
    return false;
  });

  let closeRequested = false;
  let sessionId = 'session-123';
  let sessionMessages: unknown[] = [];
  const generalHandlers = new Set<(event: unknown) => void>();
  const namedHandlers = new Map<string, Set<(event?: any) => void>>();

  const fakeSession = {
    get sessionId() {
      return sessionId;
    },
    on: vi.fn(
      (
        eventOrHandler: string | ((event: unknown) => void),
        handler?: (event?: any) => void,
      ) => {
        if (typeof eventOrHandler === 'function') {
          generalHandlers.add(eventOrHandler);
          return () => generalHandlers.delete(eventOrHandler);
        }

        const handlers = namedHandlers.get(eventOrHandler) ?? new Set();
        handlers.add(handler!);
        namedHandlers.set(eventOrHandler, handlers);
        return () => handlers.delete(handler!);
      },
    ),
    send: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => sessionMessages),
  };

  class FakeCopilotClient {
    static instances: FakeCopilotClient[] = [];

    options: Record<string, any>;
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    createSession = vi.fn(async () => fakeSession);
    resumeSession = vi.fn(async () => fakeSession);

    constructor(options: Record<string, any>) {
      this.options = options;
      FakeCopilotClient.instances.push(this);
    }
  }

  return {
    FakeCopilotClient,
    mockReadEnvFile,
    mockExistsSync,
    reset: () => {
      closeRequested = false;
      sessionId = 'session-123';
      sessionMessages = [];
      generalHandlers.clear();
      namedHandlers.clear();
      fakeSession.on.mockClear();
      fakeSession.send.mockClear();
      fakeSession.disconnect.mockClear();
      fakeSession.getMessages.mockClear();
      FakeCopilotClient.instances.length = 0;
      mockReadEnvFile.mockReset();
      mockReadEnvFile.mockReturnValue({});
      mockExistsSync.mockReset();
      mockExistsSync.mockImplementation((target: string) => {
        if (target.endsWith('/node_modules/.bin/copilot')) return true;
        if (target === '/tmp/nanoclaw-project') return true;
        if (target.endsWith('_close')) return closeRequested;
        return false;
      });
    },
    emitAssistantMessage: (content: string) => {
      for (const handler of generalHandlers) {
        handler({
          type: 'assistant.message',
          data: { content, parentToolCallId: undefined },
        });
      }
    },
    emitIdle: () => {
      const handlers = namedHandlers.get('session.idle');
      if (!handlers) return;
      for (const handler of handlers) handler();
    },
    setCloseRequested: (value: boolean) => {
      closeRequested = value;
    },
  };
});

vi.mock('@github/copilot-sdk', () => ({
  approveAll: vi.fn(),
  CopilotClient: runtime.FakeCopilotClient,
}));

vi.mock('./config.js', () => ({
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  PROJECT_ROOT: '/tmp/nanoclaw-project',
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: runtime.mockReadEnvFile,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: [string]) => runtime.mockExistsSync(...args),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

import fs from 'fs';
import { runAgentRuntime, type AgentRuntimeInput } from './agent-runtime.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput: AgentRuntimeInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

async function flushStartup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('runAgentRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runtime.reset();
    delete process.env.GITHUB_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.NANOCLAW_COPILOT_GITHUB_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats idle timeout after streamed output as success', async () => {
    const onOutput = vi.fn(async () => {});

    const resultPromise = runAgentRuntime(testGroup, testInput, () => {}, onOutput);
    await flushStartup();

    runtime.emitAssistantMessage('Here is my response');
    runtime.emitIdle();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1830000);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('returns error when the session times out without output', async () => {
    const onOutput = vi.fn(async () => {});

    const resultPromise = runAgentRuntime(testGroup, testInput, () => {}, onOutput);
    await flushStartup();

    await vi.advanceTimersByTimeAsync(1830000);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('returns once the close sentinel is observed after a query', async () => {
    const resultPromise = runAgentRuntime(testGroup, testInput, () => {}, undefined);
    await flushStartup();

    runtime.emitAssistantMessage('Done');
    runtime.emitIdle();
    runtime.setCloseRequested(true);
    await vi.advanceTimersByTimeAsync(500);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
  });

  it('sanitizes Copilot token env vars but keeps Anthropic credentials', async () => {
    process.env.GITHUB_TOKEN = 'host-token';
    runtime.mockReadEnvFile.mockReturnValue({
      ANTHROPIC_API_KEY: 'anthropic-key',
      COPILOT_GITHUB_TOKEN: 'copilot-token',
    });

    const resultPromise = runAgentRuntime(testGroup, testInput, () => {}, undefined);
    await flushStartup();
    runtime.emitIdle();
    runtime.setCloseRequested(true);
    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;

    const client = runtime.FakeCopilotClient.instances[0];
    expect(client).toBeDefined();
    expect(client.options.env).toMatchObject({
      ANTHROPIC_API_KEY: 'anthropic-key',
    });
    expect(client.options.env.GITHUB_TOKEN).toBeUndefined();
    expect(client.options.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(client.options.env.NANOCLAW_COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(client.options.cliPath).toContain('/node_modules/.bin/copilot');
  });

  it('registers runtime metadata for the active agent', async () => {
    const onProcess = vi.fn();

    const resultPromise = runAgentRuntime(testGroup, testInput, onProcess, undefined);
    await flushStartup();
    runtime.emitIdle();
    runtime.setCloseRequested(true);
    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;

    expect(onProcess).toHaveBeenCalledWith(
      expect.stringContaining('nanoclaw-test-group-'),
      'test-group',
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
  });
});
