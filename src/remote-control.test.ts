import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-rc-test',
}));

const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: (...args: any[]) => spawnSyncMock(...args),
}));

import {
  startRemoteControl,
  stopRemoteControl,
  restoreRemoteControl,
  getActiveSession,
  _resetForTesting,
  _getStateFilePath,
} from './remote-control.js';

describe('remote-control', () => {
  const STATE_FILE = _getStateFilePath();
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetForTesting();
    spawnSyncMock.mockReset();

    mkdirSyncSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined as any);
    writeFileSyncSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {});
    unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      filePath: string,
    ) => {
      if (filePath.endsWith('remote-control.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return '';
    }) as any);
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  describe('startRemoteControl', () => {
    it('creates a copilot handoff session and returns resume instructions', async () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });

      const result = await startRemoteControl('user1', 'tg:123', '/project');

      expect(result.ok).toBe(true);
      expect(result).toEqual({
        ok: true,
        url: expect.stringContaining('Copilot handoff ready.'),
      });
      expect(spawnSyncMock).toHaveBeenCalledWith(
        'copilot',
        expect.arrayContaining([
          '-p',
          expect.any(String),
          expect.stringMatching(/^--resume=/),
          expect.stringMatching(/^--share=\/tmp\/nanoclaw-rc-test\/remote-control-/),
          '--allow-all',
          '--add-dir',
          '/project',
          '--no-auto-update',
          '--stream',
          'off',
          '--silent',
        ]),
        expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
      );
      expect(mkdirSyncSpy).toHaveBeenCalled();
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        STATE_FILE,
        expect.stringContaining('"startedBy":"user1"'),
      );
    });

    it('returns existing handoff message if a session is already active', async () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });

      const first = await startRemoteControl('user1', 'tg:123', '/project');
      const second = await startRemoteControl('user2', 'tg:456', '/project');

      expect(second).toEqual(first);
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    });

    it('returns error if copilot fails to launch', async () => {
      spawnSyncMock.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'login required',
      });

      const result = await startRemoteControl('user1', 'tg:123', '/project');

      expect(result).toEqual({
        ok: false,
        error: 'Copilot handoff failed: login required',
      });
    });

    it('returns error if spawnSync reports a launch error', async () => {
      spawnSyncMock.mockReturnValue({
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('ENOENT'),
      });

      const result = await startRemoteControl('user1', 'tg:123', '/project');

      expect(result).toEqual({
        ok: false,
        error: 'Failed to start Copilot handoff: ENOENT',
      });
    });
  });

  describe('stopRemoteControl', () => {
    it('clears session state and deletes the share file', async () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
      await startRemoteControl('user1', 'tg:123', '/project');

      const result = stopRemoteControl();

      expect(result).toEqual({ ok: true });
      expect(unlinkSyncSpy).toHaveBeenCalled();
      expect(getActiveSession()).toBeNull();
    });

    it('returns error when no session is active', () => {
      expect(stopRemoteControl()).toEqual({
        ok: false,
        error: 'No active Remote Control session',
      });
    });
  });

  describe('restoreRemoteControl', () => {
    it('restores saved handoff session state', () => {
      const session = {
        sessionId: 'session-1',
        sharePath: '/tmp/nanoclaw-rc-test/remote-control-session-1.md',
        resumeCommand: "cd '/project' && copilot --resume=session-1",
        handoffMessage: 'Copilot handoff ready.',
        cwd: '/project',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };

      readFileSyncSpy.mockImplementation((((filePath: string) => {
        if (filePath.endsWith('remote-control.json')) {
          return JSON.stringify(session);
        }
        return '';
      })) as any);

      restoreRemoteControl();

      expect(getActiveSession()).toEqual(session);
    });

    it('clears corrupted state', () => {
      readFileSyncSpy.mockImplementation((((filePath: string) => {
        if (filePath.endsWith('remote-control.json')) {
          return 'not json';
        }
        return '';
      })) as any);

      restoreRemoteControl();

      expect(getActiveSession()).toBeNull();
      expect(unlinkSyncSpy).toHaveBeenCalledWith(STATE_FILE);
    });

    it('returns the restored handoff without spawning a new session', async () => {
      const session = {
        sessionId: 'session-1',
        sharePath: '/tmp/nanoclaw-rc-test/remote-control-session-1.md',
        resumeCommand: "cd '/project' && copilot --resume=session-1",
        handoffMessage: 'Copilot handoff ready.',
        cwd: '/project',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };

      readFileSyncSpy.mockImplementation((((filePath: string) => {
        if (filePath.endsWith('remote-control.json')) {
          return JSON.stringify(session);
        }
        return '';
      })) as any);

      restoreRemoteControl();
      const result = await startRemoteControl('user2', 'tg:456', '/project');

      expect(result).toEqual({ ok: true, url: 'Copilot handoff ready.' });
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });
});
