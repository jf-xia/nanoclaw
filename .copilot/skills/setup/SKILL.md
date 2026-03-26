---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 0. Git & Fork Setup

Check the git remote configuration to ensure the user has a fork and upstream is configured.

Run:
- `git remote -v`

**Case A — `origin` points to `qwibitai/nanoclaw` (user cloned directly):**

The user cloned instead of forking. AskUserQuestion: "You cloned NanoClaw directly. We recommend forking so you can push your customizations. Would you like to set up a fork?"
- Fork now (recommended) — walk them through it
- Continue without fork — they'll only have local changes

If fork: instruct the user to fork `qwibitai/nanoclaw` on GitHub (they need to do this in their browser), then ask them for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/nanoclaw.git
git push --force origin main
```
Verify with `git remote -v`.

If continue without fork: add upstream so they can still pull updates:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

**Case B — `origin` points to user's fork, no `upstream` remote:**

Add upstream:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

**Case C — both `origin` (user's fork) and `upstream` (qwibitai) exist:**

Already configured. Continue.

**Verify:** `git remote -v` should show `origin` → user's repo, `upstream` → `qwibitai/nanoclaw.git`.

## 1. Bootstrap (Node.js + Dependencies + OneCLI)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → a native dependency failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

After bootstrap succeeds, install OneCLI and its CLI tool:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify both installed: `onecli version`. If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH for the current session and persist it:

```bash
export PATH="$HOME/.local/bin:$PATH"
# Persist for future sessions (append to shell profile if not already present)
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then re-verify with `onecli version`.

Point the CLI at the local OneCLI instance (it defaults to the cloud service otherwise):
```bash
onecli config set api-host http://127.0.0.1:10254
```

Ensure `.env` has the OneCLI URL (create the file if it doesn't exist):
```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=http://127.0.0.1:10254' >> .env
```

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record `AGENT_RUNNER_READY` for step 3

## 3. Local Agent Runner

Run `npx tsx setup/index.ts --step container` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Missing dependencies: run `npm install` at repo root, then retry.
- Agent runner dependencies missing: run `cd container/agent-runner && npm install`, then retry.

**If VERIFY_OK=false but BUILD_OK=true:** The TypeScript build completed but `dist/index.js` is missing. Check the build log for path or compiler errors and retry.

## 4. Anthropic Credentials via OneCLI

NanoClaw uses OneCLI to manage credentials — API keys are never stored in `.env` or exposed to containers. The OneCLI gateway injects them at request time.

Check if a secret already exists:
```bash
onecli secrets list
```

If an Anthropic secret is listed, confirm with user: keep or reconfigure? If keeping, skip to step 5.

AskUserQuestion: Do you want to use your **Copilot subscription** (Pro/Max) or an **Anthropic API key**?

1. **Copilot subscription (Pro/Max)** — description: "Uses your existing Copilot Pro or Max subscription. You'll run `copilot setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

### Subscription path

Tell the user to run `copilot setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have the token, they register it with OneCLI. AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open http://127.0.0.1:10254 and add the secret in the UI. Use type 'anthropic' and paste your token as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Then AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open http://127.0.0.1:10254 and add the secret in the UI."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-`): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 6.

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 8. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (check `onecli secrets list` for Anthropic secret)
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST is embedded in `src/config.ts`; if mount policy is wrong, update the in-code allowlist and re-run verify

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), OneCLI not running (check `curl http://127.0.0.1:10254/api/health`), missing channel credentials (re-invoke channel skill).

**Agent fails ("Copilot CLI process exited with code 1"):** Rebuild the local runner with `./container/build.sh`, then check the latest agent logs in `groups/main/logs/agent-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`


## 9. Diagnostics

Send diagnostics data by following `.copilot/skills/setup/diagnostics.md`.
