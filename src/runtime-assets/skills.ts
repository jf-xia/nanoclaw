export const RUNTIME_SKILLS: Record<string, string> = {
  'agent-browser': `---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

## Quick start

\`\`\`bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser close
\`\`\`

## Core workflow

1. Navigate: \`agent-browser open <url>\`
2. Snapshot: \`agent-browser snapshot -i\`
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Commands

### Navigation

\`\`\`bash
agent-browser open <url>
agent-browser back
agent-browser forward
agent-browser reload
agent-browser close
\`\`\`

### Snapshot

\`\`\`bash
agent-browser snapshot
agent-browser snapshot -i
agent-browser snapshot -c
agent-browser snapshot -d 3
agent-browser snapshot -s "#main"
\`\`\`

### Interactions

\`\`\`bash
agent-browser click @e1
agent-browser dblclick @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser press Enter
agent-browser hover @e1
agent-browser check @e1
agent-browser uncheck @e1
agent-browser select @e1 "value"
agent-browser scroll down 500
agent-browser upload @e1 file.pdf
\`\`\`

### Get information

\`\`\`bash
agent-browser get text @e1
agent-browser get html @e1
agent-browser get value @e1
agent-browser get attr @e1 href
agent-browser get title
agent-browser get url
agent-browser get count ".item"
\`\`\`

### Screenshots and PDF

\`\`\`bash
agent-browser screenshot
agent-browser screenshot path.png
agent-browser screenshot --full
agent-browser pdf output.pdf
\`\`\`

### Wait

\`\`\`bash
agent-browser wait @e1
agent-browser wait 2000
agent-browser wait --text "Success"
agent-browser wait --url "**/dashboard"
agent-browser wait --load networkidle
\`\`\`

### Semantic locators

\`\`\`bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
\`\`\`
`,
  capabilities: `---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

Only the main channel has /workspace/project mounted. Run:

\`\`\`bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
\`\`\`

If NOT_MAIN, respond with:
This command is available in your main chat only. Send /capabilities there to see what I can do.

Then stop.

Gather:

1. Installed skills from:

\`\`\`bash
ls -1 /workspace/session/skills/ 2>/dev/null || echo "No skills found"
\`\`\`

2. Available tools summary.

3. MCP tools summary:
- send_message
- schedule_task
- list_tasks
- pause_task
- resume_task
- cancel_task
- update_task
- register_group

4. Container utilities:

\`\`\`bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
\`\`\`

5. Group info:

\`\`\`bash
ls /workspace/group/AGENTS.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
ls /workspace/session/ 2>/dev/null && echo "Session state: yes" || echo "Session state: no"
\`\`\`
`,
  'slack-formatting': `---
name: slack-formatting
description: Format messages for Slack using mrkdwn syntax. Use when responding to Slack channels (folder starts with "slack_" or JID contains slack identifiers).
---

# Slack Message Formatting

When responding to Slack channels, use Slack mrkdwn syntax instead of standard Markdown.

Key rules:

- Use *bold* not **bold**
- Use <url|text> not [text](url)
- Use bullets, not numbered lists
- Use :emoji: shortcodes
- Use > for block quotes
- Do not use Markdown headings or tables
`,
  status: `---
name: status
description: Quick read-only health check — session context, workspace mounts, tool availability, and task snapshot. Use when the user asks for system status or runs /status.
---

# /status — System Status Check

Generate a concise read-only status report.

Only the main channel has /workspace/project mounted. Run:

\`\`\`bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
\`\`\`

If NOT_MAIN, respond with:
This command is available in your main chat only. Send /status there to check system status.

Then stop.

Gather:

\`\`\`bash
echo "Timestamp: $(date)"
echo "Working dir: $(pwd)"
echo "=== Workspace ==="
ls /workspace/ 2>/dev/null
echo "=== Group folder ==="
ls /workspace/group/ 2>/dev/null | head -20
echo "=== Extra mounts ==="
ls /workspace/extra/ 2>/dev/null || echo "none"
echo "=== IPC ==="
ls /workspace/ipc/ 2>/dev/null
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not installed"
node --version 2>/dev/null
copilot --version 2>/dev/null || /app/node_modules/.bin/copilot --version 2>/dev/null
\`\`\`

List scheduled tasks through the MCP task listing tool. If there are no tasks, report that explicitly.
`,
};