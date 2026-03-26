import nodemailer from 'nodemailer';

import { readEnvFile } from '../src/env.js';

interface CliOptions {
  to?: string;
  subject?: string;
  text?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (!next) continue;

    switch (arg) {
      case '--to':
        options.to = next;
        index += 1;
        break;
      case '--subject':
        options.subject = next;
        index += 1;
        break;
      case '--text':
        options.text = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
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

async function main(): Promise<void> {
  const envVars = readEnvFile([
    'IMAP_USER',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
  ]);
  const options = parseArgs(process.argv.slice(2));

  const smtpHost = process.env.SMTP_HOST || envVars.SMTP_HOST || '';
  const smtpUser = process.env.SMTP_USER || envVars.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || envVars.SMTP_PASS || '';
  const to = options.to || process.env.IMAP_USER || envVars.IMAP_USER || '';

  if (!smtpHost || !smtpUser || !smtpPass || !to) {
    throw new Error(
      'Missing SMTP_HOST, SMTP_USER, SMTP_PASS, or IMAP_USER/--to for send-test-email.ts',
    );
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parsePort(process.env.SMTP_PORT || envVars.SMTP_PORT, 465),
    secure: parseBoolean(
      process.env.SMTP_SECURE || envVars.SMTP_SECURE,
      true,
    ),
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  await transporter.verify();

  const info = await transporter.sendMail({
    from: smtpUser,
    to,
    subject:
      options.subject ||
      `NanoClaw email channel test ${new Date().toISOString()}`,
    text:
      options.text ||
      'This is a test message sent by scripts/send-test-email.ts.',
    headers: {
      'X-NanoClaw-Test': 'email-channel',
    },
  });

  console.log(
    JSON.stringify(
      {
        to,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
