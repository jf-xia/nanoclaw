<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents locally in scoped group workspaces. Lightweight, easy to understand, and meant to be customized directly in code.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Agents now run as local child processes with per-group working directories, isolated session state, and explicit mount allowlists.

## Quick Start

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
copilot
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `copilot`

</details>

Then run `/setup`. Copilot CLI handles dependencies, authentication, local agent-runner build, and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are NanoClaw workflow prompts intended to be run inside a `copilot` CLI session. See [docs/COPILOT_CLI_MIGRATION.md](docs/COPILOT_CLI_MIGRATION.md) for the updated workflow model.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Copilot CLI to walk you through it.

**Scoped by design.** Agents run locally, but each group gets its own working directory, session state, and mount policy. This is a native runtime, not an OS sandbox, so trust and code review still matter.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Copilot CLI modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Copilot CLI guides setup.
- No monitoring dashboard; ask Copilot what's happening.
- No debugging tools; describe the problem and Copilot fixes it.

**Workflows over bundled features.** Instead of adding every possible integration to core, contributors provide focused workflow docs and branch-based add-ons like `/add-telegram`. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the GitHub Copilot SDK, which means you're running Copilot CLI directly. Copilot CLI is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, Gmail, or a plain IMAP/SMTP mailbox. Run one or many at the same time.
- **Scoped group context** - Each group has its own `AGENTS.md` memory, working directory, and isolated Copilot session state.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Copilot and can message you back
- **Web access** - Search and fetch content from the Web
- **Native runtime** - Agents execute as local streaming child processes, which keeps startup fast and deployment simple.
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Email Channel

NanoClaw can also use a regular email account as a channel. When `IMAP_*` and `SMTP_*` variables are present, the app loads the built-in `email` channel automatically.

Configure your `.env` like this:

```bash
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_USER=bot@example.com
IMAP_PASS=app-password-or-mail-password
IMAP_TLS=true

SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=bot@example.com
SMTP_PASS=app-password-or-mail-password
```

Notes:

- Email chats use JIDs in the form `email:alice@example.com`
- The first inbound email from a sender auto-registers a direct-chat group for that address
- The channel polls unread mail from `INBOX`
- Incoming mail stores the subject in the message body as `[Subject] ...`
- Replies go out over SMTP and keep the original email thread metadata when available

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Copilot CLI what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Copilot can safely modify it.

## Contributing

**Don't add features. Add workflows.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Workflows)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

## Requirements

- macOS or Linux
- Node.js 20+
- [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)

## Architecture

```
Channels --> SQLite --> Polling loop --> Local Agent Runner (GitHub Copilot SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute as local child processes. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming local agent processes
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/AGENTS.md` - Per-group memory

## FAQ

**Why a native runtime?**

The local runner removes image builds, daemon dependencies, and runtime drift between host and agent. Startup is simpler and faster, and the system is easier to debug because the executed code is exactly what lives in this repo.

**Can I run this on Linux?**

Yes. The local runner works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

It is safer than a sprawling multi-process system, but it is not an OS sandbox. Agents run on your host as child processes. Use trusted groups, review mount access carefully, and treat automation with the same caution as any local coding agent. See [docs/SECURITY.md](docs/SECURITY.md) and [docs/NATIVE_RUNTIME.md](docs/NATIVE_RUNTIME.md).

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Copilot to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports Anthropic-compatible endpoints and proxy-backed local models. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

Note: The model must support the Anthropic API format for best compatibility.

**How do I debug issues?**

Ask Copilot CLI. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Copilot will try to dynamically fix them. If that doesn't work, run `copilot`, then run `/debug`. If the issue affects other users, open a PR updating the relevant workflow document.

**Where is the migration guide?**

See [docs/COPILOT_CLI_MIGRATION.md](docs/COPILOT_CLI_MIGRATION.md) for the breaking changes, the new `AGENTS.md` memory model, Copilot CLI usage, and follow-up optimization ideas.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
