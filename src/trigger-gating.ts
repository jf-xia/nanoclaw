import { TRIGGER_PATTERN } from './config.js';
import {
  isTriggerAllowed,
  type SenderAllowlistConfig,
} from './sender-allowlist.js';
import type { NewMessage, RegisteredGroup } from './types.js';

export function requiresMessageTrigger(
  group: Pick<RegisteredGroup, 'isMain' | 'requiresTrigger'>,
): boolean {
  return group.isMain !== true && group.requiresTrigger !== false;
}

export function hasAllowedTrigger(
  messages: Pick<NewMessage, 'content' | 'sender' | 'is_from_me'>[],
  chatJid: string,
  allowlistCfg: SenderAllowlistConfig,
): boolean {
  return messages.some(
    (message) =>
      TRIGGER_PATTERN.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
  );
}

export function shouldProcessTriggeredMessages(
  group: Pick<RegisteredGroup, 'isMain' | 'requiresTrigger'>,
  messages: Pick<NewMessage, 'content' | 'sender' | 'is_from_me'>[],
  chatJid: string,
  allowlistCfg: SenderAllowlistConfig,
): boolean {
  if (!requiresMessageTrigger(group)) {
    return true;
  }

  return hasAllowedTrigger(messages, chatJid, allowlistCfg);
}