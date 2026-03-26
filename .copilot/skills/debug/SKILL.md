---
name: debug
description: Debug NanoClaw local agent issues. Use when things aren't working, the runner fails, authentication breaks, or you need to inspect runtime directories, logs, and common host-side problems.
---

# NanoClaw Local Runner Debugging

This guide covers debugging the native agent execution path.

## Architecture Overview

```
Host process                         Local runner
─────────────────────────────────────────────────────────────
src/container-runner.ts             container/agent-runner/
    │                                   │
    │ spawns child process              │ runs GitHub Copilot SDK/CLI
    │ prepares runtime dirs             │ with MCP servers
    │                                   │
    ├── groups/{folder} ───────────> working directory
    ├── data/ipc/{folder} ────────> NANOCLAW_IPC_DIR
    ├── data/sessions/{folder}/.copilot/ -> NANOCLAW_SESSION_DIR
    └── project/global dirs passed via env when allowed
```

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| Main app logs | `logs/nanoclaw.log` | Routing, queueing, runner startup |
| Main app errors | `logs/nanoclaw.error.log` | Host-side failures |
| Per-run logs | `groups/{folder}/logs/agent-*.log` | Per-run stdout/stderr summary |
| Session state | `data/sessions/{group}/.copilot/` | Per-group Copilot config and history |

## First Checks

```bash
tail -50 logs/nanoclaw.log
ps aux | grep '[n]ode .*container/agent-runner/dist/index.js'
ls -la container/agent-runner/dist/index.js
```

## Common Issues

### 1. Runner exits with code 1

Check the latest log first:

```bash
ls -t groups/*/logs/agent-*.log | head -3
cat groups/<group>/logs/agent-<timestamp>.log
```

Common causes:

- Missing `.env` credentials
- Broken MCP configuration
- Unbuilt agent runner
- Session directory permissions

### 2. Authentication failures

Verify `.env` or host-managed credentials contain one of:

```bash
grep -E 'GITHUB_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL' .env
```

### 3. Session not resuming

Check the per-group session directory:

```bash
ls -la data/sessions/<group>/.copilot/
grep 'session' logs/nanoclaw.log | tail -20
```

If the directory is missing or empty unexpectedly, rebuild and retry:

```bash
./container/build.sh
npm run build
```

### 4. IPC issues

Inspect the group's IPC directory:

```bash
find data/ipc/<group> -maxdepth 2 -type f | sort
cat data/ipc/<group>/messages/*.json 2>/dev/null
cat data/ipc/<group>/tasks/*.json 2>/dev/null
```

### 5. Mount policy problems

Mount validation still happens on the host. Check:

```bash
rg -n "DEFAULT_MOUNT_ALLOWLIST" src/config.ts
grep -E 'Mount validated|Mount.*REJECTED' logs/nanoclaw.log | tail -20
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"
```

## Manual Runner Test

```bash
mkdir -p groups/test data/ipc/test/{messages,tasks,input} data/sessions/test/.copilot
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  NANOCLAW_GROUP_DIR="$(pwd)/groups/test" \
  NANOCLAW_IPC_DIR="$(pwd)/data/ipc/test" \
  NANOCLAW_SESSION_DIR="$(pwd)/data/sessions/test/.copilot" \
  node container/agent-runner/dist/index.js
```

## Rebuild After Changes

```bash
./container/build.sh
npm run build
```

## Quick Diagnostic Script

```bash
echo "=== Checking NanoClaw Local Runner Setup ==="

echo -e "\n1. Provider credentials configured?"
[ -f .env ] && (grep -q "GITHUB_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env || grep -q "ANTHROPIC_AUTH_TOKEN=" .env) && echo "OK" || echo "MISSING - add credentials to .env or configure host auth"

echo -e "\n2. Agent runner built?"
[ -f container/agent-runner/dist/index.js ] && echo "OK" || echo "MISSING - run ./container/build.sh"

echo -e "\n3. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n4. Recent runner logs?"
ls -t groups/*/logs/agent-*.log 2>/dev/null | head -3 || echo "No runner logs yet"

echo -e "\n5. Service log tail"
tail -5 logs/nanoclaw.log 2>/dev/null || echo "No service log yet"
```
