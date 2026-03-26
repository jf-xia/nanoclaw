import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestStorage, storeChatMetadata } from './storage.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestStorage();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // Channel implementations define ownership rules; core storage treats identifiers as opaque.

  it('email thread ids can be namespaced', () => {
    const jid = 'email:thread-123';
    expect(jid.startsWith('email:')).toBe(true);
  });

  it('custom chat ids can be simple opaque strings', () => {
    const jid = 'group-alpha';
    expect(jid.includes('group')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group-1',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'email',
      true,
    );
    storeChatMetadata(
      'user-1',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'email',
      false,
    );
    storeChatMetadata(
      'group-2',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'email',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group-1');
    expect(groups.map((g) => g.jid)).toContain('group-2');
    expect(groups.map((g) => g.jid)).not.toContain('user-1');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group-1',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'email',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group-1');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg-1',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'email',
      true,
    );
    storeChatMetadata(
      'unreg-1',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'email',
      true,
    );

    _setRegisteredGroups({
      'reg-1': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg-1');
    const unreg = groups.find((g) => g.jid === 'unreg-1');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old-1',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'email',
      true,
    );
    storeChatMetadata(
      'new-1',
      '2024-01-01T00:00:05.000Z',
      'New',
      'email',
      true,
    );
    storeChatMetadata(
      'mid-1',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'email',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new-1');
    expect(groups[1].jid).toBe('mid-1');
    expect(groups[2].jid).toBe('old-1');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group-1',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'email',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group-1');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
