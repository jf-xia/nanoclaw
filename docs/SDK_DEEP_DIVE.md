# GitHub Copilot SDK Notes

This document replaces the old Anthropic-specific deep dive.

NanoClaw now runs on GitHub Copilot SDK and Copilot CLI directly. The earlier reverse-engineering notes for the retired Claude runtime were intentionally removed to avoid preserving stale implementation details.

## Use These Sources Instead

- docs/SPEC.md for the current architecture
- docs/DEBUG_CHECKLIST.md for runtime troubleshooting
- container/agent-runner/src/index.ts for the active Copilot session setup
- docs/COPILOT_CLI_MIGRATION.md for the migration summary and operational guidance

## Scope

If you are debugging NanoClaw today, treat any references to legacy Anthropic presets, historical `claude_code` tool presets, or older executable path options as obsolete.
