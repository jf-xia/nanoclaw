import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../src/env.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const COPILOT_TLS_ENV_KEYS = [
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_USE_SYSTEM_CA',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;
const LEGACY_COPILOT_TOKEN_ENV_KEYS = [
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'NANOCLAW_COPILOT_GITHUB_TOKEN',
] as const;
const ATTEMPT_TIMEOUT_MS = 20_000;

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface AttemptSpec {
  name: string;
  description: string;
  env: NodeJS.ProcessEnv;
}

interface AttemptResult {
  name: string;
  description: string;
  success: boolean;
  output?: ContainerOutput;
  stderr: string;
}

type LegacyCopilotTokenEnvKey = typeof LEGACY_COPILOT_TOKEN_ENV_KEYS[number];

function envFlag(env: NodeJS.ProcessEnv, key: string): string {
  return env[key] ? 'present' : 'absent';
}

function clearLegacyCopilotTokenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GITHUB_TOKEN: undefined,
    COPILOT_GITHUB_TOKEN: undefined,
    NANOCLAW_COPILOT_GITHUB_TOKEN: undefined,
  };
}

function findLegacyCopilotToken(
  env: NodeJS.ProcessEnv,
): { key: LegacyCopilotTokenEnvKey; value: string } | undefined {
  for (const key of LEGACY_COPILOT_TOKEN_ENV_KEYS) {
    const value = env[key];
    if (value) return { key, value };
  }

  return undefined;
}

function parseLastOutput(stdout: string): ContainerOutput | undefined {
  const start = stdout.lastIndexOf(OUTPUT_START_MARKER);
  const end = stdout.lastIndexOf(OUTPUT_END_MARKER);
  if (start === -1 || end === -1 || end <= start) return undefined;
  const json = stdout
    .slice(start + OUTPUT_START_MARKER.length, end)
    .trim();
  return JSON.parse(json) as ContainerOutput;
}

function runAttempt(
  runnerPath: string,
  attempt: AttemptSpec,
  tempDir: string,
): Promise<AttemptResult> {
  return new Promise((resolve, reject) => {
    const attemptDir = path.join(tempDir, attempt.name);
    const env = {
      ...attempt.env,
      TZ: attempt.env.TZ || 'UTC',
      NANOCLAW_IPC_DIR: path.join(attemptDir, 'ipc'),
      NANOCLAW_SESSION_DIR: path.join(attemptDir, 'session'),
      NANOCLAW_GROUP_DIR: path.join(attemptDir, 'group'),
      NANOCLAW_PROJECT_DIR: process.cwd(),
    };

    fs.mkdirSync(env.NANOCLAW_IPC_DIR, { recursive: true });
    fs.mkdirSync(env.NANOCLAW_SESSION_DIR, { recursive: true });
    fs.mkdirSync(env.NANOCLAW_GROUP_DIR, { recursive: true });

    const child = spawn('node', [runnerPath], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let parseBuffer = '';
    let latestOutput: ContainerOutput | undefined;
    let latestResultOutput: ContainerOutput | undefined;
    let closeSentinelWritten = false;
    let settled = false;
    const finish = (result: AttemptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        name: attempt.name,
        description: attempt.description,
        success: false,
        stderr: `${stderr}\n[diagnose] Timed out after ${ATTEMPT_TIMEOUT_MS}ms`,
        output: {
          status: 'error',
          result: null,
          error: `Timed out after ${ATTEMPT_TIMEOUT_MS}ms`,
        },
      });
    }, ATTEMPT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      parseBuffer += text;
      while (true) {
        const start = parseBuffer.indexOf(OUTPUT_START_MARKER);
        if (start === -1) break;
        const end = parseBuffer.indexOf(OUTPUT_END_MARKER, start);
        if (end === -1) break;
        const json = parseBuffer
          .slice(start + OUTPUT_START_MARKER.length, end)
          .trim();
        parseBuffer = parseBuffer.slice(end + OUTPUT_END_MARKER.length);
        latestOutput = JSON.parse(json) as ContainerOutput;
        if (latestOutput.result || latestOutput.error) {
          latestResultOutput = latestOutput;
        }
        if (!closeSentinelWritten) {
          closeSentinelWritten = true;
          fs.mkdirSync(path.join(env.NANOCLAW_IPC_DIR, 'input'), { recursive: true });
          fs.writeFileSync(path.join(env.NANOCLAW_IPC_DIR, 'input', '_close'), '');
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const output = latestResultOutput || latestOutput || parseLastOutput(stdout);
        finish({
          name: attempt.name,
          description: attempt.description,
          success: code === 0 && output?.status === 'success',
          output,
          stderr,
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.end(JSON.stringify({
      prompt: 'Reply with exactly OK.',
      groupFolder: `diagnose-${attempt.name}`,
      chatJid: 'diagnose@example.com',
      isMain: true,
      assistantName: 'NanoClaw',
    }));
  });
}

async function main(): Promise<void> {
  const runnerPath = path.join(process.cwd(), 'container', 'agent-runner', 'dist', 'index.js');
  if (!fs.existsSync(runnerPath)) {
    throw new Error(
      'Agent runner is not built. Run `cd container/agent-runner && npm run build` first.',
    );
  }

  const envSecrets = readEnvFile([
    'GITHUB_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'NANOCLAW_COPILOT_GITHUB_TOKEN',
    ...COPILOT_TLS_ENV_KEYS,
  ]);

  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(envSecrets)) {
    if (!baseEnv[key]) baseEnv[key] = value;
  }
  const attempts: AttemptSpec[] = [];
  const legacyCopilotToken = findLegacyCopilotToken(baseEnv);

  if (legacyCopilotToken) {
    attempts.push({
      name: 'legacy-token-override',
      description: `Force SDK auth through legacy ${legacyCopilotToken.key} env injection`,
      env: {
        ...clearLegacyCopilotTokenEnv(baseEnv),
        NANOCLAW_COPILOT_GITHUB_TOKEN: legacyCopilotToken.value,
      },
    });
  }

  attempts.push({
    name: 'logged-in-user',
    description: 'Ignore token env overrides and use Copilot CLI logged-in user',
    env: clearLegacyCopilotTokenEnv(baseEnv),
  });

  const tlsSanitizedEnv = clearLegacyCopilotTokenEnv(baseEnv);
  for (const key of COPILOT_TLS_ENV_KEYS) {
    delete tlsSanitizedEnv[key];
  }
  attempts.push({
    name: 'logged-in-user-no-tls-overrides',
    description: 'Use Copilot CLI logged-in user with Node/TLS override vars removed',
    env: tlsSanitizedEnv,
  });

  console.log('Copilot SDK diagnostics');
  for (const key of LEGACY_COPILOT_TOKEN_ENV_KEYS) {
    console.log(`- ${key}: ${envFlag(baseEnv, key)}`);
  }
  for (const key of COPILOT_TLS_ENV_KEYS) {
    console.log(`- ${key}: ${envFlag(baseEnv, key)}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-copilot-diagnose-'));

  try {
    const results: AttemptResult[] = [];
    for (const attempt of attempts) {
      console.log(`\n[${attempt.name}] ${attempt.description}`);
      const result = await runAttempt(runnerPath, attempt, tempDir);
      results.push(result);
      const summary = result.output?.error || result.output?.result || 'No structured output';
      console.log(`status=${result.success ? 'success' : 'failure'}`);
      console.log(`summary=${summary}`);
      if (result.stderr.trim()) {
        console.log(`stderr=${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
      }
    }

    const legacyTokenFailure = results.find((result) =>
      result.name === 'legacy-token-override'
      && result.output?.error?.includes('No model available'));
    const loggedInSuccess = results.find((result) =>
      result.name === 'logged-in-user' && result.success);
    const tlsOnlySuccess = results.find((result) =>
      result.name === 'logged-in-user-no-tls-overrides' && result.success);

    console.log('\nDiagnosis');
    if (legacyTokenFailure && loggedInSuccess) {
      console.log(
        '- Root cause is legacy token env injection. It overrides the logged-in Copilot user but does not have model access.',
      );
    } else if (!loggedInSuccess && tlsOnlySuccess) {
      console.log(
        '- Copilot works only after removing Node/TLS overrides, so the issue is environment-related rather than Copilot policy.',
      );
    } else if (!loggedInSuccess && !tlsOnlySuccess) {
      console.log(
        '- Logged-in Copilot failed in both cases. This points to account/policy/auth state rather than NanoClaw env injection.',
      );
    } else {
      console.log(
        '- Copilot works with the logged-in user configuration. If NanoClaw was failing before, remove legacy Copilot token env overrides and let the SDK use the logged-in user.',
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`diagnose-copilot-sdk: ${message}`);
  process.exit(1);
});
