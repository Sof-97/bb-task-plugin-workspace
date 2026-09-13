# Releasing Task Workspace

The repository root is a single BB plugin. `package.json` declares its identity,
compatibility and server/app/host entry points. A `.bb/plugins.json` collection
index is only needed for a repository containing multiple plugins.

Distribution follows the [official BB documentation](https://github.com/get-bb/bb/blob/main/docs/configuration.md#plugins).
Git installs omit development and optional dependencies, disable lifecycle
scripts, and build the declared source entries. Keep non-shimmed runtime imports
in `dependencies`; BB-provided runtime packages and test tools belong in
`devDependencies`. The SDK pin matches BB 0.42.1 / SDK 0.4.47.
Frontend task statuses live in `task-status.ts` so the app does not pull in the
backend RPC contract and its root SDK runtime import.

## Validate a release

```sh
npm ci --include=dev
bb plugin types --check .
npm run verify
npm run verify:distribution
```

The distribution check copies publishable working-tree files into a fresh
temporary directory, installs production dependencies without lifecycle scripts,
and builds all three bundles. It never installs or reloads the active plugin.
This checks packaging, not activation on a different user's machine.

## First GitHub publication

The intended destination is `Sof-97/bb-task-plugin-workspace`. If the repository
name changes, update the package repository/homepage/bugs fields and README URLs.

Commit source, tests, lockfile, documentation and the release check. Generated
bundles, dependencies, credentials, databases and local evidence are ignored.
The first public release uses a clean initial snapshot with a single initial
commit. The original development history and local planning/evidence remain in
the private development checkout and are not part of the public repository.

The project is licensed under MIT; include `LICENSE` and
`THIRD_PARTY_NOTICES.md` in every release.

Create the GitHub repository, commit the prepared tree and publish the branch
using GitButler. The bare repository URL in the README follows the default
branch, regardless of its name. Set `package.json` and lockfile to the release
version and publish the matching immutable `vX.Y.Z` tag (first: `v0.1.0`).
Never move an existing release tag: BB records the tag's commit and rejects
retagged releases. Publish fixes under a new version.

`private: true` prevents accidental npm publication; it does not prevent BB
from installing this plugin from GitHub. An npm release needs its own packaged
artifact validation and is not part of this Git distribution setup.

## Consumer check after publication

On a separate BB profile or machine:

```sh
bb plugin install 'git:https://github.com/Sof-97/bb-task-plugin-workspace.git@^0.1.0'
bb plugin list --json
bb plugin logs task-workspace -n 100
```

Check the board, enrollment, task creation, memory editing and a linked thread.
Use `bb plugin update task-workspace` for subsequent compatible releases.
Marketplace listing is a separate optional publication step.
