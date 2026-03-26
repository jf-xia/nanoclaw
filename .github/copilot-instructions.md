# NanoClaw – Copilot Instructions

## Architecture

Single Node.js process. Channels (Telegram, Slack, Discord, Gmail) self-register at startup via `src/channels/registry.ts`. Runtime storage is JSON-backed under `data/` (`messages.json`, `scheduled_tasks.json`, `task_run_logs.json`, `chats.json`, `router_state.json`, `sessions.json`, `registered_groups.json`). Messages are routed to Copilot agents running as local child processes (one active runner per group queue slot). Each group has isolated session state, working files, and memory.

**Message flow:**

```
Channel → storage.storeMessage() → message loop polls → GroupQueue
  → agent-runtime starts the local agent session
    → Copilot CLI agent runs with group-scoped runtime dirs
    → agent writes output with sentinel markers
  → agent-runtime yields structured output
  → router.formatOutbound() strips <internal> blocks
  → Channel.sendMessage() delivers reply
```

**IPC (agent → host):** The local runner writes JSON files to `data/ipc/{groupFolder}/`. `src/ipc.ts` polls and processes them — task scheduling, cross-group messaging, group registration. Non-main groups can only message their own JID.

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

## Testing

Vitest. Tests live alongside source as `*.test.ts`. Use `_initTestStorage()` from `src/storage.ts` for isolated in-memory storage in tests. Skill tests have a separate config (`vitest.skills.config.ts`) and live in `.copilot/skills/**/tests/`.
