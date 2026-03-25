---
name: claw
description: Install the claw CLI tool — run NanoClaw agents locally from the command line without opening a chat app.
---

# claw — NanoClaw CLI

`claw` is a Python CLI that sends prompts directly to the local NanoClaw agent runner from the terminal. It reads registered groups from the NanoClaw database, picks up secrets from `.env`, prepares the same runtime directories as the main app, and pipes a JSON payload into the runner.

## What it does

- Send a prompt to any registered group by name, folder, or JID
- Default target is the main group (no `-g` needed for most use)
- Resume a previous session with `-s <session-id>`
- Read prompts from stdin (`--pipe`) for scripting and piping
- List all registered groups with `--list-groups`
- Prints the agent's response to stdout; session ID to stderr
- Verbose mode (`-v`) shows the local command, payload, and exit code

## Prerequisites

- Python 3.8 or later
- NanoClaw installed with a built local agent runner (`./container/build.sh`)

## Install

Run this skill from within the NanoClaw directory. The script auto-detects its location, so the symlink always points to the right place.

### 1. Copy the script

```bash
mkdir -p scripts
cp "${COPILOT_WORKFLOW_DIR}/scripts/claw" scripts/claw
chmod +x scripts/claw
```

### 2. Symlink into PATH

```bash
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/claw" ~/bin/claw
```

Make sure `~/bin` is in `PATH`. Add this to `~/.zshrc` or `~/.bashrc` if needed:

```bash
export PATH="$HOME/bin:$PATH"
```

Then reload the shell:

```bash
source ~/.zshrc   # or ~/.bashrc
```

### 3. Verify

```bash
claw --list-groups
```

You should see registered groups. If NanoClaw isn't running or the database doesn't exist yet, the list will be empty — that's fine.

## Usage Examples

```bash
# Send a prompt to the main group
claw "What's on my calendar today?"

# Send to a specific group by name (fuzzy match)
claw -g "family" "Remind everyone about dinner at 7"

# Send to a group by exact JID
claw -j "120363336345536173@g.us" "Hello"

# Resume a previous session
claw -s abc123 "Continue where we left off"

# Read prompt from stdin
echo "Summarize this" | claw --pipe -g dev

# Pipe a file
cat report.txt | claw --pipe "Summarize this report"

# List all registered groups
claw --list-groups

# Verbose mode (debug info, secrets redacted)
claw -v "Hello"

# Custom timeout for long-running tasks
claw --timeout 600 "Run the full analysis"
```

## Troubleshooting

### "local agent runner is not built"

Run `./container/build.sh` from the NanoClaw repo root.

### "no secrets found in .env"

The script auto-detects your NanoClaw directory and reads `.env` from it. Check that the file exists and contains at least one of: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

### Runner times out

The default timeout is 300 seconds. For longer tasks, pass `--timeout 600` (or higher). If the runner consistently hangs, rebuild it with `./container/build.sh`.

### "group not found"

Run `claw --list-groups` to see what's registered. Group lookup does a fuzzy partial match on name and folder — if your query matches multiple groups, you'll get an error listing the ambiguous matches.

### Runner crashes mid-stream

If the agent crashes before emitting the output sentinel, `claw` falls back to printing raw stdout. Use `-v` to see what the runner produced. Rebuild the local runner with `./container/build.sh` if crashes are consistent.

### Override the NanoClaw directory

If `claw` can't find your database or `.env`, set the `NANOCLAW_DIR` environment variable:

```bash
export NANOCLAW_DIR=/path/to/your/nanoclaw
```
