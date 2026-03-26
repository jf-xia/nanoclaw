import { describe, expect, it, vi } from 'vitest';

vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: vi.fn((groupFolder: string) => `/tmp/ipc/${groupFolder}`),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import fs from 'fs';

import {
  buildTaskSnapshotRows,
  syncAgentSnapshots,
  writeGroupsSnapshot,
} from './agent-snapshots.js';

describe('agent snapshots', () => {
  it('buildTaskSnapshotRows normalizes task fields for container snapshots', () => {
    expect(
      buildTaskSnapshotRows([
        {
          id: 'task-1',
          group_folder: 'alpha',
          chat_jid: 'alpha@g.us',
          prompt: 'Run report',
          schedule_type: 'interval',
          schedule_value: '60000',
          context_mode: 'group',
          next_run: '2026-03-26T00:00:00.000Z',
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: '2026-03-25T00:00:00.000Z',
        },
      ]),
    ).toEqual([
      {
        id: 'task-1',
        groupFolder: 'alpha',
        prompt: 'Run report',
        schedule_type: 'interval',
        schedule_value: '60000',
        status: 'active',
        next_run: '2026-03-26T00:00:00.000Z',
      },
    ]);
  });

  it('syncAgentSnapshots writes filtered task rows and optional group metadata', () => {
    syncAgentSnapshots({
      groupFolder: 'alpha',
      isMain: false,
      tasks: [
        {
          id: 'task-1',
          group_folder: 'alpha',
          chat_jid: 'alpha@g.us',
          prompt: 'Keep me',
          schedule_type: 'once',
          schedule_value: '2026-03-26T00:00:00.000Z',
          context_mode: 'isolated',
          next_run: null,
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: '2026-03-25T00:00:00.000Z',
        },
        {
          id: 'task-2',
          group_folder: 'beta',
          chat_jid: 'beta@g.us',
          prompt: 'Filter me',
          schedule_type: 'once',
          schedule_value: '2026-03-26T01:00:00.000Z',
          context_mode: 'isolated',
          next_run: null,
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: '2026-03-25T01:00:00.000Z',
        },
      ],
      availableGroups: [
        {
          jid: 'alpha@g.us',
          name: 'Alpha',
          lastActivity: '2026-03-26T00:00:00.000Z',
          isRegistered: true,
        },
      ],
    });

    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith('/tmp/ipc/alpha', {
      recursive: true,
    });

    const writes = vi.mocked(fs.writeFileSync).mock.calls.map((call) => ({
      path: call[0],
      content: JSON.parse(String(call[1])),
    }));

    expect(writes).toEqual([
      {
        path: '/tmp/ipc/alpha/current_tasks.json',
        content: [
          {
            id: 'task-1',
            groupFolder: 'alpha',
            prompt: 'Keep me',
            schedule_type: 'once',
            schedule_value: '2026-03-26T00:00:00.000Z',
            status: 'active',
            next_run: null,
          },
        ],
      },
      {
        path: '/tmp/ipc/alpha/available_groups.json',
        content: {
          groups: [],
          lastSync: expect.any(String),
        },
      },
    ]);
  });

  it('writeGroupsSnapshot exposes groups only to main agents', () => {
    writeGroupsSnapshot('main', true, [
      {
        jid: 'group-1',
        name: 'Group 1',
        lastActivity: '2026-03-26T00:00:00.000Z',
        isRegistered: false,
      },
    ]);

    const [, payload] = vi.mocked(fs.writeFileSync).mock.calls.at(-1)!;
    expect(JSON.parse(String(payload))).toMatchObject({
      groups: [
        {
          jid: 'group-1',
          name: 'Group 1',
          lastActivity: '2026-03-26T00:00:00.000Z',
          isRegistered: false,
        },
      ],
    });
  });
});