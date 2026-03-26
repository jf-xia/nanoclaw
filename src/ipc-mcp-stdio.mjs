import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || './workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

const chatJid = process.env.NANOCLAW_CHAT_JID;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

if (!chatJid || !groupFolder) {
  throw new Error('NANOCLAW_CHAT_JID and NANOCLAW_GROUP_FOLDER are required');
}

function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Optional role/identity name.'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text', text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  'Schedule a recurring or one-time task. Returns the task ID for later updates.',
  {
    prompt: z.string().describe('Task prompt.'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_group_jid: z.string().optional(),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text', text: `Invalid cron: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (Number.isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text', text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (
      /[Zz]$/.test(args.schedule_value) ||
      /[+-]\d{2}:\d{2}$/.test(args.schedule_value) ||
      Number.isNaN(new Date(args.schedule_value).getTime())
    ) {
      return {
        content: [{ type: 'text', text: `Invalid local timestamp: "${args.schedule_value}".` }],
        isError: true,
      };
    }

    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text',
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool('list_tasks', 'List scheduled tasks visible to this group.', {}, async () => {
  const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
  try {
    if (!fs.existsSync(tasksFile)) {
      return { content: [{ type: 'text', text: 'No scheduled tasks found.' }] };
    }

    const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = isMain
      ? allTasks
      : allTasks.filter((task) => task.groupFolder === groupFolder);
    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: 'No scheduled tasks found.' }] };
    }

    const formatted = tasks
      .map(
        (task) =>
          `- [${task.id}] ${task.prompt.slice(0, 50)}... (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run || 'N/A'}`,
      )
      .join('
');
    return { content: [{ type: 'text', text: `Scheduled tasks:
${formatted}` }] };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

for (const [toolName, description, type, action] of [
  ['pause_task', 'Pause a scheduled task.', 'pause_task', 'pause'],
  ['resume_task', 'Resume a paused task.', 'resume_task', 'resume'],
  ['cancel_task', 'Cancel and delete a scheduled task.', 'cancel_task', 'cancel'],
]) {
  server.tool(
    toolName,
    description,
    { task_id: z.string().describe('The task ID') },
    async (args) => {
      writeIpcFile(TASKS_DIR, {
        type,
        taskId: args.task_id,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text', text: `Task ${args.task_id} ${action} requested.` }],
      };
    },
  );
}

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed.',
  {
    task_id: z.string(),
    prompt: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
    schedule_value: z.string().optional(),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.schedule_type !== undefined ? { schedule_type: args.schedule_type } : {}),
      ...(args.schedule_value !== undefined ? { schedule_value: args.schedule_value } : {}),
    });
    return { content: [{ type: 'text', text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  'Register a new chat/group so the agent can respond there. Main group only.',
  {
    jid: z.string(),
    name: z.string(),
    folder: z.string(),
    trigger: z.string(),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text', text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text', text: `Group "${args.name}" registered.` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
