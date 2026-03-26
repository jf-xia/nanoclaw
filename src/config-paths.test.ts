import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOUNT_ALLOWLIST,
  DEFAULT_SENDER_ALLOWLIST,
} from './config.js';

describe('embedded security config defaults', () => {
  it('defines an in-code mount allowlist', () => {
    expect(DEFAULT_MOUNT_ALLOWLIST.allowedRoots).toEqual([
      {
        path: '~/works',
        allowReadWrite: true,
        description: 'Development works',
      },
    ]);
    expect(DEFAULT_MOUNT_ALLOWLIST.blockedPatterns).toEqual([
      'password',
      'secret',
      'token',
    ]);
    expect(DEFAULT_MOUNT_ALLOWLIST.nonMainReadOnly).toBe(true);
  });

  it('defines an in-code sender allowlist', () => {
    expect(DEFAULT_SENDER_ALLOWLIST.default).toEqual({
      allow: '*',
      mode: 'trigger',
    });
    expect(DEFAULT_SENDER_ALLOWLIST.chats['group-a@g.us']).toEqual({
      allow: ['alice'],
      mode: 'drop',
    });
    expect(DEFAULT_SENDER_ALLOWLIST.logDenied).toBe(true);
  });
});
