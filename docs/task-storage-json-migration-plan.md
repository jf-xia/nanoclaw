# Task Storage JSON Migration Plan

## Current state

NanoClaw now stores all host-side runtime state in JSON files under `data/`.

Current files:

- `data/messages.json`
- `data/scheduled_tasks.json`
- `data/task_run_logs.json`
- `data/chats.json`
- `data/router_state.json`
- `data/sessions.json`
- `data/registered_groups.json`

## Storage model

- `messages.json` stores full message history for registered groups.
- `scheduled_tasks.json` stores mutable task definitions keyed by task id.
- `task_run_logs.json` stores append-only task execution history.
- `chats.json`, `router_state.json`, `sessions.json`, and `registered_groups.json` remain the lightweight state files used by the runtime.

All on-disk writes use atomic temp-file-plus-rename updates.

## Legacy migration

If `store/messages.db` still exists from an older install, `src/db.ts` performs a best-effort one-time import into the JSON files on startup.

Imported legacy tables:

- `messages`
- `scheduled_tasks`
- `task_run_logs`
- `chats`
- `router_state`
- `sessions`
- `registered_groups`

The importer uses the system `sqlite3` CLI when available. If the CLI is missing, NanoClaw continues running with JSON storage and logs that the legacy import was skipped.

## Operational guidance

- Inspect messages with `cat data/messages.json`
- Inspect scheduled tasks with `cat data/scheduled_tasks.json`
- Inspect task run logs with `cat data/task_run_logs.json`
- Back up runtime state by copying the `data/` directory

## Code areas

- `src/db.ts`
- `src/task-scheduler.ts`
- `src/ipc.ts`
- `src/index.ts`
- `src/state-files.ts`
- `src/db.test.ts`
- `src/ipc-auth.test.ts`

## Summary

SQLite is no longer a runtime dependency. All persistent host-side data now lives in JSON files, with a compatibility path only for importing older SQLite installs.