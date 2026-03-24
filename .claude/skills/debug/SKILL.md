---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

The current runtime uses GitHub Copilot CLI and the Copilot SDK inside the container. NanoClaw still feeds group memory from `CLAUDE.md` files for compatibility, and it still uses Anthropic-compatible credentials through the host credential proxy.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
  │ spawns container                      │ runs GitHub Copilot SDK/CLI
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
  ├── data/sessions/{folder}/.copilot/ ─> /workspace/session (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** Session state is now isolated at `/workspace/session`. Do not debug against `/home/node/.claude/` — that path is no longer the source of truth for NanoClaw session resumption.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side WhatsApp, routing, container spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Session state mirror** | `data/sessions/{group}/.copilot/` | Per-group Copilot config, skill mirror, session workspace |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "Copilot agent process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Authentication failed for the configured provider
```
**Fix:** Ensure `.env` file exists with either Anthropic OAuth token or API key. The Copilot harness still runs against NanoClaw's Anthropic-compatible provider path:
```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription-backed token)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Credential Proxy Expectations

NanoClaw does not pass real secrets into the container. The host starts a credential proxy, and the container receives placeholder auth plus `ANTHROPIC_BASE_URL` pointing at the proxy.

To verify the container has the expected proxy wiring:
```bash
echo '{}' | docker run -i \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3001 \
  -e ANTHROPIC_API_KEY=placeholder \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'echo "BASE_URL=$ANTHROPIC_BASE_URL" && echo "API_KEY=$ANTHROPIC_API_KEY"'
```

### 3. Mount Issues

**Container mount notes:**
- Docker supports both `-v` and `--mount` syntax
- Use `:ro` suffix for readonly mounts:
  ```bash
  # Readonly
  -v /path:/container/path:ro

  # Read-write
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only)
├── session/              # Per-group Copilot session/config/skills mirror
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing WhatsApp messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: WhatsApp groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / "Copilot agent process exited with code 1"

If sessions aren't being resumed (new session ID every time), or the Copilot runner exits with code 1 when resuming:

**Root cause:** NanoClaw now pins Copilot session/config state to `/workspace/session`. If that mount is missing or empty, the runner will create a fresh session every time.

**Check the mount path:**
```bash
# In container-runner.ts, verify the isolated session mount points at /workspace/session
grep -A6 "Per-group Copilot session directory" src/container-runner.ts
```

**Verify sessions are accessible:**
```bash
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/sessions/test/.copilot:/workspace/session \
  nanoclaw-agent:latest -c '
ls -la /workspace/session 2>&1 | head -20
'
```

**Fix:** Ensure `container-runner.ts` mounts the per-group session directory to `/workspace/session`:
```typescript
mounts.push({
  hostPath: groupSessionsDir,
  containerPath: '/workspace/session',
  readonly: false
});
```

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test
cp .env data/env/env

# Run test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  nanoclaw-agent:latest
```

### Test Copilot CLI directly:
```bash
docker run --rm --entrypoint /bin/bash \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3001 \
  -e ANTHROPIC_API_KEY=placeholder \
  nanoclaw-agent:latest -c '
  /app/node_modules/.bin/copilot -p "Say hello" --allow-all --output-format text --stream off
'
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## Runtime Options Reference

The agent-runner now creates a Copilot session with these key options:

```typescript
client.createSession({
  configDir: '/workspace/session',
  workingDirectory: '/workspace/group',
  onPermissionRequest: approveAll,
  systemMessage: { content: mergedClaudeMdContext },
  mcpServers: { ... }
})
```

**Important:** Container context is now injected through Copilot `systemMessage` and MCP server configuration, not Claude `settingSources` or `permissionMode` flags.

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
docker builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
docker images

# Check what's in the image
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Copilot CLI version ==="
  copilot --version || /app/node_modules/.bin/copilot --version

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Copilot session state is stored per-group in `data/sessions/{group}/.copilot/` for security isolation. Each group has its own isolated session directory, preventing cross-group access to conversation history.

**Critical:** The mount path must match NanoClaw's configured Copilot session directory:
- Host session directory: `data/sessions/{group}/.copilot/`
- Container mount target: `/workspace/session`

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.copilot/

# Also clear the session ID from NanoClaw's tracking (stored in SQLite)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing WhatsApp messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of WhatsApp groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. Provider credentials configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Container runtime running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING - start Docker Desktop (macOS) or sudo systemctl start docker (Linux)"

echo -e "\n3. Container image exists?"
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n4. Session mount path correct?"
grep -q "/workspace/session" src/container-runner.ts 2>/dev/null && echo "OK" || echo "WRONG - should mount to /workspace/session"

echo -e "\n5. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n6. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n7. Session continuity working?"
SESSIONS=$(grep "Copilot session" groups/*/logs/container-*.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
