import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  MOUNT_ALLOWLIST_PATH,
  PROJECT_CONFIG_DIR,
  PROJECT_ROOT,
  SENDER_ALLOWLIST_PATH,
} from './config.js';

describe('project-local config paths', () => {
  it('stores allowlist files under the project config directory', () => {
    expect(PROJECT_CONFIG_DIR).toBe(path.join(PROJECT_ROOT, 'config'));
    expect(MOUNT_ALLOWLIST_PATH).toBe(
      path.join(PROJECT_CONFIG_DIR, 'mount-allowlist.json'),
    );
    expect(SENDER_ALLOWLIST_PATH).toBe(
      path.join(PROJECT_CONFIG_DIR, 'sender-allowlist.json'),
    );
  });
});
