import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
const mockExistsSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
    },
  };
});

import { ensureAgentRunnerReady, getAgentRunnerPath } from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAgentRunnerPath', () => {
  it('returns path to dist/index.js under container/agent-runner', () => {
    const result = getAgentRunnerPath();
    expect(result).toContain(path.join('container', 'agent-runner', 'dist', 'index.js'));
  });
});

describe('ensureAgentRunnerReady', () => {
  it('does nothing when dist/index.js exists', () => {
    mockExistsSync.mockReturnValue(true);

    ensureAgentRunnerReady();

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunnerPath: expect.any(String) }),
      'Agent runner ready',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('throws when dist/index.js does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => ensureAgentRunnerReady()).toThrow('Agent runner is not compiled');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunnerPath: expect.any(String) }),
      'Agent runner not compiled',
    );
  });
});
