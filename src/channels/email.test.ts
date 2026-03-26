import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RegisteredGroup } from '../types.js';

const envRef = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const parsedMailRef = vi.hoisted(
  () => new Map<string, Record<string, unknown>>(),
);
const transportRef = vi.hoisted(() => ({
  current: {
    verify: vi.fn().mockResolvedValue(undefined),
    sendMail: vi.fn().mockResolvedValue({ messageId: '<sent-1@example.com>' }),
  },
}));
const imapBehaviorRef = vi.hoisted(() => ({
  status: vi.fn<() => Promise<{ uidNext: number }>>(async () => ({ uidNext: 1 })),
  search: vi.fn<() => Promise<number[] | false>>(async () => []),
  fetchOne: vi.fn<() => Promise<Record<string, unknown> | false>>(async () => false),
  messageFlagsAdd: vi.fn<() => Promise<boolean>>(async () => true),
  release: vi.fn(),
}));

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => envRef.current),
}));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('mailparser', () => ({
  simpleParser: vi.fn(async (source: Buffer) => {
    return parsedMailRef.get(source.toString()) || {};
  }),
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => transportRef.current),
  },
}));
vi.mock('imapflow', () => ({
  ImapFlow: class MockImapFlow {
    usable = false;
    on = vi.fn();
    connect = vi.fn(async () => {
      this.usable = true;
    });
    logout = vi.fn(async () => {
      this.usable = false;
    });
    close = vi.fn();
    getMailboxLock = vi.fn(async () => ({ release: imapBehaviorRef.release }));
    status = imapBehaviorRef.status;
    search = imapBehaviorRef.search;
    fetchOne = imapBehaviorRef.fetchOne;
    messageFlagsAdd = imapBehaviorRef.messageFlagsAdd;
  },
}));

import { EmailChannel, EmailChannelOpts } from './email.js';

function createOpts(overrides?: Partial<EmailChannelOpts>): EmailChannelOpts {
  const groups: Record<string, RegisteredGroup> = {
    'email:alice@example.com': {
      name: 'Alice',
      folder: 'alice',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
    },
  };

  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => groups),
    registerGroup: vi.fn((jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
    }),
    ...overrides,
  };
}

function createConfig() {
  return {
    imap: {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: {
        user: 'bot@example.com',
        pass: 'secret',
      },
    },
    smtp: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: {
        user: 'bot@example.com',
        pass: 'secret',
      },
    },
  };
}

describe('EmailChannel', () => {
  beforeEach(() => {
    parsedMailRef.clear();
    transportRef.current.verify.mockClear();
    transportRef.current.verify.mockResolvedValue(undefined);
    transportRef.current.sendMail.mockClear();
    transportRef.current.sendMail.mockResolvedValue({
      messageId: '<sent-1@example.com>',
    });
    imapBehaviorRef.search.mockResolvedValue([]);
    imapBehaviorRef.status.mockResolvedValue({ uidNext: 1 });
    imapBehaviorRef.status.mockClear();
    imapBehaviorRef.search.mockClear();
    imapBehaviorRef.fetchOne.mockResolvedValue(false);
    imapBehaviorRef.fetchOne.mockClear();
    imapBehaviorRef.messageFlagsAdd.mockResolvedValue(true);
    imapBehaviorRef.messageFlagsAdd.mockClear();
    imapBehaviorRef.release.mockClear();
    envRef.current = {
      IMAP_HOST: 'imap.example.com',
      IMAP_PORT: '993',
      IMAP_USER: 'bot@example.com',
      IMAP_PASS: 'secret',
      IMAP_TLS: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'bot@example.com',
      SMTP_PASS: 'secret',
    };
  });

  it('polls unread email and delivers messages for registered chats', async () => {
    const opts = createOpts();
    const channel = new EmailChannel(createConfig(), opts);

    imapBehaviorRef.search.mockResolvedValue([101]);
    imapBehaviorRef.status.mockResolvedValue({ uidNext: 102 });
    imapBehaviorRef.fetchOne.mockResolvedValue({
      uid: 101,
      source: Buffer.from('message-101'),
      internalDate: new Date('2024-01-01T00:00:00.000Z'),
    });
    parsedMailRef.set('message-101', {
      from: {
        value: [{ address: 'alice@example.com', name: 'Alice' }],
      },
      replyTo: {
        value: [{ address: 'reply@example.com', name: 'Reply' }],
      },
      subject: 'Question',
      text: 'Hello from email',
      attachments: [{ filename: 'invoice.pdf' }],
      messageId: '<m1@example.com>',
      references: ['<r0@example.com>'],
      date: new Date('2024-01-01T00:00:00.000Z'),
    });

    await channel.connect();

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'email:alice@example.com',
      '2024-01-01T00:00:00.000Z',
      'Alice',
      'email',
      false,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'email:alice@example.com',
      expect.objectContaining({
        id: '<m1@example.com>',
        sender: 'alice@example.com',
        sender_name: 'Alice',
        content:
          '[Subject] Question\n[Attachments] invoice.pdf\n\nHello from email',
      }),
    );
    expect(imapBehaviorRef.messageFlagsAdd).toHaveBeenCalledWith(
      101,
      ['\\Seen'],
      { uid: true },
    );

    await channel.disconnect();
  });

  it('auto-registers unregistered email chats and delivers the first message', async () => {
    const groups: Record<string, RegisteredGroup> = {};
    const opts = createOpts({
      registeredGroups: vi.fn(() => groups),
      registerGroup: vi.fn((jid: string, group: RegisteredGroup) => {
        groups[jid] = group;
      }),
    });
    const channel = new EmailChannel(createConfig(), opts);

    imapBehaviorRef.search.mockResolvedValue([202]);
    imapBehaviorRef.status.mockResolvedValue({ uidNext: 203 });
    imapBehaviorRef.fetchOne.mockResolvedValue({
      uid: 202,
      source: Buffer.from('message-202'),
      internalDate: new Date('2024-01-02T00:00:00.000Z'),
    });
    parsedMailRef.set('message-202', {
      from: {
        value: [{ address: 'bob@example.com', name: 'Bob' }],
      },
      attachments: [],
      subject: 'FYI',
      text: 'Not registered',
      messageId: '<m2@example.com>',
    });

    await channel.connect();

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'email:bob@example.com',
      expect.any(String),
      'Bob',
      'email',
      false,
    );
    expect(opts.registerGroup).toHaveBeenCalledWith(
      'email:bob@example.com',
      expect.objectContaining({
        name: 'Bob',
        trigger: '@Andy',
        requiresTrigger: false,
      }),
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'email:bob@example.com',
      expect.objectContaining({
        id: '<m2@example.com>',
        sender: 'bob@example.com',
        sender_name: 'Bob',
        content: '[Subject] FYI\n\nNot registered',
      }),
    );

    await channel.disconnect();
  });

  it('sends replies over SMTP using thread metadata from the inbound email', async () => {
    const opts = createOpts();
    const channel = new EmailChannel(createConfig(), opts);

    imapBehaviorRef.search.mockResolvedValue([303]);
    imapBehaviorRef.status.mockResolvedValue({ uidNext: 304 });
    imapBehaviorRef.fetchOne.mockResolvedValue({
      uid: 303,
      source: Buffer.from('message-303'),
      internalDate: new Date('2024-01-03T00:00:00.000Z'),
    });
    parsedMailRef.set('message-303', {
      from: {
        value: [{ address: 'alice@example.com', name: 'Alice' }],
      },
      replyTo: {
        value: [{ address: 'reply@example.com', name: 'Reply' }],
      },
      attachments: [],
      subject: 'Project update',
      text: 'Can you reply?',
      messageId: '<m3@example.com>',
      references: ['<r1@example.com>'],
    });

    await channel.connect();
    await channel.sendMessage('email:alice@example.com', 'Sure thing.');

    expect(transportRef.current.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'bot@example.com',
        to: 'reply@example.com',
        subject: 'Re: Project update',
        text: 'Sure thing.',
        inReplyTo: '<m3@example.com>',
        references: ['<r1@example.com>', '<m3@example.com>'],
      }),
    );

    await channel.disconnect();
  });

  it('owns email JIDs and reports connection state', async () => {
    const channel = new EmailChannel(createConfig(), createOpts());

    expect(channel.ownsJid('email:alice@example.com')).toBe(true);
    expect(channel.isConnected()).toBe(false);

    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('processes newly arrived messages even when they are already marked seen', async () => {
    const groups: Record<string, RegisteredGroup> = {};
    const opts = createOpts({
      registeredGroups: vi.fn(() => groups),
      registerGroup: vi.fn((jid: string, group: RegisteredGroup) => {
        groups[jid] = group;
      }),
    });
    const channel = new EmailChannel(createConfig(), opts);

    imapBehaviorRef.status
      .mockResolvedValueOnce({ uidNext: 404 })
      .mockResolvedValueOnce({ uidNext: 405 });
    imapBehaviorRef.search.mockResolvedValue([]);
    imapBehaviorRef.fetchOne.mockResolvedValue({
      uid: 404,
      source: Buffer.from('message-404'),
      internalDate: new Date('2024-01-04T00:00:00.000Z'),
    });
    parsedMailRef.set('message-404', {
      from: {
        value: [{ address: 'eve@example.com', name: 'Eve' }],
      },
      attachments: [],
      subject: 'Seen already',
      text: 'Still should be processed',
      messageId: '<m4@example.com>',
      date: new Date('2024-01-04T00:00:00.000Z'),
    });

    await channel.connect();
    await (channel as unknown as { pollInbox: () => Promise<void> }).pollInbox();

    expect(opts.registerGroup).toHaveBeenCalledWith(
      'email:eve@example.com',
      expect.objectContaining({
        name: 'Eve',
        trigger: '@Andy',
        requiresTrigger: false,
      }),
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'email:eve@example.com',
      expect.objectContaining({
        id: '<m4@example.com>',
        sender: 'eve@example.com',
        content: '[Subject] Seen already\n\nStill should be processed',
      }),
    );
    expect(imapBehaviorRef.messageFlagsAdd).toHaveBeenCalledWith(
      404,
      ['\\Seen'],
      { uid: true },
    );

    await channel.disconnect();
  });
});
