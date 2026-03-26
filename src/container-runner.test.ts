import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

const { mockReadEnvFile } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn(() => ({})),
}));

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  getAgentRunnerPath: vi.fn(() => '/fake/agent-runner/dist/index.js'),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

// Mock env.js
vi.mock('./env.js', () => ({
  readEnvFile: mockReadEnvFile,
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.killed = false;
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('agent-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockSpawn.mockClear();
    mockSpawn.mockImplementation(() => fakeProc);
    mockReadEnvFile.mockReset();
    mockReadEnvFile.mockReturnValue({});
    delete process.env.GITHUB_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.NANOCLAW_COPILOT_GITHUB_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if agent was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('spawns node with agent-runner path and sets workspace env vars', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      undefined,
    );

    const spawnCall = mockSpawn.mock.calls.at(0);
    expect(spawnCall).toBeDefined();
    const [cmd, args, opts] = spawnCall as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; cwd: string },
    ];

    // Spawns node directly
    expect(cmd).toBe('node');
    expect(args).toEqual(['/fake/agent-runner/dist/index.js']);

    // Sets workspace env vars
    expect(opts.env).toMatchObject({
      NANOCLAW_IPC_DIR: expect.stringContaining('ipc'),
      NANOCLAW_SESSION_DIR: expect.stringContaining('.copilot'),
      NANOCLAW_GROUP_DIR: expect.any(String),
    });

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
  });

  it('does not forward generic GITHUB_TOKEN into the agent environment', async () => {
    process.env.GITHUB_TOKEN = 'host-token';
    mockReadEnvFile.mockReturnValue({ GITHUB_TOKEN: 'dotenv-token' });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      undefined,
    );

    const spawnCall = mockSpawn.mock.calls.at(0);
    expect(spawnCall).toBeDefined();
    const [, , opts] = spawnCall as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; cwd: string },
    ];

    expect(opts.env.GITHUB_TOKEN).toBeUndefined();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('keeps Anthropic provider credentials but strips dedicated Copilot token envs', async () => {
    mockReadEnvFile.mockReturnValue({
      ANTHROPIC_API_KEY: 'anthropic-key',
      COPILOT_GITHUB_TOKEN: 'copilot-token',
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      undefined,
    );

    const spawnCall = mockSpawn.mock.calls.at(0);
    expect(spawnCall).toBeDefined();
    const [, , opts] = spawnCall as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; cwd: string },
    ];

    expect(opts.env).toMatchObject({
      ANTHROPIC_API_KEY: 'anthropic-key',
    });
    expect(opts.env.NANOCLAW_COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(opts.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(opts.env.GITHUB_TOKEN).toBeUndefined();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
