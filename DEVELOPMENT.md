# Develop in an isolated BB profile

The tracked launcher works from any checkout path on macOS with BB installed.
It uses BB's bundled Electron runtime for native module compatibility, clears
inherited `BB_*` context, and directs commands to a separate local profile.
Other platforms need an equivalent isolated BB setup; this launcher does not
claim support for them.

## Start or resume

1. Inspect the profile with `node scripts/bb-dev.mjs status`. If it is already
   running, reuse it. Otherwise start it in a persistent terminal:

   ```sh
   node scripts/bb-dev.mjs start
   ```

2. Install dependencies with `npm ci --include=dev` on a fresh checkout or after
   dependency changes. Check `node --version` first: Node 25.9.0 is the verified
   test runtime. The SQLite native module must be installed using the same Node
   runtime that runs tests. The launcher's Electron runtime is separate.
3. Inspect the development installation:

   ```sh
   node scripts/bb-dev.mjs cli plugin source task-workspace --json
   ```

   If absent or pointing to another checkout, install this checkout:

   ```sh
   node scripts/bb-dev.mjs install --yes
   ```

   `--yes` confirms installation of this checkout into the isolated profile.
   Installation replaces the development source registration while retaining
   its data. Stop an older checkout's watcher before switching sources.

4. Start one watcher in a second persistent terminal:

   ```sh
   node scripts/bb-dev.mjs watch
   ```

   It rebuilds and reloads source changes. Reuse an existing watcher for this
   checkout rather than starting duplicates.

5. Open <http://127.0.0.1:48886/plugins/task-workspace/board>. Confirm the plugin
   is running with `node scripts/bb-dev.mjs cli plugin list --json`.

If a sandbox blocks the launcher or watcher, request the needed execution access
for that command. Keep the target on the development profile.

## Verify a change

Run `npm run verify` for formatting, TypeScript, tests, and all three bundles.
For packaging, dependencies, or releases, also run `npm run verify:distribution`.
Use the same Node runtime as dependency installation. Do not change the pinned
SDK merely to silence a newer BB version's build warning.

Without a watcher, reload a successful build explicitly:

```sh
node scripts/bb-dev.mjs cli plugin reload task-workspace
```

Exercise the changed flow in the development UI. Report automated checks and
live UI verification separately; a successful build does not verify interaction.
Use disposable projects and sample data: enrolling a real repository still lets
agents edit that real repository. A UI test that submits a composer starts a
real conversation. Retry linking a saved thread instead of spawning duplicates.

## Profile and lifecycle

Defaults are data at `~/.bb-task-workspace-dev`, server port `48886`, host daemon
port `48887`, and loopback binding. BB is discovered at `/Applications/bb.app`
or `~/Applications/bb.app`. Runtime data stays outside the checkout to avoid
watcher rebuild loops. The everyday BB profile and release installation remain
separate. Keep development plugin operations behind the launcher.

Use these optional environment variables consistently for every command when
running another isolated profile:

| Variable                  | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `BB_TASK_DEV_APP`         | Absolute path to the BB `.app` bundle                    |
| `BB_TASK_DEV_DATA_DIR`    | Separate data directory outside the checkout and `~/.bb` |
| `BB_TASK_DEV_SERVER_PORT` | Development server port                                  |
| `BB_TASK_DEV_HOST_PORT`   | Development host daemon port                             |

Give simultaneous profiles distinct data directories and port pairs. A profile
has one active Task Workspace source, so two checkouts should not share it while
both are being developed.

Stop the watcher with Ctrl+C. Stop BB with `node scripts/bb-dev.mjs stop` or
Ctrl+C in its start terminal. Restarting preserves the profile's projects, tasks,
and plugin registration. Stop both processes before moving a checkout.
