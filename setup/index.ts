/**
 * Setup CLI entry point.
 * Usage: npx tsx setup/index.ts --step <name> [args...]
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DEFAULT_MOUNT_ALLOWLIST,
  ASSISTANT_NAME,
} from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { logger } from '../src/logger.js';
import {
  renderGlobalAgentInstructions,
  renderMainAgentInstructions,
} from '../src/runtime-assets/agents.js';
import { renderLaunchdPlist } from '../src/runtime-assets/service.js';
import {
  hasRegisteredGroupsStore,
  readAllChatsState,
  readAllRegisteredGroupsState,
  writeAllRegisteredGroupsState,
} from '../src/state-files.js';

type Platform = 'macos' | 'linux' | 'unknown';
type ServiceManager = 'launchd' | 'systemd' | 'none';
type SetupStep = (args: string[]) => Promise<void>;

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
}

const STEPS: Record<string, SetupStep> = {
  environment: runEnvironmentStep,
  container: runContainerStep,
  groups: runGroupsStep,
  register: runRegisterStep,
  mounts: runMountsStep,
  service: runServiceStep,
  verify: runVerifyStep,
};

function listRegisteredGroups(): Array<{
  jid: string;
  group: ReturnType<typeof readAllRegisteredGroupsState>[string];
}> {
  return Object.entries(readAllRegisteredGroupsState())
    .map(([jid, group]) => ({ jid, group }))
    .sort((left, right) =>
      right.group.added_at.localeCompare(left.group.added_at),
    );
}

function hasConfiguredChannel(): boolean {
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
    'IMAP_HOST',
    'IMAP_USER',
    'IMAP_PASS',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
  ]);

  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN ||
      envVars.TELEGRAM_BOT_TOKEN ||
      ((process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN) &&
        (process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN)) ||
      process.env.DISCORD_BOT_TOKEN ||
      envVars.DISCORD_BOT_TOKEN ||
      (((process.env.IMAP_HOST || envVars.IMAP_HOST) &&
        (process.env.IMAP_USER || envVars.IMAP_USER) &&
        (process.env.IMAP_PASS || envVars.IMAP_PASS) &&
        (process.env.SMTP_HOST || envVars.SMTP_HOST) &&
        (process.env.SMTP_USER || envVars.SMTP_USER) &&
        (process.env.SMTP_PASS || envVars.SMTP_PASS))),
  );
}

function emitStatus(
  step: string,
  fields: Record<string, string | number | boolean>,
): void {
  const lines = [`=== NANOCLAW SETUP: ${step} ===`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}

function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

function isHeadless(): boolean {
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  return false;
}

function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    return hasSystemd() ? 'systemd' : 'none';
  }
  return 'none';
}

function getNodePath(): string {
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

function parseRegisterArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'email',
    requiresTrigger: true,
    isMain: false,
    assistantName: 'Andy',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
    }
  }

  return result;
}

function parseGroupArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

function parseMountArgs(args: string[]): { empty: boolean; json: string } {
  let empty = false;
  let json = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--empty') empty = true;
    if (args[i] === '--json' && args[i + 1]) {
      json = args[i + 1];
      i++;
    }
  }
  return { empty, json };
}

async function runEnvironmentStep(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();

  const runtimeEntry = path.join(projectRoot, 'dist', 'index.js');
  const agentRunnerReady = fs.existsSync(runtimeEntry);
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));
  const hasAuth = hasConfiguredChannel();
  const hasRegisteredGroups = hasRegisteredGroupsStore();

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    AGENT_RUNNER_READY: agentRunnerReady,
    BUILD_ENTRY: runtimeEntry,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function runContainerStep(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const distEntry = path.join(projectRoot, 'dist', 'index.js');

  let buildOk = false;
  logger.info('Building project runtime');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
  } catch (err) {
    logger.error({ err }, 'Project build failed');
  }

  const verifyOk = buildOk && fs.existsSync(distEntry);
  const status = verifyOk ? 'success' : 'failed';

  emitStatus('SETUP_AGENT_RUNNER', {
    BUILD_OK: buildOk,
    VERIFY_OK: verifyOk,
    STATUS: status,
    DIST: distEntry,
  });

  if (status === 'failed') process.exit(1);
}

async function runGroupsStep(args: string[]): Promise<void> {
  const { list, limit } = parseGroupArgs(args);
  const groups = listRegisteredGroups();

  if (list) {
    const chats = Object.values(readAllChatsState())
      .filter((chat) => chat.jid !== '__group_sync__' && chat.is_group)
      .sort((left, right) =>
        right.last_message_time.localeCompare(left.last_message_time),
      )
      .slice(0, limit);

    for (const chat of chats) {
      console.log(`${chat.jid}|${chat.name}`);
    }
    return;
  }

  emitStatus('SYNC_GROUPS', {
    STORAGE: 'json',
    BUILD: 'skipped',
    SYNC: 'skipped',
    GROUPS_IN_DB: groups.length,
    REASON: 'setup_sync_removed_register_groups_manually',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function runRegisterStep(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseRegisterArgs(args);
  const trigger = parsed.trigger || `@${parsed.assistantName}`;

  if (!parsed.jid || !parsed.name || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidGroupFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  const groups = readAllRegisteredGroupsState();
  groups[parsed.jid] = {
    name: parsed.name,
    folder: parsed.folder,
    trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    isMain: parsed.isMain,
  };
  writeAllRegisteredGroupsState(groups);

  fs.mkdirSync(path.join(projectRoot, 'groups', parsed.folder, 'logs'), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(projectRoot, 'groups', parsed.folder, 'AGENTS.md'),
    `${(
      parsed.isMain
        ? renderMainAgentInstructions(parsed.assistantName)
        : renderGlobalAgentInstructions(parsed.assistantName)
    ).trim()}\n`,
  );

  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(
          /^ASSISTANT_NAME=.*$/m,
          `ASSISTANT_NAME="${parsed.assistantName}"`,
        );
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    nameUpdated = true;
  }

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function runMountsStep(args: string[]): Promise<void> {
  const { empty, json } = parseMountArgs(args);
  let allowedRoots = DEFAULT_MOUNT_ALLOWLIST.allowedRoots.length;
  let nonMainReadOnly = DEFAULT_MOUNT_ALLOWLIST.nonMainReadOnly ? 'true' : 'false';

  if (isRoot()) {
    logger.warn(
      'Running as root - mount allowlist is now embedded in src/config.ts',
    );
  }

  if (empty) {
    allowedRoots = 0;
    nonMainReadOnly = 'true';
  } else if (json) {
    let parsed: { allowedRoots?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(json);
    } catch {
      emitStatus('CONFIGURE_MOUNTS', {
        SOURCE: 'embedded',
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return;
    }

    allowedRoots = Array.isArray(parsed.allowedRoots)
      ? parsed.allowedRoots.length
      : 0;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
  }

  emitStatus('CONFIGURE_MOUNTS', {
    SOURCE: 'embedded',
    ALLOWED_ROOTS: allowedRoots,
    NON_MAIN_READ_ONLY: nonMainReadOnly,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  assistantName: string,
): string {
  return renderLaunchdPlist(nodePath, projectRoot, homeDir, assistantName);
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

function generateNohupWrapper(
  projectRoot: string,
  nodePath: string,
  pidFile: string,
): string {
  const lines = [
    '#!/bin/bash',
    '# start-nanoclaw.sh - Start NanoClaw without systemd',
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing NanoClaw (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting NanoClaw..."',
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/nanoclaw.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/nanoclaw.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "NanoClaw started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/nanoclaw.log"`,
  ];
  return lines.join('\n') + '\n';
}

function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
  } catch {}
}

function setupLaunchd(projectRoot: string, nodePath: string, homeDir: string): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'com.nanoclaw.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    generatePlist(nodePath, projectRoot, homeDir, ASSISTANT_NAME),
  );

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
  } catch {}

  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes('com.nanoclaw');
  } catch {
    serviceLoaded = false;
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
): void {
  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.sh');
  const pidFile = path.join(projectRoot, 'nanoclaw.pid');
  fs.writeFileSync(
    wrapperPath,
    generateNohupWrapper(projectRoot, nodePath, pidFile),
    { mode: 0o755 },
  );

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = '/etc/systemd/system/nanoclaw.service';
    systemctlPrefix = 'systemctl';
  } else {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      setupNohupFallback(projectRoot, nodePath);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, 'nanoclaw.service');
    systemctlPrefix = 'systemctl --user';
  }

  fs.writeFileSync(
    unitPath,
    generateSystemdUnit(nodePath, projectRoot, homeDir, runningAsRoot),
  );

  killOrphanedProcesses(projectRoot);

  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active nanoclaw`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    serviceLoaded = false;
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function runServiceStep(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir);
    return;
  }
  if (platform === 'linux') {
    if (getServiceManager() === 'systemd') {
      setupSystemd(projectRoot, nodePath, homeDir);
      return;
    }
    setupNohupFallback(projectRoot, nodePath);
    return;
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'unknown',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    STATUS: 'failed',
    ERROR: 'unsupported_platform',
    LOG: 'logs/setup.log',
  });
  process.exit(1);
}

async function runVerifyStep(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      if (output.includes('com.nanoclaw')) {
        const line = output.split('\n').find((entry) => entry.includes('com.nanoclaw'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {}
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active nanoclaw`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes('nanoclaw')) {
          service = 'stopped';
        }
      } catch {}
    }
  } else {
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }

  const runtimeEntry = path.join(projectRoot, 'dist', 'index.js');
  const agentRunnerReady = fs.existsSync(runtimeEntry) ? 'ready' : 'not_built';

  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (
      /^(export\s+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(
        envContent,
      )
    ) {
      credentials = 'configured';
    }
  }

  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
    'IMAP_HOST',
    'IMAP_USER',
    'IMAP_PASS',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
  ]);

  const channelAuth: Record<string, string> = {};
  if (process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN) {
    channelAuth.telegram = 'configured';
  }
  if (
    (process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN) &&
    (process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN)
  ) {
    channelAuth.slack = 'configured';
  }
  if (process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }
  if (
    (process.env.IMAP_HOST || envVars.IMAP_HOST) &&
    (process.env.IMAP_USER || envVars.IMAP_USER) &&
    (process.env.IMAP_PASS || envVars.IMAP_PASS) &&
    (process.env.SMTP_HOST || envVars.SMTP_HOST) &&
    (process.env.SMTP_USER || envVars.SMTP_USER) &&
    (process.env.SMTP_PASS || envVars.SMTP_PASS)
  ) {
    channelAuth.email = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const registeredGroups = listRegisteredGroups().length;

  const status =
    service === 'running' &&
    credentials !== 'missing' &&
    configuredChannels.length > 0 &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  emitStatus('VERIFY', {
    SERVICE: service,
    AGENT_RUNNER: agentRunnerReady,
    STORAGE: 'json',
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: 'configured',
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stepIdx = args.indexOf('--step');

  if (stepIdx === -1 || !args[stepIdx + 1]) {
    console.error(
      `Usage: npx tsx setup/index.ts --step <${Object.keys(STEPS).join('|')}> [args...]`,
    );
    process.exit(1);
  }

  const stepName = args[stepIdx + 1];
  const stepArgs = args.filter(
    (arg, index) => index !== stepIdx && index !== stepIdx + 1 && arg !== '--',
  );
  const step = STEPS[stepName];

  if (!step) {
    console.error(`Unknown step: ${stepName}`);
    console.error(`Available steps: ${Object.keys(STEPS).join(', ')}`);
    process.exit(1);
  }

  try {
    await step(stepArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, step: stepName }, 'Setup step failed');
    emitStatus(stepName.toUpperCase(), {
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(1);
  }
}

main();
