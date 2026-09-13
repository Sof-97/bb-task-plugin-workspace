# Task workspace

A BB plugin for managing tasks across your projects. It enrols existing GitButler
projects and gives them a cross-project task board with durable external
Markdown memory, explicit repository preparation, linked BB conversations with
exactly three narrow agent tools, a read-only local Wayfinder map reader,
seven successful daily local backups with whole-dataset restore, and a token-authenticated
versioned quick-capture HTTP interface.

The plugin is the repository root with plugin id `task-workspace`
(package `bb-plugin-task-workspace`). Enrollment, board workflow, external memory, thread links, composer
starts, Wayfinder, backup/export, restore and capture are implemented and
exercised by the automated gate below. Capture creates no branch, thread or
repository content.

## Verified runtime

- BB CLI/host **0.42.1**; GitButler **0.22.3**.
- Node **25.9.0** (Homebrew, `better-sqlite3` ABI 141), npm **11.12.1**.
- SDK `@get-bb/plugin-sdk` **0.4.47** exact (package and running host match).
- TypeScript 5.9.3, better-sqlite3 12.11.1, Vitest 4.1.11, Prettier 3.9.6.

## Install from GitHub

Requires BB >= 0.42 with plugin SDK >= 0.4.47, Git and npm available to BB,
and GitButler on the host for repository preparation. The verified host is macOS.

Once this repository is published:

```sh
bb plugin install https://github.com/Sof-97/bb-task-plugin-workspace
```

This tracks the repository's default branch. For the first tagged release,
after `v0.1.0` has been published:

```sh
bb plugin install 'git:https://github.com/Sof-97/bb-task-plugin-workspace.git@^0.1.0'
bb plugin update task-workspace
```

Choose one install source. BB installs production dependencies and builds the
server, app and host bundles itself. No committed `dist/`, npm publication or
marketplace listing is required. See [RELEASING.md](RELEASING.md).

## Local development and recovery

Use Node 25.9.0 for the previously verified native test runtime. If changing
Node versions, run a fresh `npm ci` so SQLite uses the correct ABI.

```sh
npm ci --include=dev
bb plugin types --check .
npm run verify
npm run verify:distribution
bb plugin install .
bb plugin reload task-workspace
```

- **Update** a local path install in place: edit sources, `npm run build`, then
  `bb plugin reload task-workspace`. `bb plugin update` applies only to managed
  git/npm sources; a local path install keeps its data and is never removed to
  change it.
- **Status**: `bb plugin list --json` shows enabled/running, bundle hash and SDK
  compatibility. `bb plugin source task-workspace --json` shows its resolved
  source and history.
- **Logs**: `bb plugin logs task-workspace -n 200`.
- **Disable/enable without deleting data**: `bb plugin disable task-workspace` /
  `bb plugin enable task-workspace`.
- **Data locations**: `~/.bb/plugins/task-workspace/` holds the WAL database
  `data.db`, `host-data/datasets/<dataset-id>/memory/<task-id>.md` (canonical
  memory), `host-data/datasets/<dataset-id>/archives/` (managed daily and recovery archives).
  Manual exports use a separately chosen path outside the managed archive directories.
  **Never copy the live WAL database as a backup.**
- **Back up / recover**: use _Export task data_ on the board for a
  human-chosen-path archive, and the daily automatic archive for the managed
  seven-file retention. Restore is in the board header: it validates schema,
  relationships, paths and SHA-256 hashes, stages memory under a fresh dataset
  directory, switches the active dataset in one transaction and issues a fresh
  epoch. Restore never replays a thread start, send or capture; incomplete
  restored starts and captures are quarantined for explicit human review.
- **Full removal** (deletes the plugin's settings, secrets and schedules; local
  path source files stay on disk): `bb plugin remove task-workspace`.

## Quick capture HTTP interface (v1)

Token-authenticated routes beneath `/api/v1/plugins/task-workspace/http/`.
No agent capture tool is exposed; the SDK token header is the only credential
transport and query credentials are rejected with 401.

| Operation                 | Contract                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET capture/v1/projects` | `apiVersion: 1`, opaque `datasetEpoch`, and `projects`: enrollment ID, BB project ID, name, fixed prefix, `available`, nullable `unavailableReason`. Enrollment data only.                                    |
| `POST capture/v1/tasks`   | JSON `requestId` (client UUID), `datasetEpoch`, `projectId`, `title`, optional `description`. No caller task ID/status/branch/attribution.                                                                    |
| Accepted                  | HTTP 201 first creation, 200 replay. Returns `apiVersion`, `datasetEpoch`, `requestId`, `replayed` and the immutable creation receipt (`taskUuid`, `displayId`, `projectId`, `status: "Inbox"`, `createdAt`). |
| Error                     | JSON `error` with stable `code`, plain `message`, optional `field`, `retryable`, and `requestId` when valid. Never echoes tokens or submitted content.                                                        |

Bounds: 80 KiB body, 300 Unicode-code-point single-line title, 64 KiB UTF-8
Markdown description.

**Read projects and the current epoch without printing the token:**

```sh
TOKEN="$(bb plugin token task-workspace)"   # short-lived; do not log or export it
curl -sS "http://127.0.0.1:38886/api/v1/plugins/task-workspace/http/capture/v1/projects" \
  -H "x-bb-plugin-token: $TOKEN"
```

**Exact retry example (no credentials in the payload).** Generate one
`requestId` per explicit submission, capture the returned `datasetEpoch` and
`projectId`, and reuse the identical JSON body on every retry:

```sh
REQUEST_ID="$(uuidgen | tr 'A-Z' 'a-z')"
EPOCH="<datasetEpoch from GET capture/v1/projects>"
PROJECT_ID="<projectId from GET capture/v1/projects>"
BODY="{\"requestId\":\"$REQUEST_ID\",\"datasetEpoch\":\"$EPOCH\",\"projectId\":\"$PROJECT_ID\",\"title\":\"Captured task\",\"description\":\"Optional Markdown\"}"

# First attempt (201). Every explicit retry sends these exact same bytes.
curl -sS -X POST "http://127.0.0.1:38886/api/v1/plugins/task-workspace/http/capture/v1/tasks" \
  -H "content-type: application/json" \
  -H "x-bb-plugin-token: $TOKEN" \
  --data "$BODY"
```

A lost response never authorizes a new request ID. Identical content replays the
original creation receipt (`200`); changed content under the same ID is
`409 REQUEST_ID_CONFLICT` and changes nothing. After a restore, an old epoch is
`409 DATASET_CHANGED` — refresh discovery and resubmit deliberately with a new
ID and the current epoch. Incomplete initialization is `503 CAPTURE_PENDING`;
retry the same identity. A confirmed-missing project is `409
PROJECT_UNAVAILABLE`/`PROJECT_NOT_ENROLLED`, a temporary lookup failure is
retryable `503`, and a bad token is `401`.

## Checks

```sh
export PATH=/opt/homebrew/bin:$PATH   # Node 25.9.0 for the better-sqlite3 ABI
npm run verify          # prettier check, tsc, vitest, server/app/host builds
npm run test            # vitest only
bb plugin types --check .
bb plugin reload task-workspace
```

`npm run verify` is the single settled gate: formatting, strict TypeScript, the
full Vitest suite and the three plugin builds. Tests
use the official backend harness with real SQLite, the host-entry harness with
real temporary files, a disposable GitButler repository and the official app
harness.

## Architecture and boundaries

Task memory is canonical external UTF-8 Markdown; SQLite stores only hashes,
revisions, attribution, operation identity and recovery state. Structured reads
and human saves use independent dataset-epoch, memory-revision and content-hash
tokens. Same-content saves are no-ops; stale or externally changed bytes stay
visible until an explicit accept-external or verified restore-known action.

Human mutations are admitted through one maintenance coordinator that drains
in-flight work before backup and rejects restore overlap. Capture dedup is a
durable `(datasetEpoch, requestId)` key written in the same transaction as the
task row, number and pending memory initialization.

The three narrow linked-task agent tools (`task_workspace_read_current_task`,
`task_workspace_save_memory`, `task_workspace_ready_for_agent_review`) derive
task, destination and attribution from the trusted thread context and durable
link, never from caller-supplied task IDs. Only `In progress` →
`Ready for agent review` is agent-mutable.

## Evidence and limitations

- **Installed host runtime:** enrollment and quick capture over the real HTTP
  contract, board workflow, repository preparation, native composer/thread
  tools, Wayfinder host reads, daily/manual backup and staged restore with a
  fresh epoch. Final installed probes also cover capture replay against missing
  or changed memory and a quarantined capture archive surviving a second restore.
- **Deterministic harness only:** crash/race boundaries, fsync/durability
  ordering, watcher-generation races, duplicate simultaneous captures, restore
  interruption and concurrent races.
- **Not automatically demonstrated:** the installed webview's visual layout,
  real browser history/back-forward and absence of network fetches. Native
  computer-use access to the BB app was repeatedly denied, so the synthetic app
  harness is not claimed as proof of installed webview behavior.
- Durability claims stop at the tested application boundary (no power-loss
  hardware proof), and standard Node rename is not a hash CAS against an
  arbitrary independent filesystem writer.
- Same-machine archives only; no cloud backup, cross-machine synchronization,
  Raycast client, remote publication or marketplace submission.

**Bounded manual check (requires the BB window; not provable from an agent):**
open `/plugins/task-workspace/board`, confirm wide columns and horizontal
scrolling plus the narrow-window drawer, keyboard access and Escape/back
navigation, Markdown rendering with no remote images, two task drawers keeping
independent selection, reconnect draft retention, and the system browser
back/forward buttons reflecting board navigation. The earlier user check
("Ok everything seems fine") covered the slice-01 board/drawer/capture/reload
surface only.

Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE), copyright 2026 Gerardo Calia. Third-party components retain
their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
