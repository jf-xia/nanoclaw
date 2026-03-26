# NanoClaw – Copilot Instructions

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm run dev            # Run with hot reload (tsx)
npm run typecheck      # Type-check without emitting
npm run test           # Run all tests once (vitest)
npm run test:watch     # Watch mode
npm run test -- path/to/file.test.ts   # Single test file
npm run lint           # ESLint src/
npm run lint:fix       # Auto-fix lint
npm run format         # Prettier write
./container/build.sh   # Rebuild local agent runner
```

## Architecture

Single Node.js process. Channels (Telegram, Slack, Discord, Gmail) self-register at startup via `src/channels/registry.ts`. Runtime storage is JSON-backed under `data/` (`messages.json`, `scheduled_tasks.json`, `task_run_logs.json`, `chats.json`, `router_state.json`, `sessions.json`, `registered_groups.json`). Messages are routed to Copilot agents running as local child processes (one active runner per group queue slot). Each group has isolated session state, working files, and memory.

**Message flow:**

```
Channel → storage.storeMessage() → message loop polls → GroupQueue
  → container-runner spawns local agent process
    → Copilot CLI agent runs with group-scoped runtime dirs
    → agent writes output with sentinel markers
  → container-runner parses output
  → router.formatOutbound() strips <internal> blocks
  → Channel.sendMessage() delivers reply
```

**IPC (agent → host):** The local runner writes JSON files to `data/ipc/{groupFolder}/`. `src/ipc.ts` polls and processes them — task scheduling, cross-group messaging, group registration. Non-main groups can only message their own JID.

**Key files:**

| File | Role |
|------|------|
| `src/index.ts` | Orchestrator: channels, message loop, agent invocation |
| `src/container-runner.ts` | Spawns local runners, prepares runtime dirs, parses output |
| `src/ipc.ts` | IPC watcher: processes task/message files from local runners |
| `src/storage.ts` | JSON-backed message and task storage |
| `src/state-files.ts` | JSON-backed runtime state for chats, router state, sessions, and registered groups |
| `src/group-queue.ts` | Concurrency manager (default max 5 active runners) |
| `src/router.ts` | XML message formatting, outbound routing |
| `src/config.ts` | All env vars and computed paths |
| `src/types.ts` | Shared interfaces (Channel, RegisteredGroup, etc.) |
| `src/credential-proxy.ts` | Host-side credential bridge for agent requests |

## Conventions

### TypeScript
- Strict mode. No `any`. Prefer `interface` over `type` for object shapes.
- Named exports only (no default exports except where required by framework).
- Module system: `NodeNext` — use `.js` extensions in imports even for `.ts` source files.

### Logging
Use `src/logger.ts` (Pino). Always pass a context object first:
```ts
logger.info({ groupJid, count }, 'Messages processed');
logger.error({ err, group: name }, 'Agent failed');
```

### Storage
`src/storage.ts` stores messages, scheduled tasks, and task run logs as JSON files in `data/`. Runtime state such as discovered chats, router cursors, Copilot session IDs, and registered groups is stored in separate JSON files via `src/state-files.ts`. Preserve the existing storage API and use atomic temp-file-plus-rename writes for on-disk updates.

```ts
storeMessage(message);
```

### Channel Registration
Channels use a factory pattern. The factory returns `null` if credentials are missing (channel is skipped gracefully). Import in `src/channels/index.ts` triggers self-registration.

```ts
registerChannel('telegram', (config) => {
  if (!config.token) return null;
  return new TelegramChannel(config);
});
```

### Error Handling
No swallowing errors in bare `catch` blocks — ESLint enforces type narrowing. Failed IPC files move to `data/ipc/errors/` for manual inspection. Agent output is bounded by `CONTAINER_MAX_OUTPUT_SIZE`.

### Agent Output Parsing
Local runners delimit their output with sentinel markers:
```
---NANOCLAW_OUTPUT_START--- { "result": "..." } ---NANOCLAW_OUTPUT_END---
```
`<internal>...</internal>` blocks in output are stripped before sending to the user.

## Skill System

New features go in **skills**, not in core source. Four types:

| Type | Location | When to use |
|------|----------|-------------|
| **Feature** | `.copilot/skills/<name>/` + `skill/<name>` branch | New channel or capability |
| **Utility** | `.copilot/skills/<name>/` (self-contained) | Standalone tool (e.g., CLI) |
| **Operational** | `.copilot/skills/<name>/` (instructions only) | Workflows, guides, setup |
| **Runtime** | `src/runtime-assets/*` | Built-in instructions and runtime skill templates loaded into the agent environment |

All skills use a SKILL.md with YAML frontmatter:
```yaml
---
name: my-skill          # lowercase, alphanumeric + hyphens, ≤64 chars
description: One line — when to invoke this skill.
allowed-tools: Bash(scope:*), Read   # optional, container skills only
---
```

Keep SKILL.md under 500 lines. Put code in separate files, reference via `${COPILOT_WORKFLOW_DIR}`.

## Config & Secrets

`src/config.ts` exposes env vars as typed constants — **never** API keys, only non-secret config. Secrets are resolved on the host before or during local agent execution.

Key env vars: `ASSISTANT_NAME` (trigger prefix), `CONTAINER_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS`, `LOG_LEVEL`, `ONECLI_URL`.

## Testing

Vitest. Tests live alongside source as `*.test.ts`. Use `_initTestStorage()` from `src/storage.ts` for isolated in-memory storage in tests. Skill tests have a separate config (`vitest.skills.config.ts`) and live in `.copilot/skills/**/tests/`.

## PR Guidelines

- Bug fixes and simplifications only in core. Features → skills.
- One thing per PR. Link issues with `Closes #123`.
- Check the correct PR template checkbox (auto-applies label).
- Test skill end-to-end on a fresh clone before submitting.
