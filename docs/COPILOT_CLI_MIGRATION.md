# Copilot CLI Migration

## Summary

NanoClaw now treats GitHub Copilot CLI as the primary interactive runtime and removes the remaining Claude-branded project structure.

## What Changed

- Memory files were renamed from `CLAUDE.md` to `AGENTS.md`.
- Host workflow docs were moved from `.claude/` to `.copilot/`.
- The legacy `claude remote-control` flow was replaced with a Copilot handoff flow that returns a resumable local command.
- Project docs now describe Copilot CLI and GitHub Copilot SDK as the primary runtime.
- Verification and helper scripts now look for `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` instead of Claude-specific OAuth variable names.

## Breaking Changes

1. Existing local installs that still keep memory in `CLAUDE.md` should rename those files to `AGENTS.md`.
2. Any automation or personal notes that referenced `.claude/skills/...` should be updated to `.copilot/skills/...`.
3. `/remote-control` no longer creates a browser bridge URL. It now returns a local resume command such as:

```bash
copilot --resume=<session-id>
```

4. If you previously depended on `CLAUDE_CODE_OAUTH_TOKEN`, switch to one of:

```bash
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
ANTHROPIC_AUTH_TOKEN=...
```

## Usage

### Start a new interactive session

```bash
copilot
```

Then run NanoClaw workflow prompts such as:

```text
/setup
/add-whatsapp
/debug
/customize
```

### Resume a handoff session from chat

When NanoClaw returns a handoff message, copy the printed command and run it locally:

```bash
copilot --resume=<session-id>
```

### Project memory layout

- Root instructions: `AGENTS.md`
- Global group memory: `groups/global/AGENTS.md`
- Main group memory: `groups/main/AGENTS.md`
- Per-group memory: `groups/<group>/AGENTS.md`

### Verify the installation

```bash
npm run build
npm run typecheck
npm run test
```

## Recommended Migration Steps For Existing Installs

1. Pull the latest changes.
2. Rename any remaining local `CLAUDE.md` files to `AGENTS.md`.
3. Rename any custom `.claude/` references in personal scripts or notes to `.copilot/`.
4. Update environment variables if you still rely on the old Claude OAuth variable.
5. Run the build and test commands.
6. Start a `copilot` session and execute `/setup` or `/debug` if you need to refresh local configuration.

## Follow-up Optimization Ideas

1. Replace branch-and-SKILL based host workflows with a more explicit Copilot-native prompt catalog.
2. Add a repository task that automatically migrates old `CLAUDE.md` files in existing user workspaces.
3. Add a dedicated `/handoff` or `/resume-session` command name so the new Copilot-based flow is clearer than `/remote-control`.
4. Reduce remaining Anthropic-specific configuration assumptions by supporting a first-class Copilot-only auth path end-to-end.
5. Add tests that assert there are no `claude` keywords left in tracked source and docs outside intentional historical notes.
