import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

interface InMemoryStateStore {
  chats: Record<string, JsonChatState>;
  routerState: Record<string, string>;
  sessions: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
}

export interface JsonChatState {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

const CHATS_FILE = 'chats.json';
const ROUTER_STATE_FILE = 'router_state.json';
const SESSIONS_FILE = 'sessions.json';
const REGISTERED_GROUPS_FILE = 'registered_groups.json';

let inMemoryStateStore: InMemoryStateStore | null = null;

function getStateFileCandidates(filename: string): string[] {
  const primary = path.join(DATA_DIR, filename);
  return [primary, `${primary}.migrated`];
}

function hasOnDiskState(filename: string): boolean {
  return getStateFileCandidates(filename).some((filePath) =>
    fs.existsSync(filePath),
  );
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function readJsonObject(filename: string): Record<string, unknown> {
  for (const filePath of getStateFileCandidates(filename)) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      logger.warn({ filePath }, 'Skipping unexpected JSON state file shape');
    } catch (err) {
      logger.warn({ err, filePath }, 'Skipping invalid JSON state file');
    }
  }

  return {};
}

function readStringMap(filename: string): Record<string, string> {
  const parsed = readJsonObject(filename);
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }

  return result;
}

function normalizeChats(raw: Record<string, unknown>): Record<string, JsonChatState> {
  const result: Record<string, JsonChatState> = {};

  for (const [jid, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      logger.warn({ jid }, 'Skipping invalid chat entry');
      continue;
    }

    const chat = value as Partial<JsonChatState>;
    if (
      typeof chat.jid !== 'string' ||
      typeof chat.name !== 'string' ||
      typeof chat.last_message_time !== 'string'
    ) {
      logger.warn({ jid }, 'Skipping incomplete chat entry');
      continue;
    }

    result[jid] = {
      jid: chat.jid,
      name: chat.name,
      last_message_time: chat.last_message_time,
      channel: typeof chat.channel === 'string' ? chat.channel : '',
      is_group:
        typeof chat.is_group === 'number'
          ? chat.is_group
          : chat.is_group
            ? 1
            : 0,
    };
  }

  return result;
}

function normalizeRegisteredGroups(
  raw: Record<string, unknown>,
): Record<string, RegisteredGroup> {
  const result: Record<string, RegisteredGroup> = {};

  for (const [jid, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      logger.warn({ jid }, 'Skipping invalid registered group entry');
      continue;
    }

    const group = value as Partial<RegisteredGroup>;
    if (
      typeof group.name !== 'string' ||
      typeof group.folder !== 'string' ||
      typeof group.trigger !== 'string' ||
      typeof group.added_at !== 'string'
    ) {
      logger.warn({ jid }, 'Skipping incomplete registered group entry');
      continue;
    }

    if (!isValidGroupFolder(group.folder)) {
      logger.warn(
        { jid, folder: group.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }

    result[jid] = {
      name: group.name,
      folder: group.folder,
      trigger: group.trigger,
      added_at: group.added_at,
      containerConfig: group.containerConfig,
      requiresTrigger: group.requiresTrigger,
      isMain: group.isMain,
    };
  }

  return result;
}

export function _initInMemoryStateForTests(): void {
  inMemoryStateStore = {
    chats: {},
    routerState: {},
    sessions: {},
    registeredGroups: {},
  };
}

export function _clearInMemoryStateForTests(): void {
  inMemoryStateStore = null;
}

export function hasRouterStateStore(): boolean {
  return inMemoryStateStore !== null || hasOnDiskState(ROUTER_STATE_FILE);
}

export function hasChatsStore(): boolean {
  return inMemoryStateStore !== null || hasOnDiskState(CHATS_FILE);
}

export function readAllChatsState(): Record<string, JsonChatState> {
  if (inMemoryStateStore) {
    return { ...inMemoryStateStore.chats };
  }
  return normalizeChats(readJsonObject(CHATS_FILE));
}

export function writeAllChatsState(chats: Record<string, JsonChatState>): void {
  const normalized = normalizeChats(chats as unknown as Record<string, unknown>);

  if (inMemoryStateStore) {
    inMemoryStateStore.chats = { ...normalized };
    return;
  }

  atomicWriteJson(path.join(DATA_DIR, CHATS_FILE), normalized);
}

export function getChatStateValue(jid: string): JsonChatState | undefined {
  return readAllChatsState()[jid];
}

export function setChatStateValue(jid: string, chat: JsonChatState): void {
  const chats = readAllChatsState();
  chats[jid] = chat;
  writeAllChatsState(chats);
}

export function readAllRouterState(): Record<string, string> {
  if (inMemoryStateStore) {
    return { ...inMemoryStateStore.routerState };
  }
  return readStringMap(ROUTER_STATE_FILE);
}

export function writeAllRouterState(state: Record<string, string>): void {
  if (inMemoryStateStore) {
    inMemoryStateStore.routerState = { ...state };
    return;
  }
  atomicWriteJson(path.join(DATA_DIR, ROUTER_STATE_FILE), state);
}

export function getRouterStateValue(key: string): string | undefined {
  return readAllRouterState()[key];
}

export function setRouterStateValue(key: string, value: string): void {
  const state = readAllRouterState();
  state[key] = value;
  writeAllRouterState(state);
}

export function hasSessionsStore(): boolean {
  return inMemoryStateStore !== null || hasOnDiskState(SESSIONS_FILE);
}

export function readAllSessionsState(): Record<string, string> {
  if (inMemoryStateStore) {
    return { ...inMemoryStateStore.sessions };
  }
  return readStringMap(SESSIONS_FILE);
}

export function writeAllSessionsState(state: Record<string, string>): void {
  if (inMemoryStateStore) {
    inMemoryStateStore.sessions = { ...state };
    return;
  }
  atomicWriteJson(path.join(DATA_DIR, SESSIONS_FILE), state);
}

export function getSessionValue(groupFolder: string): string | undefined {
  return readAllSessionsState()[groupFolder];
}

export function setSessionValue(groupFolder: string, sessionId: string): void {
  const state = readAllSessionsState();
  state[groupFolder] = sessionId;
  writeAllSessionsState(state);
}

export function hasRegisteredGroupsStore(): boolean {
  return inMemoryStateStore !== null || hasOnDiskState(REGISTERED_GROUPS_FILE);
}

export function readAllRegisteredGroupsState(): Record<string, RegisteredGroup> {
  if (inMemoryStateStore) {
    return { ...inMemoryStateStore.registeredGroups };
  }
  return normalizeRegisteredGroups(readJsonObject(REGISTERED_GROUPS_FILE));
}

export function writeAllRegisteredGroupsState(
  groups: Record<string, RegisteredGroup>,
): void {
  const normalized = normalizeRegisteredGroups(
    groups as unknown as Record<string, unknown>,
  );

  if (inMemoryStateStore) {
    inMemoryStateStore.registeredGroups = { ...normalized };
    return;
  }

  atomicWriteJson(path.join(DATA_DIR, REGISTERED_GROUPS_FILE), normalized);
}

export function getRegisteredGroupValue(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const group = readAllRegisteredGroupsState()[jid];
  return group ? { jid, ...group } : undefined;
}

export function setRegisteredGroupValue(
  jid: string,
  group: RegisteredGroup,
): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }

  const groups = readAllRegisteredGroupsState();
  groups[jid] = group;
  writeAllRegisteredGroupsState(groups);
}