import { ImapFlow, FetchMessageObject } from 'imapflow';
import { ParsedMail, simpleParser } from 'mailparser';
import nodemailer, { Transporter } from 'nodemailer';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_IMAP_TLS = true;
const DEFAULT_SMTP_SECURE = true;
const EMAIL_POLL_INTERVAL_MS = 15000;
const NO_SUBJECT = '(no subject)';

export interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface EmailChannelConfig {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    auth: {
      user: string;
      pass: string;
    };
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth: {
      user: string;
      pass: string;
    };
  };
}

interface EmailThreadState {
  subject: string;
  replyAddress: string;
  inReplyTo?: string;
  references: string[];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return /^(true|1|yes|on)$/i.test(value.trim());
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function addressToJid(address: string): string {
  return `email:${normalizeAddress(address)}`;
}

function jidToAddress(jid: string): string {
  return normalizeAddress(jid.replace(/^email:/, ''));
}

function normalizeSubject(subject: string | undefined): string {
  const trimmed = subject?.trim();
  if (!trimmed) return NO_SUBJECT;
  return trimmed.replace(/^(?:\s*re:\s*)+/i, '').trim() || NO_SUBJECT;
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function firstAddress(parsed: ParsedMail['from']): string | undefined {
  return parsed?.value[0]?.address
    ? normalizeAddress(parsed.value[0].address)
    : undefined;
}

function firstAddressName(parsed: ParsedMail['from']): string | undefined {
  return parsed?.value[0]?.name?.trim() || undefined;
}

function collectReferences(mail: ParsedMail, currentMessageId?: string): string[] {
  const refs = mail.references;
  const values = Array.isArray(refs) ? refs : refs ? [refs] : [];
  if (currentMessageId) values.push(currentMessageId);

  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) unique.add(trimmed);
  }
  return [...unique];
}

function buildInboundContent(mail: ParsedMail): string {
  const subject = normalizeSubject(mail.subject);
  const text = (mail.text || '').trim();
  const lines = [`[Subject] ${subject}`];

  if (mail.attachments.length > 0) {
    const names = mail.attachments.map((attachment) => {
      return attachment.filename?.trim() || attachment.contentType;
    });
    lines.push(`[Attachments] ${names.join(', ')}`);
  }

  if (text) {
    lines.push('', text);
  }

  return lines.join('\n').trim();
}

function loadEmailConfig(): EmailChannelConfig | null {
  const envVars = readEnvFile([
    'IMAP_HOST',
    'IMAP_PORT',
    'IMAP_USER',
    'IMAP_PASS',
    'IMAP_TLS',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
  ]);

  const imapHost = process.env.IMAP_HOST || envVars.IMAP_HOST || '';
  const imapUser = process.env.IMAP_USER || envVars.IMAP_USER || '';
  const imapPass = process.env.IMAP_PASS || envVars.IMAP_PASS || '';
  const smtpHost = process.env.SMTP_HOST || envVars.SMTP_HOST || '';
  const smtpUser = process.env.SMTP_USER || envVars.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || envVars.SMTP_PASS || '';

  if (
    !imapHost ||
    !imapUser ||
    !imapPass ||
    !smtpHost ||
    !smtpUser ||
    !smtpPass
  ) {
    return null;
  }

  return {
    imap: {
      host: imapHost,
      port: parsePort(process.env.IMAP_PORT || envVars.IMAP_PORT, DEFAULT_IMAP_PORT),
      secure: parseBoolean(
        process.env.IMAP_TLS || envVars.IMAP_TLS,
        DEFAULT_IMAP_TLS,
      ),
      auth: {
        user: imapUser,
        pass: imapPass,
      },
    },
    smtp: {
      host: smtpHost,
      port: parsePort(process.env.SMTP_PORT || envVars.SMTP_PORT, DEFAULT_SMTP_PORT),
      secure: parseBoolean(
        process.env.SMTP_SECURE || envVars.SMTP_SECURE,
        DEFAULT_SMTP_SECURE,
      ),
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    },
  };
}

export class EmailChannel implements Channel {
  name = 'email';

  private readonly opts: EmailChannelOpts;
  private readonly config: EmailChannelConfig;
  private readonly threadState = new Map<string, EmailThreadState>();

  private transporter: Transporter | null = null;
  private imapClient: ImapFlow | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(config: EmailChannelConfig, opts: EmailChannelOpts) {
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: this.config.smtp.auth,
    });

    await this.transporter.verify();
    await this.ensureImapConnected();
    await this.pollInbox();

    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.pollInbox().catch((err) => {
          logger.error({ err }, 'Email inbox poll failed');
        });
      }, EMAIL_POLL_INTERVAL_MS);
    }

    this.connected = true;
    logger.info(
      {
        imapHost: this.config.imap.host,
        smtpHost: this.config.smtp.host,
        email: this.config.imap.auth.user,
      },
      'Email channel connected',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.transporter) {
      throw new Error('Email transporter not initialized');
    }

    const fallbackAddress = jidToAddress(jid);
    const thread = this.threadState.get(jid);
    const to = thread?.replyAddress || fallbackAddress;
    const baseSubject = thread?.subject || ASSISTANT_NAME;
    const subject = replySubject(baseSubject);

    const info = await this.transporter.sendMail({
      from: this.config.smtp.auth.user,
      to,
      subject,
      text,
      inReplyTo: thread?.inReplyTo,
      references: thread?.references.length ? thread.references : undefined,
    });

    const references = [...(thread?.references || [])];
    if (thread?.inReplyTo) references.push(thread.inReplyTo);
    if (info.messageId) references.push(info.messageId);

    this.threadState.set(jid, {
      subject: normalizeSubject(baseSubject),
      replyAddress: to,
      inReplyTo: info.messageId || thread?.inReplyTo,
      references: [...new Set(references)],
    });

    logger.info({ jid, to, subject }, 'Email message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.imapClient) {
      try {
        if (this.imapClient.usable) {
          await this.imapClient.logout();
        } else {
          this.imapClient.close();
        }
      } finally {
        this.imapClient = null;
      }
    }

    this.transporter = null;
    logger.info('Email channel disconnected');
  }

  private async ensureImapConnected(): Promise<void> {
    if (this.imapClient?.usable) return;

    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: this.config.imap.auth,
      logger: false,
    });

    client.on('close', () => {
      this.connected = false;
      logger.warn('Email IMAP connection closed');
    });
    client.on('error', (err) => {
      logger.error({ err }, 'Email IMAP client error');
    });

    await client.connect();
    this.imapClient = client;
    this.connected = true;
  }

  private async pollInbox(): Promise<void> {
    if (this.polling) return;

    this.polling = true;
    try {
      await this.ensureImapConnected();
      const client = this.imapClient;
      if (!client) return;

      const lock = await client.getMailboxLock('INBOX');
      try {
        const unseen = await client.search({ seen: false }, { uid: true });
        if (!unseen || unseen.length === 0) return;

        for (const uid of unseen) {
          const message = await client.fetchOne(
            String(uid),
            {
              uid: true,
              source: true,
              envelope: true,
              internalDate: true,
            },
            { uid: true },
          );

          if (!message || !message.source) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }

          const processed = await this.processInboundMessage(message);
          if (processed) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      this.connected = false;
      logger.error({ err }, 'Failed to poll email inbox');
      throw err;
    } finally {
      this.polling = false;
    }
  }

  private async processInboundMessage(
    message: FetchMessageObject,
  ): Promise<boolean> {
    const source = message.source;
    if (!source) return true;

    const mail = await simpleParser(source);
    const senderAddress = firstAddress(mail.from);

    if (!senderAddress) {
      logger.warn({ uid: message.uid }, 'Skipping email without sender address');
      return true;
    }

    const senderName = firstAddressName(mail.from) || senderAddress;
    const replyAddress = firstAddress(mail.replyTo) || senderAddress;
    const chatJid = addressToJid(senderAddress);
    const rawDate = mail.date || message.internalDate || new Date();
    const timestamp =
      rawDate instanceof Date ? rawDate.toISOString() : new Date(rawDate).toISOString();

    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'email', false);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, senderAddress }, 'Message from unregistered email chat');
      return true;
    }

    const messageId = mail.messageId?.trim() || `uid:${message.uid || Date.now()}`;
    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderAddress,
      sender_name: senderName,
      content: buildInboundContent(mail),
      timestamp,
      is_from_me: false,
    });

    this.threadState.set(chatJid, {
      subject: normalizeSubject(mail.subject),
      replyAddress,
      inReplyTo: mail.messageId?.trim(),
      references: collectReferences(mail, mail.messageId?.trim()),
    });

    logger.info({ chatJid, senderAddress, subject: mail.subject }, 'Email message stored');
    return true;
  }
}

registerChannel('email', (opts: ChannelOpts) => {
  const config = loadEmailConfig();
  if (!config) {
    logger.warn('Email: IMAP/SMTP settings not fully configured');
    return null;
  }

  return new EmailChannel(config, opts);
});
