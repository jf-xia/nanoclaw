import fs from 'fs';

import { DEFAULT_SENDER_ALLOWLIST } from './config.js';
import { logger } from './logger.js';
import type { ChatAllowlistEntry, SenderAllowlistConfig } from './types.js';

export type { ChatAllowlistEntry, SenderAllowlistConfig } from './types.js';

function cloneConfig(config: SenderAllowlistConfig): SenderAllowlistConfig {
  return {
    default:
      config.default.allow === '*'
        ? { allow: '*', mode: config.default.mode }
        : { allow: [...config.default.allow], mode: config.default.mode },
    chats: Object.fromEntries(
      Object.entries(config.chats).map(([jid, entry]) => [
        jid,
        entry.allow === '*'
          ? { allow: '*', mode: entry.mode }
          : { allow: [...entry.allow], mode: entry.mode },
      ]),
    ),
    logDenied: config.logDenied,
  };
}

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  if (!pathOverride) {
    return cloneConfig(DEFAULT_SENDER_ALLOWLIST);
  }

  const filePath = pathOverride;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return cloneConfig(DEFAULT_SENDER_ALLOWLIST);
    }
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return cloneConfig(DEFAULT_SENDER_ALLOWLIST);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return cloneConfig(DEFAULT_SENDER_ALLOWLIST);
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return cloneConfig(DEFAULT_SENDER_ALLOWLIST);
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}
