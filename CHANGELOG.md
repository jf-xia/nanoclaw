# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

- [BREAKING] Renamed project and group memory files from `CLAUDE.md` to `AGENTS.md` and moved host workflow docs from `.claude/` to `.copilot/`.
- [BREAKING] Replaced the legacy Claude remote-control flow with a Copilot CLI handoff session that returns a resumable `copilot --resume=...` command.
- docs: Added `docs/COPILOT_CLI_MIGRATION.md` with migration notes, Copilot CLI usage, and optimization recommendations.
- [BREAKING] Removed the previous external runtime path. Agents now execute as local child processes through the built-in agent runner.
- docs: Rewrote setup, security, and architecture documentation around the native runtime model.
- feat: `./container/build.sh` now rebuilds the local agent-runner bundle.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
