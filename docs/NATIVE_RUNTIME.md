# Native Runtime Update

## Summary

NanoClaw no longer relies on an external runtime daemon.

- Agents now run as local child processes through `container/agent-runner`.
- `./container/build.sh` rebuilds the local runner instead of creating an image.
- Setup and docs now assume a native host runtime on macOS or Linux.

## What Changed

1. Runtime startup no longer depends on a container daemon.
2. Agent code now executes directly from the checked-out repository.
3. Group state remains isolated by directory layout and session storage, not by a VM or container boundary.
4. Old external-runtime guides and references were removed.

## Usage

### Initial setup

```bash
npm install
./container/build.sh
npx tsx setup/index.ts --step environment
```

Or start `copilot` and run `/setup` for the guided flow.

### Rebuild after runtime changes

```bash
./container/build.sh
npm run build
```

### Service lifecycle

macOS:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux:

```bash
systemctl --user restart nanoclaw
```

### Local CLI

The `claw` utility now starts the local runner directly. It no longer needs a runtime selector or image tag.

## Migration Notes

If you previously relied on the old runtime behavior, review these assumptions:

1. Bash now runs on the host.
2. There is no image boundary separating agent dependencies from host dependencies.
3. Browser or CLI tools required by skills must be installed on the host machine.
4. Security guidance should be read as host-process guidance, not container guidance.

## Optimization Suggestions

1. Add per-group tool restrictions, especially for Bash.
2. Introduce an opt-in external sandbox wrapper for high-risk deployments.
3. Split trusted and untrusted channels into separate runtime policies.
4. Cache skill mirroring more aggressively to reduce cold-start overhead.
5. Add a dedicated native smoke test to CI for `container/agent-runner`.