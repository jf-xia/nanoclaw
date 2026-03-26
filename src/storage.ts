import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  _clearInMemoryStateForTests,
  _initInMemoryStateForTests,
  getChatStateValue,
  getRegisteredGroupValue,
  getRouterStateValue,
  getSessionValue,
  readAllChatsState,
  readAllRegisteredGroupsState,
  readAllSessionsState,
  setChatStateValue,
  setRegisteredGroupValue,
  setRouterStateValue,
  setSessionValue,
} from './state-files.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

interface InMemoryJsonStore {
  messages: StoredMessage[];
  scheduledTasks: Record<string, ScheduledTask>;
  taskRunLogs: TaskRunLog[];
}

interface StoredMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
}

const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const SCHEDULED_TASKS_FILE = path.join(DATA_DIR, 'scheduled_tasks.json');
const TASK_RUN_LOGS_FILE = path.join(DATA_DIR, 'task_run_logs.json');

let inMemoryJsonStore: InMemoryJsonStore | null = null;

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn({ err, filePath }, 'Invalid JSON storage file; ignoring contents');
    return undefined;
  }
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return { ...task };
}

function cloneMessage(message: StoredMessage): StoredMessage {
  return { ...message };
}

function cloneTaskRunLog(log: TaskRunLog): TaskRunLog {
  return { ...log };
}

function normalizeStoredMessage(value: unknown): StoredMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const message = value as Partial<StoredMessage>;
  if (
    typeof message.id !== 'string' ||
    typeof message.chat_jid !== 'string' ||
    typeof message.sender !== 'string' ||
    typeof message.sender_name !== 'string' ||
    typeof message.content !== 'string' ||
    typeof message.timestamp !== 'string'
  ) {
    return null;
  }

  return {
    id: message.id,
    chat_jid: message.chat_jid,
    sender: message.sender,
    sender_name: message.sender_name,
    content: message.content,
    timestamp: message.timestamp,
    is_from_me: message.is_from_me === true,
    is_bot_message:
      message.is_bot_message === true ||
      message.content.startsWith(`${ASSISTANT_NAME}:`),
  };
}

function normalizeMessagesStore(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeStoredMessage(entry))
    .filter((entry): entry is StoredMessage => entry !== null);
}

function normalizeScheduledTask(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const task = value as Partial<ScheduledTask>;
  if (
    typeof task.id !== 'string' ||
    typeof task.group_folder !== 'string' ||
    typeof task.chat_jid !== 'string' ||
    typeof task.prompt !== 'string' ||
    (task.schedule_type !== 'cron' &&
      task.schedule_type !== 'interval' &&
      task.schedule_type !== 'once') ||
    typeof task.schedule_value !== 'string' ||
    (task.context_mode !== 'group' && task.context_mode !== 'isolated') ||
    (task.next_run !== null &&
      task.next_run !== undefined &&
      typeof task.next_run !== 'string') ||
    (task.last_run !== null &&
      task.last_run !== undefined &&
      typeof task.last_run !== 'string') ||
    (task.last_result !== null &&
      task.last_result !== undefined &&
      typeof task.last_result !== 'string') ||
    (task.status !== 'active' &&
      task.status !== 'paused' &&
      task.status !== 'completed') ||
    typeof task.created_at !== 'string'
  ) {
    return null;
  }

  return {
    id: task.id,
    group_folder: task.group_folder,
    chat_jid: task.chat_jid,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    context_mode: task.context_mode,
    next_run: task.next_run ?? null,
    last_run: task.last_run ?? null,
    last_result: task.last_result ?? null,
    status: task.status,
    created_at: task.created_at,
  };
}

function normalizeScheduledTasksStore(
  value: unknown,
): Record<string, ScheduledTask> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, ScheduledTask> = {};
  for (const [taskId, taskValue] of Object.entries(value)) {
    const task = normalizeScheduledTask(taskValue);
    if (!task) {
      logger.warn({ taskId }, 'Skipping invalid scheduled task entry');
      continue;
    }
    result[taskId] = task;
  }
  return result;
}

function normalizeTaskRunLog(value: unknown): TaskRunLog | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const log = value as Partial<TaskRunLog>;
  if (
    typeof log.task_id !== 'string' ||
    typeof log.run_at !== 'string' ||
    typeof log.duration_ms !== 'number' ||
    (log.status !== 'success' && log.status !== 'error') ||
    (log.result !== null &&
      log.result !== undefined &&
      typeof log.result !== 'string') ||
    (log.error !== null && log.error !== undefined && typeof log.error !== 'string')
  ) {
    return null;
  }

  return {
    task_id: log.task_id,
    run_at: log.run_at,
    duration_ms: log.duration_ms,
    status: log.status,
    result: log.result ?? null,
    error: log.error ?? null,
  };
}

function normalizeTaskRunLogsStore(value: unknown): TaskRunLog[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeTaskRunLog(entry))
    .filter((entry): entry is TaskRunLog => entry !== null);
}

function ensureJsonStoreFiles(): void {
  if (!inMemoryJsonStore) {
    if (!fs.existsSync(MESSAGES_FILE)) atomicWriteJson(MESSAGES_FILE, []);
    if (!fs.existsSync(SCHEDULED_TASKS_FILE)) {
      atomicWriteJson(SCHEDULED_TASKS_FILE, {});
    }
    if (!fs.existsSync(TASK_RUN_LOGS_FILE)) {
      atomicWriteJson(TASK_RUN_LOGS_FILE, []);
    }
  }
}

function readMessagesStore(): StoredMessage[] {
  if (inMemoryJsonStore) {
    return inMemoryJsonStore.messages.map(cloneMessage);
  }

  return normalizeMessagesStore(readJsonFile(MESSAGES_FILE));
}

function writeMessagesStore(messages: StoredMessage[]): void {
  const normalized = normalizeMessagesStore(messages);

  if (inMemoryJsonStore) {
    inMemoryJsonStore.messages = normalized.map(cloneMessage);
    return;
  }

  atomicWriteJson(MESSAGES_FILE, normalized);
}

function readScheduledTasksStore(): Record<string, ScheduledTask> {
  if (inMemoryJsonStore) {
    return Object.fromEntries(
      Object.entries(inMemoryJsonStore.scheduledTasks).map(([taskId, task]) => [
        taskId,
        cloneTask(task),
      ]),
    );
  }

  return normalizeScheduledTasksStore(readJsonFile(SCHEDULED_TASKS_FILE));
}

function writeScheduledTasksStore(tasks: Record<string, ScheduledTask>): void {
  const normalized = normalizeScheduledTasksStore(
    tasks as unknown as Record<string, unknown>,
  );

  if (inMemoryJsonStore) {
    inMemoryJsonStore.scheduledTasks = Object.fromEntries(
      Object.entries(normalized).map(([taskId, task]) => [taskId, cloneTask(task)]),
    );
    return;
  }

  atomicWriteJson(SCHEDULED_TASKS_FILE, normalized);
}

function readTaskRunLogsStore(): TaskRunLog[] {
  if (inMemoryJsonStore) {
    return inMemoryJsonStore.taskRunLogs.map(cloneTaskRunLog);
  }

  return normalizeTaskRunLogsStore(readJsonFile(TASK_RUN_LOGS_FILE));
}

function writeTaskRunLogsStore(logs: TaskRunLog[]): void {
  const normalized = normalizeTaskRunLogsStore(logs);

  if (inMemoryJsonStore) {
    inMemoryJsonStore.taskRunLogs = normalized.map(cloneTaskRunLog);
    return;
  }

  atomicWriteJson(TASK_RUN_LOGS_FILE, normalized);
}

function filterUserMessages(
  messages: StoredMessage[],
  botPrefix: string,
): NewMessage[] {
  return messages
    .filter(
      (message) =>
        message.content !== '' &&
        !message.is_bot_message &&
        !message.content.startsWith(`${botPrefix}:`),
    )
    .map((message) => ({
      id: message.id,
      chat_jid: message.chat_jid,
      sender: message.sender,
      sender_name: message.sender_name,
      content: message.content,
      timestamp: message.timestamp,
      is_from_me: message.is_from_me,
    }));
}

export function initStorage(): void {
  _clearInMemoryStateForTests();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureJsonStoreFiles();
}

export function _initTestStorage(): void {
  inMemoryJsonStore = {
    messages: [],
    scheduledTasks: {},
    taskRunLogs: [],
  };
  _initInMemoryStateForTests();
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const existing = getChatStateValue(chatJid);
  const nextTimestamp = existing
    ? existing.last_message_time > timestamp
      ? existing.last_message_time
      : timestamp
    : timestamp;

  const nextChat = {
    jid: chatJid,
    name: name || existing?.name || chatJid,
    last_message_time: nextTimestamp,
    channel: channel ?? existing?.channel ?? '',
    is_group:
      isGroup === undefined ? (existing?.is_group ?? 0) : isGroup ? 1 : 0,
  };

  setChatStateValue(chatJid, nextChat);
}

export function updateChatName(chatJid: string, name: string): void {
  const existing = getChatStateValue(chatJid);
  const nextChat = {
    jid: chatJid,
    name,
    last_message_time: existing?.last_message_time || new Date().toISOString(),
    channel: existing?.channel || '',
    is_group: existing?.is_group ?? 0,
  };

  setChatStateValue(chatJid, nextChat);
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export function getAllChats(): ChatInfo[] {
  return Object.values(readAllChatsState()).sort((left, right) =>
    right.last_message_time.localeCompare(left.last_message_time),
  );
}

export function getLastGroupSync(): string | null {
  return getChatStateValue('__group_sync__')?.last_message_time || null;
}

export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  const nextChat = {
    jid: '__group_sync__',
    name: '__group_sync__',
    last_message_time: now,
    channel: '',
    is_group: 0,
  };

  setChatStateValue('__group_sync__', nextChat);
}

export function storeMessage(msg: NewMessage): void {
  const messages = readMessagesStore();
  const nextMessage: StoredMessage = {
    id: msg.id,
    chat_jid: msg.chat_jid,
    sender: msg.sender,
    sender_name: msg.sender_name,
    content: msg.content,
    timestamp: msg.timestamp,
    is_from_me: msg.is_from_me === true,
    is_bot_message:
      msg.is_bot_message === true || msg.content.startsWith(`${ASSISTANT_NAME}:`),
  };

  const existingIndex = messages.findIndex(
    (message) => message.id === msg.id && message.chat_jid === msg.chat_jid,
  );

  if (existingIndex === -1) {
    messages.push(nextMessage);
  } else {
    messages[existingIndex] = nextMessage;
  }

  writeMessagesStore(messages);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) {
    return { messages: [], newTimestamp: lastTimestamp };
  }

  const jidSet = new Set(jids);
  const messages = filterUserMessages(
    readMessagesStore().filter(
      (message) => message.timestamp > lastTimestamp && jidSet.has(message.chat_jid),
    ),
    botPrefix,
  )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  let newTimestamp = lastTimestamp;
  for (const message of messages) {
    if (message.timestamp > newTimestamp) {
      newTimestamp = message.timestamp;
    }
  }

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return filterUserMessages(
    readMessagesStore().filter(
      (message) => message.chat_jid === chatJid && message.timestamp > sinceTimestamp,
    ),
    botPrefix,
  )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  const tasks = readScheduledTasksStore();
  tasks[task.id] = {
    ...task,
    context_mode: task.context_mode || 'isolated',
    last_run: null,
    last_result: null,
  };
  writeScheduledTasksStore(tasks);
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const task = readScheduledTasksStore()[id];
  return task ? cloneTask(task) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return Object.values(readScheduledTasksStore())
    .filter((task) => task.group_folder === groupFolder)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function getAllTasks(): ScheduledTask[] {
  return Object.values(readScheduledTasksStore()).sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  );
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  if (Object.keys(updates).length === 0) {
    return;
  }

  const tasks = readScheduledTasksStore();
  const existing = tasks[id];
  if (!existing) {
    return;
  }

  tasks[id] = {
    ...existing,
    ...updates,
  };
  writeScheduledTasksStore(tasks);
}

export function deleteTask(id: string): void {
  const tasks = readScheduledTasksStore();
  if (!(id in tasks)) {
    return;
  }

  delete tasks[id];
  writeScheduledTasksStore(tasks);

  const logs = readTaskRunLogsStore().filter((log) => log.task_id !== id);
  writeTaskRunLogsStore(logs);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return Object.values(readScheduledTasksStore())
    .filter(
      (task) =>
        task.status === 'active' &&
        task.next_run !== null &&
        task.next_run <= now,
    )
    .sort((left, right) => (left.next_run || '').localeCompare(right.next_run || ''));
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const tasks = readScheduledTasksStore();
  const existing = tasks[id];
  if (!existing) {
    return;
  }

  tasks[id] = {
    ...existing,
    next_run: nextRun,
    last_run: new Date().toISOString(),
    last_result: lastResult,
    status: nextRun === null ? 'completed' : existing.status,
  };
  writeScheduledTasksStore(tasks);
}

export function logTaskRun(log: TaskRunLog): void {
  const logs = readTaskRunLogsStore();
  logs.push({
    task_id: log.task_id,
    run_at: log.run_at,
    duration_ms: log.duration_ms,
    status: log.status,
    result: log.result,
    error: log.error,
  });
  writeTaskRunLogsStore(logs);
}

export function getRouterState(key: string): string | undefined {
  return getRouterStateValue(key);
}

export function setRouterState(key: string, value: string): void {
  setRouterStateValue(key, value);
}

export function getSession(groupFolder: string): string | undefined {
  return getSessionValue(groupFolder);
}

export function setSession(groupFolder: string, sessionId: string): void {
  setSessionValue(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  return readAllSessionsState();
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  return getRegisteredGroupValue(jid);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  setRegisteredGroupValue(jid, group);
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  return readAllRegisteredGroupsState();
}