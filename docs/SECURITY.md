# NanoClaw Security Model

NanoClaw now runs its agent as a local child process on the host. Some path names such as `container/` and `AGENTS.md` remain for compatibility, but they no longer imply container isolation.

## Bottom Line

NanoClaw is easier to inspect than a sprawling automation stack, but the native runner is **not** an OS sandbox.

- The main trust boundary is now between trusted and untrusted chats.
- Agents can run host commands if the runtime grants them permission.
- Mount allowlists, scoped working directories, and IPC authorization still reduce accidental overreach.
- You should treat NanoClaw like any other local coding agent with automation privileges.

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Should be trusted | They share the same host runtime model |
| Agent runner | Privileged local process | Executes on the host |
| Incoming messages | Untrusted input | Potential prompt injection |

## Security Controls That Still Apply

### 1. Group-Scoped Runtime Directories

Each group gets separate runtime paths under `groups/`, `data/ipc/`, and `data/sessions/`.

- Session history is isolated per group.
- Working files stay grouped by folder.
- IPC files are namespaced by group.

### 2. Mount Allowlist

Additional directory access is controlled by `~/.config/nanoclaw/mount-allowlist.json`.

- The allowlist lives outside the repo.
- Symlinks are resolved before validation.
- Blocked patterns still reject sensitive paths such as `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.env`, and private keys.
- Non-main groups can still be forced read-only through `nonMainReadOnly`.

### 3. IPC Authorization

Messages and task operations are still checked against group identity.

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 4. Credential Handling

Credentials are resolved on the host side.

- OneCLI remains the preferred integration path when configured.
- Local `.env` values may also be forwarded into the runner when present.
- Secrets are no longer protected by a separate container boundary.

## What Changed With Native Execution

The following protections no longer exist:

- No container or VM boundary between the agent and the host.
- No image-level filesystem isolation.
- No daemon-managed ephemeral runtime that resets on each launch.

That means prompt injection and unsafe tool approval have a higher potential impact than before.

## Recommended Operating Model

Use NanoClaw this way if you want the current native setup to stay safe enough in practice:

1. Keep the main group private.
2. Only connect trusted chats to groups with write access.
3. Review mount allowlists carefully.
4. Avoid giving broad project-root access to mixed-trust groups.
5. Prefer read-only additional mounts for anything not strictly required.
6. Review skill changes before applying them.

## Future Hardening Directions

- Restrict Bash for non-main groups.
- Add per-group tool policies.
- Add an opt-in external sandbox wrapper for high-risk deployments.
- Separate credential scopes between groups.
