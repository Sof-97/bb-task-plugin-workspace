import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  enrollment,
  task,
  rpcContract,
  hostContract,
  hostSignals,
  memoryToken,
  startOperation,
  wayfinderAttachment,
  wayfinderGraph,
  type Enrollment,
  type LinkedThread,
  type MemoryToken,
  type MemoryView,
  type RepositoryObservation,
  type RepositoryPreparation,
  type StartOperation,
  type NewThreadRequestPayload,
  type WayfinderAttachment,
} from "./contract";
import { createMemoryCoordinator, EMPTY_MEMORY_HASH } from "./memory";
import { readWayfinderSnapshot } from "./wayfinder-reader";
import {
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVE_FORBIDDEN_TABLE_PATTERN,
  ARCHIVE_TABLE_NAME_PATTERN,
  canonicalJson,
  encodeArchive,
  validateArchive,
  type ArchiveMemory,
  type ArchiveTable,
} from "./archive";
import { MaintenanceCoordinator } from "./maintenance";
import {
  planStagedRestore,
  restoreTableName,
  stageRestore,
  RESTORE_RECOVERY_STATEMENTS,
  RESTORE_CAPTURE_QUARANTINE,
  RESTORE_TABLE_ORDER,
  type RestoredDatasetIdentity,
  type RestoreRecordSchema,
  type StagedRestorePlan,
} from "./restore";
import {
  CAPTURE_API_VERSION,
  CaptureHttpError,
  captureErrorBody,
  capturePayloadHash,
  parseCaptureReceipt,
  readCaptureSubmission,
  type CaptureAcceptedResult,
  type CaptureReceipt,
  type CaptureSubmission,
} from "./capture";
export { rpcContract } from "./contract";

export type StartFailurePoint =
  | "before-prepared"
  | "persist-dispatching"
  | "after-dispatching"
  | "after-spawn-before-thread-id"
  | "after-awaiting-link"
  | "link-final-transaction";
export type RestoreFailurePoint =
  "after-protective" | "after-stage" | "before-commit" | "after-commit";
export type TaskWorkspaceTestHooks = {
  failStartAt?: (point: StartFailurePoint) => void;
  failRestoreAt?: (point: RestoreFailurePoint) => void;
  /** Deterministic drain for fired-and-forgotten daily backup attempts. */
  onDailyAttempt?: (attempt: Promise<unknown>) => void;
  /** Deterministic gate at the start of admitted capture discovery. */
  captureDiscoveryGate?: () => Promise<void> | void;
};

const ARCHIVE_TABLES_BY_SCHEMA = [
  [] as string[],
  ["dataset"],
  ["dataset", "enrollments"],
  ["dataset", "enrollments", "tasks"],
  ["dataset", "enrollments", "tasks", "pending_operations"],
  [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
  ],
  [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
    "repository_workspaces",
  ],
  [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
    "repository_workspaces",
    "memory_operations",
    "memory_operation_ids",
  ],
  [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
    "repository_workspaces",
    "memory_operations",
    "memory_operation_ids",
    "thread_links",
  ],
  [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
    "repository_workspaces",
    "memory_operations",
    "memory_operation_ids",
    "thread_links",
    "thread_start_operations",
  ],
  [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
    "repository_workspaces",
    "memory_operations",
    "memory_operation_ids",
    "thread_links",
    "thread_start_operations",
    "wayfinder_attachments",
  ],
  [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
    "repository_workspaces",
    "memory_operations",
    "memory_operation_ids",
    "thread_links",
    "thread_start_operations",
    "wayfinder_attachments",
    "capture_requests",
  ],
] as const;

/** Safely quote an arbitrary SQLite identifier for interpolation. */
function quoteSqlIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

function selectTableRows(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  name: string,
) {
  return db
    .prepare(`SELECT * FROM ${quoteSqlIdentifier(name)} ORDER BY rowid`)
    .all() as ArchiveTable["rows"];
}

function logicalArchiveTables(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  schemaVersion: number,
  recoveryOnly = false,
): { tables: ArchiveTable[]; diagnostics: string[] } {
  const known = ARCHIVE_TABLES_BY_SCHEMA[schemaVersion];
  if (!known)
    throw new Error(
      `No logical snapshot adapter exists for schema ${schemaVersion}.`,
    );
  const actual = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const allowed = new Set(["_bb_migrations", ...known]);
  if (!recoveryOnly) {
    const unknown = actual.filter((name) => !allowed.has(name));
    if (unknown.length)
      throw new Error(
        `Logical snapshot adapter does not classify tables: ${unknown.join(", ")}.`,
      );
    for (const name of known)
      if (!actual.includes(name))
        throw new Error(`Expected schema table ${name} is missing.`);
    const selected = actual.filter((name) => allowed.has(name));
    return {
      tables: selected.map((name) => ({
        name: name === "_bb_migrations" ? "bb_migrations" : name,
        classification: "canonical" as ArchiveTable["classification"],
        rows: selectTableRows(db, name),
      })),
      diagnostics: [],
    };
  }
  // Recovery-only: enumerate and read every eligible table independently so
  // one unreadable or unsupported table cannot discard the other records.
  const diagnostics: string[] = [];
  const tables: ArchiveTable[] = [];
  const exportName = (name: string) =>
    name === "_bb_migrations" ? "bb_migrations" : name;
  for (const name of [...new Set([...allowed, ...actual])].sort()) {
    if (!actual.includes(name)) continue;
    const exported = exportName(name);
    if (ARCHIVE_FORBIDDEN_TABLE_PATTERN.test(exported)) {
      diagnostics.push(
        `Table ${exported} is excluded by the archive secret-content policy.`,
      );
      continue;
    }
    if (!ARCHIVE_TABLE_NAME_PATTERN.test(exported)) {
      diagnostics.push(
        `Table ${JSON.stringify(name)} has an unsupported name and was excluded.`,
      );
      continue;
    }
    try {
      tables.push({
        name: exported,
        classification: (allowed.has(name)
          ? "canonical"
          : "unknown-recovery-only") as ArchiveTable["classification"],
        rows: selectTableRows(db, name),
      });
    } catch (error) {
      diagnostics.push(
        `Table ${exported} could not be read: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      );
    }
  }
  for (const name of known)
    if (!actual.includes(name))
      diagnostics.push(`Expected schema table ${name} is missing.`);
  return { tables, diagnostics };
}

const DURABLE_MIGRATIONS = [
  `CREATE TABLE dataset (id TEXT PRIMARY KEY, hostId TEXT);`,
  `CREATE TABLE enrollments (id TEXT PRIMARY KEY, projectId TEXT NOT NULL UNIQUE, hostId TEXT NOT NULL, repository TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE, nextNumber INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);`,
  `CREATE TABLE tasks (id TEXT PRIMARY KEY, enrollmentId TEXT NOT NULL REFERENCES enrollments(id), number INTEGER NOT NULL, displayId TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL CHECK(status='Inbox'), revision INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, attribution TEXT NOT NULL, memoryState TEXT NOT NULL, memoryError TEXT, memoryHash TEXT, memoryRevision INTEGER NOT NULL DEFAULT 0, UNIQUE(enrollmentId,number));`,
  `CREATE TABLE pending_operations (id TEXT PRIMARY KEY, taskId TEXT NOT NULL UNIQUE REFERENCES tasks(id), kind TEXT NOT NULL, state TEXT NOT NULL, intendedHash TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, attribution TEXT NOT NULL, error TEXT);`,
  `ALTER TABLE tasks ADD COLUMN workflowStatus TEXT NOT NULL DEFAULT 'Inbox';
ALTER TABLE tasks ADD COLUMN blockerReason TEXT;
ALTER TABLE tasks ADD COLUMN attributionAt TEXT NOT NULL DEFAULT '';
UPDATE tasks SET attributionAt=updatedAt WHERE attributionAt='';
CREATE TABLE task_relationships (taskId TEXT NOT NULL REFERENCES tasks(id), targetTaskId TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL CHECK(kind IN ('depends-on','blocker-reference')), PRIMARY KEY(taskId,targetTaskId,kind), CHECK(taskId<>targetTaskId));
CREATE TABLE attached_paths (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), hostId TEXT NOT NULL, path TEXT NOT NULL, label TEXT, position INTEGER NOT NULL, UNIQUE(taskId,position));`,
  `CREATE TABLE repository_workspaces (taskId TEXT PRIMARY KEY REFERENCES tasks(id), projectId TEXT NOT NULL, hostId TEXT NOT NULL, repository TEXT NOT NULL, environmentId TEXT, branchName TEXT, parentBranchName TEXT, preparedAt TEXT, revision INTEGER NOT NULL DEFAULT 1, updatedAt TEXT NOT NULL);
INSERT INTO repository_workspaces(taskId,projectId,hostId,repository,updatedAt)
SELECT tasks.id,enrollments.projectId,enrollments.hostId,enrollments.repository,tasks.updatedAt
FROM tasks JOIN enrollments ON enrollments.id=tasks.enrollmentId;`,
  `ALTER TABLE tasks ADD COLUMN memoryAttributionKind TEXT NOT NULL DEFAULT 'initialization';
ALTER TABLE tasks ADD COLUMN memoryAttributionRoute TEXT NOT NULL DEFAULT 'legacy:initialization';
ALTER TABLE tasks ADD COLUMN memoryAttributionThreadId TEXT;
ALTER TABLE tasks ADD COLUMN memoryAttributionSessionId TEXT;
ALTER TABLE tasks ADD COLUMN memoryAttributionAt TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN memoryLatestOperationId TEXT;
CREATE TABLE memory_operations (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK(kind IN ('initialize-memory','save','accept-external','restore-known')),
  state TEXT NOT NULL CHECK(state IN ('prepared','accepted','not-applied','conflict','resolved')),
  datasetEpoch TEXT NOT NULL,
  oldRevision INTEGER NOT NULL,
  oldHash TEXT,
  expectedActualHash TEXT,
  intendedHash TEXT NOT NULL,
  expectedThreadId TEXT,
  expectedLinkRevision INTEGER,
  attributionKind TEXT NOT NULL,
  attributionRoute TEXT NOT NULL,
  attributionThreadId TEXT,
  attributionSessionId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  resultJson TEXT,
  error TEXT
);
CREATE TABLE memory_operation_ids (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  kind TEXT NOT NULL,
  intendedHash TEXT NOT NULL
);
CREATE UNIQUE INDEX one_prepared_memory_operation_per_task ON memory_operations(taskId) WHERE state='prepared';
INSERT OR IGNORE INTO memory_operations(
  id,taskId,kind,state,datasetEpoch,oldRevision,oldHash,expectedActualHash,
  intendedHash,attributionKind,attributionRoute,createdAt,updatedAt,error)
SELECT pending_operations.id,pending_operations.taskId,'initialize-memory',pending_operations.state,
  dataset.id,0,NULL,NULL,pending_operations.intendedHash,'initialization',pending_operations.attribution,
  pending_operations.createdAt,pending_operations.updatedAt,pending_operations.error
FROM pending_operations CROSS JOIN dataset;
INSERT OR IGNORE INTO memory_operation_ids(id,taskId,kind,intendedHash)
SELECT id,taskId,kind,intendedHash FROM memory_operations;`,
  `ALTER TABLE memory_operations ADD COLUMN expectedProjectId TEXT;
CREATE TABLE thread_links (
  threadId TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  linkRevision INTEGER NOT NULL CHECK(linkRevision > 0),
  linkedAt TEXT NOT NULL,
  lastKnownTitle TEXT,
  lastKnownProjectId TEXT NOT NULL,
  lastKnownEnvironmentId TEXT,
  lastKnownHostId TEXT,
  availability TEXT NOT NULL CHECK(availability IN ('available','archived','missing','unavailable')),
  runtimeStatus TEXT CHECK(runtimeStatus IN ('active','error','idle','pending','starting','stopping')),
  environmentMismatch TEXT,
  message TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX thread_links_by_task ON thread_links(taskId,linkedAt,threadId);`,
  `CREATE TABLE thread_start_operations (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','awaiting-link','linked','failed-before-dispatch','uncertain')),
  datasetEpoch TEXT NOT NULL,
  taskRevision INTEGER NOT NULL,
  linkContextJson TEXT NOT NULL,
  projectId TEXT NOT NULL,
  environmentJson TEXT NOT NULL,
  hostId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoningLevel TEXT NOT NULL,
  serviceTier TEXT,
  permissionMode TEXT NOT NULL,
  executionInputSourcesJson TEXT NOT NULL,
  sendAt INTEGER,
  inputDigest TEXT NOT NULL,
  requestDigest TEXT NOT NULL,
  memoryRevision INTEGER NOT NULL,
  memoryHash TEXT NOT NULL,
  threadId TEXT,
  error TEXT,
  abandonedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX one_live_thread_start_per_task ON thread_start_operations(taskId)
WHERE abandonedAt IS NULL AND state<>'linked';
CREATE INDEX thread_start_operations_by_task ON thread_start_operations(taskId,createdAt,id);`,
  `CREATE TABLE wayfinder_attachments (
  taskId TEXT PRIMARY KEY REFERENCES tasks(id),
  projectId TEXT NOT NULL,
  hostId TEXT NOT NULL,
  repository TEXT NOT NULL,
  mapPath TEXT NOT NULL,
  selectedDirectory TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  updatedAt TEXT NOT NULL
);`,
  `CREATE TABLE capture_requests (
  datasetEpoch TEXT NOT NULL,
  requestId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  payloadHash TEXT NOT NULL CHECK(length(payloadHash)=64),
  taskId TEXT NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN ('allocated','accepted','recovery-required')),
  receiptJson TEXT,
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY(datasetEpoch,requestId)
);
CREATE INDEX capture_requests_by_task ON capture_requests(taskId);
CREATE INDEX capture_requests_by_epoch ON capture_requests(datasetEpoch,updatedAt);`,
];

/**
 * Derive the live record-table column shape from `PRAGMA table_info` so the
 * archive validator and the staged database always agree with the installed
 * schema instead of a hand-maintained column list that can drift.
 */
function liveRecordSchema(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
): RestoreRecordSchema {
  const schema: RestoreRecordSchema = {};
  for (const name of RESTORE_TABLE_ORDER) {
    if (name === "bb_migrations") continue;
    const actual = restoreTableName(name);
    let info: Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;
    try {
      info = db
        .prepare(`PRAGMA table_info(${quoteSqlIdentifier(actual)})`)
        .all() as typeof info;
    } catch {
      continue;
    }
    schema[name] = {
      columns: info.map((column) => column.name),
      required: info
        .filter(
          (column) =>
            (column.notnull === 1 || column.pk === 1) &&
            column.dflt_value === null,
        )
        .map((column) => column.name),
    };
  }
  return schema;
}

type StagingDatabase = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => { changes: number };
  };
  exec: (sql: string) => unknown;
  pragma: (sql: string, options?: unknown) => unknown;
  close: () => void;
};

/**
 * Create an isolated in-memory SQLite database for staged restore validation.
 * It shares the live connection's driver but is a separate database file, so
 * constraint checking never touches the active dataset before the switch.
 */
function createStagingDatabase(
  live: ReturnType<BbPluginApi["storage"]["database"]>,
): StagingDatabase {
  const Ctor = live.constructor as unknown as new (
    path: string,
  ) => StagingDatabase;
  const staging = new Ctor(":memory:");
  staging.pragma("foreign_keys = ON");
  return staging;
}
export default async function plugin(
  bb: BbPluginApi,
  testHooks: TaskWorkspaceTestHooks = {},
) {
  const db = bb.storage.database();
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  if (
    db.pragma("journal_mode", { simple: true }) !== "wal" ||
    db.pragma("synchronous", { simple: true }) !== 2
  )
    throw new Error(
      "Task Workspace requires WAL journal mode and FULL SQLite synchronization on its plugin-owned connection.",
    );
  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });
  const maintenance = new MaintenanceCoordinator();
  // Protective recovery seam with fail-closed ledger verification: before
  // any pending migration is applied, the installed database state is
  // positively classified. A verified fresh database (no user tables, no
  // ledger) proceeds. An existing schema whose ledger, dataset identity or
  // protective capture cannot be verified refuses the migration outright —
  // there is no silent bypass for damaged or unclassifiable databases.
  type StartupLedger =
    | { kind: "verified-fresh" }
    | { kind: "applied"; count: number }
    | { kind: "refuse"; reason: string };
  const startupLedger: StartupLedger = await (async () => {
    let userTables: string[];
    try {
      userTables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
    } catch (error) {
      return {
        kind: "refuse",
        reason: `The plugin database could not be inspected: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      };
    }
    const hasLedger = userTables.includes("_bb_migrations");
    if (!hasLedger) {
      if (userTables.length === 0) return { kind: "verified-fresh" };
      return {
        kind: "refuse",
        reason:
          "The plugin database contains records without a migration ledger; refusing to migrate an unknown schema.",
      };
    }
    let count: number;
    try {
      count = (
        db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
          count: number;
        }
      ).count;
    } catch (error) {
      return {
        kind: "refuse",
        reason: `The migration ledger could not be read: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      };
    }
    if (count > DURABLE_MIGRATIONS.length)
      return {
        kind: "refuse",
        reason: `The installed schema (${count}) is newer than this plugin (${DURABLE_MIGRATIONS.length}); a newer release owns this data.`,
      };
    return { kind: "applied", count };
  })();
  if (startupLedger.kind === "refuse")
    throw new Error(
      `Task Workspace startup refused; no migration was applied. ${startupLedger.reason}`,
    );
  const refuseMigration = (reason: string): never => {
    throw new Error(
      `Task Workspace startup refused; no migration was applied. ${reason}`,
    );
  };
  // Fail-closed pre-migration protective capture. Before any pending
  // migration step is applied to an existing dataset, a complete, verified
  // archive of the installed schema is published at its current version.
  // A missing dataset identity/host, incoherent relationships, unresolved
  // memory metadata or a capture that cannot be verified refuses the
  // migration outright. Additive or destructive, the dataset is never
  // migrated without a durable protective copy first.
  if (
    startupLedger.kind === "applied" &&
    startupLedger.count > 0 &&
    startupLedger.count < DURABLE_MIGRATIONS.length
  ) {
    const datasetRow = (() => {
      try {
        return db.prepare("SELECT * FROM dataset").get() as
          { id: string; hostId: string | null } | undefined;
      } catch (error) {
        refuseMigration(
          `The dataset identity could not be read from the existing schema: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
        );
      }
    })();
    if (!datasetRow)
      refuseMigration(
        "The existing schema has no dataset identity; a protective archive is not possible.",
      );
    if (!datasetRow!.hostId)
      refuseMigration(
        "The existing schema has no enrolled host; canonical memory cannot be read for a verified protective archive.",
      );
    const datasetIdentity = {
      datasetId: datasetRow!.id,
      hostId: datasetRow!.hostId as string,
    };
    try {
      // Transactional structured snapshot with relationship and pending-state
      // validation, followed by bounded memory reads and a full recheck.
      const snapshot = db.transaction(() => {
        const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeys.length)
          throw new Error(
            "SQLite relationship validation failed; the protective archive would not be coherent.",
          );
        if (
          db
            .prepare(
              "SELECT 1 FROM memory_operations WHERE state='prepared' LIMIT 1",
            )
            .get()
        )
          throw new Error(
            "A memory operation remains prepared; the protective capture would be incoherent.",
          );
        const rows = db
          .prepare(
            "SELECT t.id AS id,t.displayId AS displayId,t.memoryHash AS memoryHash,t.memoryRevision AS memoryRevision,t.memoryState AS memoryState,e.hostId AS hostId FROM tasks t JOIN enrollments e ON e.id=t.enrollmentId ORDER BY t.id",
          )
          .all() as Array<{
          id: string;
          displayId: string;
          memoryHash: string | null;
          memoryRevision: number;
          memoryState: string;
          hostId: string;
        }>;
        return {
          rows,
          tables: logicalArchiveTables(db, startupLedger.count).tables,
        };
      })();
      const readProtectedMemory = async (
        item: (typeof snapshot.rows)[number],
      ) => {
        if (
          item.memoryRevision < 1 ||
          item.memoryState !== "healthy" ||
          !item.memoryHash
        )
          throw new Error(
            `Task ${item.displayId} has unresolved canonical memory metadata; the protective archive would be incomplete.`,
          );
        const observed = await host.call(
          "readMemory",
          {
            dataset: datasetIdentity.datasetId,
            taskId: item.id,
          },
          { hostId: item.hostId },
        );
        if (observed.state !== "present" || observed.hash !== item.memoryHash)
          throw new Error(
            `Task ${item.displayId} memory is missing or does not match committed metadata.`,
          );
        const bytes = Buffer.from(observed.bytesBase64, "base64");
        if (createHash("sha256").update(bytes).digest("hex") !== observed.hash)
          throw new Error(
            `Task ${item.displayId} memory bytes failed verification.`,
          );
        return bytes;
      };
      const memories: ArchiveMemory[] = [];
      const firstPass = new Map<string, string>();
      for (const item of snapshot.rows) {
        const bytes = await readProtectedMemory(item);
        firstPass.set(item.id, bytes.toString("base64"));
        memories.push({ taskId: item.id, bytes });
      }
      // Bounded recheck: an external change between the reads invalidates the
      // protective attempt and refuses the migration.
      for (const item of snapshot.rows) {
        const bytes = await readProtectedMemory(item);
        if (bytes.toString("base64") !== firstPass.get(item.id))
          throw new Error(
            `Task ${item.displayId} memory changed while the protective archive was captured.`,
          );
      }
      const clock = await host.call(
        "archiveStatus",
        {
          dataset: datasetIdentity.datasetId,
          hostId: datasetIdentity.hostId,
        },
        { hostId: datasetIdentity.hostId },
      );
      const archive = encodeArchive({
        archiveKind: "complete",
        schemaVersion: startupLedger.count,
        createdAt: clock.observedAt,
        localDay: clock.localDay,
        source: datasetIdentity,
        diagnostics: [],
        extensions: {
          adapter: "task-workspace-logical/v1",
          purpose: "pre-migration-protective",
        },
        tables: snapshot.tables,
        memories,
      });
      const published = await host.call(
        "publishArchive",
        {
          dataset: datasetIdentity.datasetId,
          hostId: datasetIdentity.hostId,
          kind: "protective",
          archiveBase64: Buffer.from(archive).toString("base64"),
          destination: null,
        },
        { hostId: datasetIdentity.hostId },
      );
      if (published.state === "degraded")
        throw new Error(
          `Protective pre-migration archive was not confirmed healthy: ${published.error ?? "unknown error"}`,
        );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      throw new Error(
        `Refusing to apply pending migrations: the protective archive of the installed dataset could not be created or verified. ${message}`,
      );
    }
  }
  bb.storage.migrate(db, [...DURABLE_MIGRATIONS]);

  const recoveredAt = new Date().toISOString();
  db.prepare(
    `UPDATE thread_start_operations
     SET state='uncertain',
         error='Plugin restarted after dispatch was recorded. BB spawn or its first message may have occurred; no external effect will be replayed automatically.',
         updatedAt=?
     WHERE state='dispatching'`,
  ).run(recoveredAt);
  db.prepare(
    `UPDATE thread_start_operations
     SET state='failed-before-dispatch',
         error='Plugin restarted from a prepared operation. Dispatch was never recorded and no external effect will be replayed automatically; abandon before a new attempt.',
         updatedAt=?
     WHERE state='prepared'`,
  ).run(recoveredAt);
  if (!db.prepare("SELECT id FROM dataset").get())
    db.prepare("INSERT INTO dataset(id) VALUES(?)").run(randomUUID());
  const dataset = () =>
    db.prepare("SELECT * FROM dataset").get() as {
      id: string;
      hostId: string | null;
    };
  // Startup reconciliation of restore staging left by an interrupted switch:
  // a marker whose dataset id is the active dataset is the committed restore
  // (drop the marker only), while any other fully-owned marker directory is
  // abandoned staging and is removed. Unrelated or active roots are untouched.
  {
    const startupDataset = dataset();
    if (startupDataset.hostId)
      await host
        .call(
          "reconcileStagedDatasets",
          { activeDataset: startupDataset.id },
          { hostId: startupDataset.hostId },
        )
        .catch(() => undefined);
  }
  type WayfinderViewSession = {
    viewId: string;
    taskId: string;
    generation: number;
    closed: boolean;
    inFlight: number;
    activeWatch: { watchId: string; hostId: string } | null;
    pendingWatches: Map<string, string>;
  };
  const wayfinderViews = new Map<string, WayfinderViewSession>();
  const closedWayfinderViews = new Set<string>();
  const wayfinderWatchOwners = new Map<
    string,
    { view: WayfinderViewSession; generation: number; hostId: string }
  >();
  const unsubscribeWayfinder = host.experimental_onSignal(
    "wayfinderChanged",
    ({ hostId, payload }) => {
      const owner = wayfinderWatchOwners.get(payload.watchId);
      const view = owner?.view;
      if (
        !owner ||
        !view ||
        view.closed ||
        view.generation !== owner.generation ||
        owner.hostId !== hostId
      )
        return;
      bb.realtime.publish("wayfinderChanged", {
        viewId: view.viewId,
        kind: payload.kind,
        message: payload.message,
      });
    },
  );
  const unsubscribeWayfinderWorker = host.experimental_onWorkerExit(
    ({ hostId }) => {
      for (const view of wayfinderViews.values())
        if (
          !view.closed &&
          (view.activeWatch?.hostId === hostId ||
            [...view.pendingWatches.values()].includes(hostId))
        )
          bb.realtime.publish("wayfinderChanged", {
            viewId: view.viewId,
            kind: "worker-exit",
            message:
              "The host reader stopped unexpectedly. Re-read durable source state before continuing.",
          });
    },
  );
  bb.onDispose(async () => {
    unsubscribeWayfinder();
    unsubscribeWayfinderWorker();
    const watches = [...wayfinderWatchOwners.entries()];
    wayfinderViews.clear();
    closedWayfinderViews.clear();
    wayfinderWatchOwners.clear();
    await Promise.allSettled(
      watches.map(([watchId, owner]) =>
        host.call("stopWayfinderWatch", { watchId }, { hostId: owner.hostId }),
      ),
    );
  });
  const rawTask = (id: string) =>
    db
      .prepare(
        `SELECT id,enrollmentId,number,displayId,title,description,
          workflowStatus AS status,blockerReason,revision,createdAt,updatedAt,
          attribution,attributionAt,memoryState,memoryError,memoryHash,memoryRevision,
          memoryAttributionKind,memoryAttributionRoute,memoryAttributionThreadId,
          memoryAttributionSessionId,memoryAttributionAt
        FROM tasks WHERE id=?`,
      )
      .get(id) as Record<string, unknown> | undefined;
  const dependencyMap = () => {
    const map = new Map<string, string[]>();
    for (const row of db
      .prepare(
        "SELECT taskId,targetTaskId FROM task_relationships WHERE kind='depends-on'",
      )
      .all() as Array<{ taskId: string; targetTaskId: string }>) {
      const values = map.get(row.taskId) ?? [];
      values.push(row.targetTaskId);
      map.set(row.taskId, values);
    }
    return map;
  };
  const defaultObservation = (
    state: RepositoryObservation["state"],
    message: string,
  ): RepositoryObservation => ({
    state,
    message,
    toolVersion: null,
    combinedWorkingCopy: null,
  });
  const preparationRow = (id: string) => {
    const row = db
      .prepare("SELECT * FROM repository_workspaces WHERE taskId=?")
      .get(id) as Omit<RepositoryPreparation, "observation"> | undefined;
    if (!row) throw new Error("Task repository identity is missing.");
    return row;
  };
  const wayfinderAttachmentRow = (id: string) =>
    db.prepare("SELECT * FROM wayfinder_attachments WHERE taskId=?").get(id) as
      WayfinderAttachment | undefined;
  const isInCycle = (id: string, graph: Map<string, string[]>) => {
    const seen = new Set<string>();
    const visit = (current: string): boolean => {
      for (const next of graph.get(current) ?? []) {
        if (next === id) return true;
        if (!seen.has(next)) {
          seen.add(next);
          if (visit(next)) return true;
        }
      }
      return false;
    };
    return visit(id);
  };
  const getTask = (
    id: string,
    graph = dependencyMap(),
    observation?: RepositoryObservation,
  ) => {
    const row = rawTask(id);
    if (!row) throw new Error("Task not found.");
    const relationships = db
      .prepare(
        "SELECT targetTaskId,kind FROM task_relationships WHERE taskId=? ORDER BY targetTaskId",
      )
      .all(id) as Array<{ targetTaskId: string; kind: string }>;
    const paths = db
      .prepare(
        "SELECT id,hostId,path,label FROM attached_paths WHERE taskId=? ORDER BY position",
      )
      .all(id);
    return task.parse({
      ...row,
      memoryAttribution: {
        kind: row.memoryAttributionKind,
        route: row.memoryAttributionRoute,
        threadId: row.memoryAttributionThreadId,
        sessionId: row.memoryAttributionSessionId,
        at: row.memoryAttributionAt,
      },
      dependencyIds: relationships
        .filter((value) => value.kind === "depends-on")
        .map((value) => value.targetTaskId),
      blockerTaskIds: relationships
        .filter((value) => value.kind === "blocker-reference")
        .map((value) => value.targetTaskId),
      dependencyCycle: isInCycle(id, graph),
      paths,
      linkedThreads: linkedThreads(id),
      repositoryPreparation: {
        ...preparationRow(id),
        observation:
          observation ??
          defaultObservation(
            preparationRow(id).environmentId ? "selected" : "unselected",
            preparationRow(id).environmentId
              ? "Repository environment selected; refresh to validate it."
              : "Select the reusable shared main-checkout environment before preparing repository work.",
          ),
      },
      wayfinderAttachment: wayfinderAttachmentRow(id) ?? null,
    });
  };
  const getEnrollment = (id: string) =>
    enrollment.parse(
      db.prepare("SELECT * FROM enrollments WHERE id=?").get(id),
    );
  const enrollments = () =>
    db
      .prepare("SELECT * FROM enrollments ORDER BY createdAt,id")
      .all()
      .map((value) => enrollment.parse(value));
  const linkedThreads = (taskId: string) =>
    db
      .prepare(
        `SELECT threadId,linkRevision,linkedAt,lastKnownTitle,lastKnownProjectId,
          lastKnownEnvironmentId,lastKnownHostId,availability,runtimeStatus,
          environmentMismatch,message
         FROM thread_links WHERE taskId=? ORDER BY linkedAt,threadId`,
      )
      .all(taskId) as LinkedThread[];
  const tasks = () => {
    const graph = dependencyMap();
    return (
      db
        .prepare("SELECT id FROM tasks ORDER BY createdAt,number")
        .all() as Array<{ id: string }>
    ).map(({ id }) => getTask(id, graph));
  };
  type Inventory = Awaited<ReturnType<typeof host.call<"inspectRepository">>>;
  const classify = (
    row: Omit<RepositoryPreparation, "observation">,
    inventory: Inventory,
  ): RepositoryObservation => {
    const shared = {
      toolVersion: inventory.version,
      combinedWorkingCopy: inventory.combinedWorkingCopy,
    };
    if (!row.branchName)
      return {
        state: "selected",
        message:
          "The shared main checkout is valid. Choose an exact branch and an explicit create or associate action.",
        ...shared,
      };
    const branch = inventory.branches.find(
      (candidate) => candidate.name === row.branchName,
    );
    const stack = inventory.appliedStacks.find((names) =>
      names.includes(row.branchName!),
    );
    if (!branch)
      return {
        state: "missing",
        message: `Recorded branch ${row.branchName} is missing or may have been renamed. Explicitly associate its exact current name or choose to recreate it; no SHA or stack identity was guessed.`,
        ...shared,
      };
    if (branch.merged)
      return {
        state: "merged",
        message: `Recorded branch ${row.branchName} is integrated upstream. The task and status are retained; choose the next repository action explicitly.`,
        ...shared,
      };
    if (!stack)
      return {
        state: "unapplied",
        message: `Recorded branch ${row.branchName} exists but is unapplied. Apply it deliberately in GitButler, then revalidate; the plugin did not apply it.`,
        ...shared,
      };
    if (
      !row.parentBranchName &&
      stack.indexOf(row.branchName) !== stack.length - 1
    )
      return {
        state: "placement-mismatch",
        message: `Recorded independent branch ${row.branchName} has another branch below it. Correct placement deliberately in GitButler or use an explicit stacked association. Branches deliberately stacked above it do not invalidate its independent base.`,
        ...shared,
      };
    if (row.parentBranchName) {
      const child = stack.indexOf(row.branchName);
      const parent = stack.indexOf(row.parentBranchName);
      if (child < 0 || parent !== child + 1)
        return {
          state: "placement-mismatch",
          message: `${row.branchName} is not directly above recorded prerequisite ${row.parentBranchName}. Correct or explicitly restack it; no placement was inferred from task dependencies.`,
          ...shared,
        };
    }
    return {
      state: "ready",
      message: row.parentBranchName
        ? `${row.branchName} is prepared directly above ${row.parentBranchName}.`
        : `${row.branchName} is prepared as an independent branch.`,
      ...shared,
    };
  };
  const mutate = (
    id: string,
    datasetEpoch: string,
    expectedRevision: number,
    route: string,
    change: (now: string) => void,
  ) => {
    db.transaction(() => {
      if (dataset().id !== datasetEpoch)
        throw new Error("Dataset changed; reload before saving.");
      const current = rawTask(id);
      if (!current) throw new Error("Task not found.");
      if (current.memoryRevision === 0)
        throw new Error(
          "Task memory initialization must recover before task changes.",
        );
      if (current.revision !== expectedRevision)
        throw new Error("Task changed; reload and reapply your edit.");
      const now = new Date().toISOString();
      change(now);
      const result = db
        .prepare(
          "UPDATE tasks SET revision=revision+1,updatedAt=?,attribution=?,attributionAt=? WHERE id=? AND revision=?",
        )
        .run(now, route, now, id, expectedRevision);
      if (result.changes !== 1)
        throw new Error("Task changed; reload and reapply your edit.");
    })();
    const result = getTask(id);
    bb.realtime.publish("changed", {});
    return result;
  };

  // This single per-task coordinator owns initialization, reconciliation,
  // supported saves/recovery and the link-reassignment seam used by ticket 05.
  const memoryCoordinator = createMemoryCoordinator({
    db,
    datasetEpoch: () => dataset().id,
    readHost: async (taskId) => {
      const current = getTask(taskId);
      return host.call(
        "readMemory",
        { dataset: dataset().id, taskId },
        { hostId: getEnrollment(current.enrollmentId).hostId },
      );
    },
    initializeHost: async (taskId) => {
      const current = getTask(taskId);
      return host.call(
        "initializeMemory",
        { dataset: dataset().id, taskId },
        { hostId: getEnrollment(current.enrollmentId).hostId },
      );
    },
    replaceHost: async ({ taskId, operationId, expectedHash, content }) => {
      const current = getTask(taskId);
      return host.call(
        "replaceMemory",
        {
          dataset: dataset().id,
          taskId,
          operationId,
          expectedHash,
          content,
        },
        { hostId: getEnrollment(current.enrollmentId).hostId },
      );
    },
    confirmHost: async (taskId, expectedHash) => {
      const current = getTask(taskId);
      return host.call(
        "confirmMemoryDurable",
        { dataset: dataset().id, taskId, expectedHash },
        { hostId: getEnrollment(current.enrollmentId).hostId },
      );
    },
    publish: () => bb.realtime.publish("changed", {}),
  });
  const readArchiveMemory = async (taskId: string, hostId: string | null) => {
    const current = getTask(taskId);
    return host.call(
      "readMemory",
      { dataset: dataset().id, taskId },
      { hostId: hostId ?? getEnrollment(current.enrollmentId).hostId },
    );
  };
  /**
   * Inner archive capture assuming maintenance admission has already been
   * acquired. The RPC-facing wrappers acquire the backup gate; the restore
   * coordinator reuses this body under the restore gate so a protective
   * pre-restore capture never deadlocks on a nested maintenance request.
   */
  const captureArchiveInner = async (
    kind: "daily" | "manual" | "protective",
    destination: string | null,
    { forceForDay = false }: { forceForDay?: boolean } = {},
  ) => {
    // Identity is captured after maintenance admission so a queued dataset
    // change can never be captured under the pre-admission identity.
    const identity = dataset();
    if (!identity.hostId)
      throw new Error("Enroll a local project before creating a backup.");
    const requireSameIdentity = () => {
      const current = dataset();
      if (current.id !== identity.id || current.hostId !== identity.hostId)
        throw new Error(
          "Dataset identity changed during archive capture; the attempt was discarded.",
        );
      return current;
    };
    let lastRace = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      requireSameIdentity();
      for (const item of tasks()) {
        const memory = await memoryCoordinator.read(item.id);
        if (memory.state !== "healthy")
          throw new Error(
            `${item.displayId} memory is ${memory.state}; resolve it before creating a healthy backup.`,
          );
      }
      const snapshot = db.transaction(() => {
        const schemaVersion = (
          db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
            count: number;
          }
        ).count;
        if (schemaVersion !== ARCHIVE_SCHEMA_VERSION)
          throw new Error(
            `Current schema ${schemaVersion} has no complete archive adapter.`,
          );
        const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeys.length)
          throw new Error(
            "SQLite relationship validation failed; a healthy backup was not published.",
          );
        if (
          db
            .prepare(
              "SELECT 1 FROM memory_operations WHERE state='prepared' LIMIT 1",
            )
            .get()
        )
          throw new Error(
            "A memory operation remains prepared after reconciliation; retry after it settles.",
          );
        return {
          schemaVersion,
          tables: logicalArchiveTables(db, schemaVersion).tables,
          memories: db
            .prepare(
              "SELECT id,memoryHash,memoryRevision,memoryState FROM tasks ORDER BY id",
            )
            .all() as Array<{
            id: string;
            memoryHash: string | null;
            memoryRevision: number;
            memoryState: string;
          }>,
        };
      })();
      const first = new Map<string, { hash: string; bytesBase64: string }>();
      const memories: ArchiveMemory[] = [];
      let raced = false;
      for (const item of snapshot.memories) {
        if (
          item.memoryRevision < 1 ||
          item.memoryState !== "healthy" ||
          !item.memoryHash
        )
          throw new Error(
            `Task ${item.id} has unresolved canonical memory metadata.`,
          );
        const observed = await readArchiveMemory(item.id, identity.hostId);
        if (observed.state !== "present" || observed.hash !== item.memoryHash)
          throw new Error(
            `Task ${item.id} memory changed or became unreadable during capture.`,
          );
        const bytes = Buffer.from(observed.bytesBase64, "base64");
        if (
          bytes.toString("base64") !== observed.bytesBase64 ||
          bytes.byteLength !== observed.size ||
          createHash("sha256").update(bytes).digest("hex") !== observed.hash
        )
          throw new Error(
            `Task ${item.id} returned inconsistent memory bytes.`,
          );
        first.set(item.id, {
          hash: observed.hash,
          bytesBase64: observed.bytesBase64,
        });
        memories.push({ taskId: item.id, bytes });
      }
      for (const item of snapshot.memories) {
        const observed = await readArchiveMemory(item.id, identity.hostId);
        const before = first.get(item.id)!;
        if (
          observed.state !== "present" ||
          observed.hash !== before.hash ||
          observed.bytesBase64 !== before.bytesBase64
        ) {
          raced = true;
          lastRace = `Task ${item.id} memory changed during archive verification.`;
          break;
        }
      }
      if (raced) continue;
      requireSameIdentity();
      // A concurrent first-use attempt may already have published today's
      // daily archive; recheck day success inside the serialized capture
      // before publishing so a stale status cannot duplicate the day. An
      // explicit retry forces the attempt regardless.
      if (kind === "daily" && !forceForDay) {
        const current = await host.call(
          "archiveStatus",
          { dataset: identity.id, hostId: identity.hostId! },
          { hostId: identity.hostId! },
        );
        if (current.lastSuccessfulLocalDay === current.localDay)
          return { ...current, publishedPath: null as string | null };
      }
      const clock = await host.call(
        "archiveStatus",
        { dataset: identity.id, hostId: identity.hostId! },
        { hostId: identity.hostId! },
      );
      const archive = encodeArchive({
        archiveKind: "complete",
        schemaVersion: snapshot.schemaVersion,
        createdAt: clock.observedAt,
        localDay: clock.localDay,
        source: { datasetId: identity.id, hostId: identity.hostId! },
        diagnostics: [],
        extensions: {
          adapter: "task-workspace-logical/v1",
          canonicalMemoryLocation: "memory/<task-id>.md",
          excludes: [
            "credentials",
            "bb-transcripts",
            "repository-bytes",
            "wayfinder-source-bytes",
            "kv-preferences",
          ],
        },
        tables: snapshot.tables,
        memories,
      });
      return host.call(
        "publishArchive",
        {
          dataset: identity.id,
          hostId: identity.hostId!,
          kind,
          archiveBase64: Buffer.from(archive).toString("base64"),
          destination,
        },
        { hostId: identity.hostId! },
      );
    }
    throw new Error(
      lastRace || "Archive inputs changed repeatedly during capture.",
    );
  };
  /** Daily/manual RPC outputs follow backupHealth; the publication path is restore-internal. */
  const withoutPublishedPath = <T extends { publishedPath?: string | null }>(
    health: T,
  ) => {
    const clone = { ...health };
    delete (clone as Record<string, unknown>).publishedPath;
    return clone;
  };
  const captureArchive = async (
    kind: "daily" | "manual",
    destination: string | null,
    options: { forceForDay?: boolean } = {},
  ) =>
    withoutPublishedPath(
      await maintenance.runMaintenance("backup", () =>
        captureArchiveInner(kind, destination, options),
      ),
    );
  const runArchive = async (
    kind: "daily" | "manual",
    destination: string | null,
    options: { forceForDay?: boolean } = {},
  ) => {
    if (!dataset().hostId)
      throw new Error("Enroll a local project before creating a backup.");
    try {
      return await captureArchive(kind, destination, options);
    } catch (error) {
      const identity = dataset();
      if (identity.hostId)
        await host
          .call(
            "recordArchiveFailure",
            {
              dataset: identity.id,
              hostId: identity.hostId,
              message: boundedError(error),
            },
            { hostId: identity.hostId },
          )
          .catch(() => undefined);
      throw error;
    }
  };
  let dailyAttempt: Promise<unknown> | null = null;
  const ensureDailyBackup = async () => {
    const identity = dataset();
    if (!identity.hostId) return null;
    const status = await host.call(
      "archiveStatus",
      { dataset: identity.id, hostId: identity.hostId },
      { hostId: identity.hostId },
    );
    if (status.lastSuccessfulLocalDay === status.localDay) return status;
    if (!dailyAttempt) {
      const attempt = runArchive("daily", null).finally(() => {
        dailyAttempt = null;
      });
      dailyAttempt = attempt;
      testHooks.onDailyAttempt?.(attempt);
    }
    try {
      return await dailyAttempt;
    } catch {
      return host.call(
        "archiveStatus",
        { dataset: identity.id, hostId: identity.hostId },
        { hostId: identity.hostId },
      );
    }
  };
  /**
   * Recovery-only capture of the damaged-but-readable current state: known
   * tables plus any unknown ones, best-effort readable memory files, and
   * nonempty diagnostics. The result can never be a normal restore source.
   * Assumes maintenance admission (the restore coordinator reuses this
   * under the restore gate); the RPC wrapper acquires the backup gate.
   */
  const captureRecoveryArchiveInner = async (reason: string) => {
    const identity = dataset();
    if (!identity.hostId)
      throw new Error(
        "Enroll a local project before creating a recovery copy.",
      );
    {
      const current = dataset();
      if (current.id !== identity.id || current.hostId !== identity.hostId)
        throw new Error(
          "Dataset identity changed during recovery capture; the attempt was discarded.",
        );
      const schemaVersion = (
        db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
          count: number;
        }
      ).count;
      const diagnostics: string[] = [boundedError(reason).slice(0, 500)];
      // Enumerate each eligible table independently; readable tables are
      // retained with per-table diagnostics for the rest.
      const { tables, diagnostics: tableDiagnostics } = logicalArchiveTables(
        db,
        schemaVersion,
        true,
      );
      diagnostics.push(...tableDiagnostics);
      const memories: ArchiveMemory[] = [];
      // Best-effort task enumeration against whatever columns exist; when
      // the tasks table itself is damaged, other records are still archived.
      let taskRows: Array<{
        id: string;
        displayId: string;
        memoryHash: string | null;
      }> = [];
      try {
        taskRows = db
          .prepare("SELECT id,displayId,memoryHash FROM tasks ORDER BY id")
          .all() as Array<{
          id: string;
          displayId: string;
          memoryHash: string | null;
        }>;
      } catch (error) {
        diagnostics.push(
          `Task records could not be read: ${boundedError(error)}`,
        );
      }
      for (const task of taskRows) {
        try {
          const observed = await readArchiveMemory(task.id, identity.hostId);
          if (observed.state === "present") {
            const bytes = Buffer.from(observed.bytesBase64, "base64");
            memories.push({ taskId: task.id, bytes });
            if (observed.hash !== task.memoryHash)
              diagnostics.push(
                `Task ${task.displayId} memory hash does not match committed metadata.`,
              );
          } else {
            diagnostics.push(
              `Task ${task.displayId} memory is ${observed.state}; bytes were not archived.`,
            );
          }
        } catch (error) {
          diagnostics.push(
            `Task ${task.displayId} memory read failed: ${boundedError(error)}`,
          );
        }
      }
      const clock = await host.call(
        "archiveStatus",
        { dataset: current.id, hostId: current.hostId! },
        { hostId: current.hostId! },
      );
      const archive = encodeArchive({
        archiveKind: "recovery-only",
        schemaVersion,
        createdAt: clock.observedAt,
        localDay: clock.localDay,
        source: { datasetId: current.id, hostId: current.hostId! },
        diagnostics: diagnostics.slice(0, 512),
        extensions: {
          adapter: "task-workspace-logical/v1",
          canonicalMemoryLocation: "memory/<task-id>.md",
          excludes: [
            "credentials",
            "bb-transcripts",
            "repository-bytes",
            "wayfinder-source-bytes",
            "kv-preferences",
          ],
        },
        tables,
        memories,
      });
      return host.call(
        "publishArchive",
        {
          dataset: current.id,
          hostId: current.hostId!,
          kind: "recovery-only",
          archiveBase64: Buffer.from(archive).toString("base64"),
          destination: null,
        },
        { hostId: current.hostId! },
      );
    }
  };
  const captureRecoveryArchive = (reason: string) =>
    maintenance.runMaintenance("backup", () =>
      captureRecoveryArchiveInner(reason),
    );
  /**
   * Restore a whole dataset from a complete archive. The human previews the
   * archive first (previewRestore) and confirms with the preview digest; the
   * bytes are re-read and revalidated here so a file changed after the
   * preview can never slip through. Under the restore maintenance gate the
   * flow is: protective current-state capture (complete when the dataset is
   * healthy, recovery-only when it is damaged), staged memory install under
   * a fresh random epoch with fsync and independent verification, then ONE
   * SQLite transaction installing the validated structured snapshot and
   * switching the active memory-directory reference (the dataset row).
   * Nothing is merged or selectively imported.
   */
  const readRestoreCandidate = async (path: string) => {
    const identity = dataset();
    const hostId = identity.hostId;
    if (!hostId)
      throw new Error("Enroll a local project before restoring a dataset.");
    const read = await host.call("readArchiveCandidate", { path }, { hostId });
    const bytes = Buffer.from(read.bytesBase64, "base64");
    if (
      bytes.toString("base64") !== read.bytesBase64 ||
      bytes.byteLength !== read.size
    )
      throw new Error("Archive read was inconsistent; nothing was validated.");
    const digestValue = createHash("sha256").update(bytes).digest("hex");
    if (digestValue !== read.sha256)
      throw new Error("Archive read was inconsistent; nothing was validated.");
    return { bytes, digest: digestValue, hostId };
  };
  type ValidatedArchive = ReturnType<typeof validateArchive>;
  const describeRestorableArchive = (
    validated: ValidatedArchive,
    expected?: RestoredDatasetIdentity,
  ) => {
    if (validated.manifest.archiveKind !== "complete")
      throw new Error(
        "Recovery-only archives record damaged state and can never be restored.",
      );
    const identity = dataset();
    if (!identity.hostId)
      throw new Error("Enroll a local project before restoring a dataset.");
    const manifest = validated.manifest as unknown as {
      schemaVersion: number;
      createdAt: string;
      localDay: string;
      source: { datasetId: string; hostId: string };
    };
    const plan = planStagedRestore(validated.tables, validated.memories, {
      expected,
      currentHostId: identity.hostId,
      manifest,
      schema: liveRecordSchema(db),
    });
    const warnings: string[] = [];
    if (manifest.schemaVersion < ARCHIVE_SCHEMA_VERSION)
      warnings.push(
        `Archive schema ${manifest.schemaVersion} is migrated to schema ${ARCHIVE_SCHEMA_VERSION} in staging before the switch.`,
      );
    return { plan, manifest, warnings };
  };
  const restoreCounts = (
    plan: StagedRestorePlan,
    validated: ValidatedArchive,
  ) => ({
    enrollments: plan.enrollmentCount,
    tasks: plan.taskCount,
    records: validated.tables.reduce((sum, item) => sum + item.rows.length, 0),
    tables: validated.tables.length,
    memories: validated.memories.length,
    memoryBytes: validated.memories.reduce(
      (sum, item) => sum + item.bytes.byteLength,
      0,
    ),
  });
  /** Tables swapped in the restore transaction, parents before children. */
  const RESTORE_SWAP_ORDER = [
    "dataset",
    "enrollments",
    "tasks",
    "pending_operations",
    "task_relationships",
    "attached_paths",
    "repository_workspaces",
    "memory_operations",
    "memory_operation_ids",
    "thread_links",
    "thread_start_operations",
    "wayfinder_attachments",
    "capture_requests",
  ] as const;
  const installRestoredRecords = (
    stagedTables: ArchiveTable[],
    plan: StagedRestorePlan,
    newEpoch: string,
    schema: RestoreRecordSchema,
  ) => {
    // The archived ledger is provenance data: the live schema's own
    // migration ledger governs, so _bb_migrations is never replaced.
    const byName = new Map(stagedTables.map((item) => [item.name, item]));
    for (const name of [...RESTORE_SWAP_ORDER].reverse())
      db.prepare(
        `DELETE FROM ${quoteSqlIdentifier(restoreTableName(name))}`,
      ).run();
    db.prepare("DELETE FROM dataset").run();
    db.prepare("INSERT INTO dataset(id,hostId) VALUES(?,?)").run(
      newEpoch,
      plan.source.hostId,
    );
    for (const name of RESTORE_SWAP_ORDER.slice(1)) {
      const source = byName.get(name);
      if (!source || source.rows.length === 0) continue;
      const columns = schema[name]?.columns;
      if (!columns) continue;
      const insert = db.prepare(
        `INSERT INTO ${quoteSqlIdentifier(restoreTableName(name))}(${columns
          .map(quoteSqlIdentifier)
          .join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      );
      for (const raw of source.rows) {
        const row = raw as Record<string, unknown>;
        insert.run(
          ...columns.map((column) =>
            Object.hasOwn(row, column) ? (row[column] ?? null) : null,
          ),
        );
      }
    }
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length)
      throw new Error(
        "The restored snapshot failed the SQLite foreign-key check; the transaction was rolled back.",
      );
    // Quarantine is part of the same durable switch transaction: a crash
    // before commit rolls the switch back, and a crash after commit can never
    // expose an unquarantined restored pending start.
    for (const statement of RESTORE_RECOVERY_STATEMENTS) db.exec(statement);
    if (stagedTables.some((item) => item.name === "capture_requests"))
      db.exec(RESTORE_CAPTURE_QUARANTINE);
  };
  const previewRestore = async ({ path }: { path: string }) => {
    const {
      bytes,
      digest: digestValue,
      hostId,
    } = await readRestoreCandidate(path);
    const validated = validateArchive(bytes, ARCHIVE_SCHEMA_VERSION);
    const { plan, manifest, warnings } = describeRestorableArchive(validated);
    if (manifest.source.datasetId === dataset().id)
      warnings.push(
        "This archive is an older snapshot of the current dataset.",
      );
    return {
      digest: digestValue,
      archiveKind: "complete" as const,
      schemaVersion: manifest.schemaVersion,
      createdAt: manifest.createdAt,
      localDay: manifest.localDay,
      source: manifest.source,
      counts: restoreCounts(plan, validated),
      warnings,
      current: {
        datasetId: dataset().id,
        hostId,
        tasks: (
          db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
            count: number;
          }
        ).count,
      },
    };
  };
  const restoreDataset = async (input: {
    path: string;
    expectedDigest: string;
    currentDatasetEpoch: string;
    confirmReplace: true;
  }) => {
    if (input.confirmReplace !== true)
      throw new Error(
        "Restoring replaces the entire dataset; it requires explicit confirmation.",
      );
    const identity = dataset();
    if (!identity.hostId)
      throw new Error("Enroll a local project before restoring a dataset.");
    if (identity.id !== input.currentDatasetEpoch)
      throw new Error(
        "Dataset changed since the preview; preview the archive again.",
      );
    return maintenance.runMaintenance("restore", async () => {
      const current = dataset();
      if (current.id !== identity.id || current.hostId !== identity.hostId)
        throw new Error(
          "Dataset changed during restore preparation; preview the archive again.",
        );
      // Re-read and revalidate the exact bytes the human previewed.
      const { bytes, digest: digestValue } = await readRestoreCandidate(
        input.path,
      );
      if (digestValue !== input.expectedDigest)
        throw new Error(
          "The archive changed since the preview; preview it again before restoring.",
        );
      const validated = validateArchive(bytes, ARCHIVE_SCHEMA_VERSION);
      const liveSchema = liveRecordSchema(db);
      const { plan, manifest, warnings } = describeRestorableArchive(validated);
      // Recover any staging left by an interrupted restore before capturing.
      await host
        .call(
          "reconcileStagedDatasets",
          { activeDataset: current.id },
          { hostId: current.hostId! },
        )
        .catch(() => undefined);
      // Protective current-state copy first. A failed protective capture
      // leaves the current dataset completely untouched.
      let protective: {
        kind: "complete" | "recovery-only";
        path: string | null;
      };
      try {
        const published = await captureArchiveInner("protective", null);
        protective = {
          kind: "complete",
          path: published.publishedPath ?? null,
        };
      } catch (completeError) {
        try {
          const published = await captureRecoveryArchiveInner(
            `Protective complete capture failed during restore: ${boundedError(completeError)}`,
          );
          protective = {
            kind: "recovery-only",
            path: published.publishedPath ?? null,
          };
        } catch (recoveryError) {
          throw new Error(
            `Restore aborted: no protective copy of the current dataset could be preserved, so the current data was left untouched. Complete capture: ${boundedError(completeError)} Recovery capture: ${boundedError(recoveryError)}`,
          );
        }
      }
      // Validate and migrate the archive in an isolated staging SQLite
      // database before a single live table is touched.
      const stagedTables = (() => {
        const staging = createStagingDatabase(db);
        try {
          return stageRestore(
            staging,
            validated.tables,
            liveSchema,
            DURABLE_MIGRATIONS,
            plan.schemaVersion,
          );
        } finally {
          staging.close();
        }
      })();
      // Stage restored memory under a fresh random epoch; the switch makes
      // this directory the active memory root in the same transaction.
      const newEpoch = randomUUID();
      const stagingToken = randomUUID();
      testHooks.failRestoreAt?.("after-protective");
      const discardStage = async () => {
        if (dataset().id === newEpoch) return;
        await host
          .call(
            "discardStagedDataset",
            { dataset: newEpoch, token: stagingToken },
            { hostId: current.hostId! },
          )
          .catch(() => undefined);
      };
      try {
        await host.call(
          "beginStagedDataset",
          { dataset: newEpoch, token: stagingToken },
          { hostId: current.hostId! },
        );
        for (const memory of validated.memories) {
          const expectedHash = plan.memoryHashByTask.get(memory.taskId)!;
          const staged = await host.call(
            "stageRestoredMemory",
            {
              dataset: newEpoch,
              token: stagingToken,
              taskId: memory.taskId,
              bytesBase64: Buffer.from(memory.bytes).toString("base64"),
              expectedHash,
            },
            { hostId: current.hostId! },
          );
          if (staged.hash !== expectedHash)
            throw new Error(
              `Staged memory for ${memory.taskId} failed independent verification.`,
            );
        }
        // Whole-inventory recheck immediately before the switch: the staged
        // memory directory must hold exactly the archived task set with the
        // archived hashes and no extra or missing file.
        await host.call(
          "verifyStagedDataset",
          {
            dataset: newEpoch,
            token: stagingToken,
            memories: [...plan.memoryHashByTask.entries()].map(
              ([taskId, expectedHash]) => ({ taskId, expectedHash }),
            ),
          },
          { hostId: current.hostId! },
        );
      } catch (error) {
        await discardStage();
        throw error;
      }
      testHooks.failRestoreAt?.("after-stage");
      try {
        db.transaction(() => {
          if (dataset().id !== current.id)
            throw new Error(
              "Dataset changed during the restore switch; the transaction was rolled back.",
            );
          installRestoredRecords(stagedTables, plan, newEpoch, liveSchema);
          testHooks.failRestoreAt?.("before-commit");
        })();
      } catch (error) {
        await discardStage();
        throw error;
      }
      testHooks.failRestoreAt?.("after-commit");
      // Drop the staging ownership marker. The switch is already durable, so a
      // post-commit failure here leaves a marker that startup reconciliation
      // clears against the now-active epoch without touching active memory.
      await host
        .call(
          "finalizeStagedDataset",
          { dataset: newEpoch, token: stagingToken },
          { hostId: current.hostId! },
        )
        .catch(() => undefined);
      bb.realtime.publish("changed", {});
      return {
        datasetEpoch: newEpoch,
        restoredCounts: restoreCounts(plan, validated),
        protective,
        warnings: [
          ...warnings,
          ...(manifest.source.datasetId === current.id
            ? [
                "This archive was an older snapshot of the replaced dataset; every session token from before the restore is now stale.",
              ]
            : []),
          `Pre-restore protective copy retained at ${protective.path ?? "an unreported archive path"} until recovery is confirmed.`,
        ],
      };
    });
  };
  /**
   * Versioned quick-capture interface (ticket 10): token-authenticated HTTP
   * routes `GET capture/v1/projects` and `POST capture/v1/tasks`. Dedup is a
   * durable `(datasetEpoch, requestId)` key; the epoch is validated inside
   * the same transaction that reserves or replays the request, and an
   * accepted creation receipt is immutable.
   */
  type CaptureRequestRow = {
    datasetEpoch: string;
    requestId: string;
    projectId: string;
    payloadHash: string;
    taskId: string;
    state: "allocated" | "accepted" | "recovery-required";
    receiptJson: string | null;
    createdAt: string;
    updatedAt: string;
  };
  type CaptureReplay = {
    kind: "replay";
    receipt: CaptureReceipt;
    taskId: string;
  };
  type CapturePlan =
    | { kind: "changed" }
    | { kind: "conflict" }
    | { kind: "recovery" }
    | CaptureReplay
    | { kind: "resume"; taskId: string }
    | { kind: "not-enrolled" }
    | { kind: "new"; enrollment: Enrollment };
  type CaptureReserveOutcome =
    | { kind: "changed" }
    | { kind: "conflict" }
    | { kind: "recovery" }
    | CaptureReplay
    | { kind: "resume"; taskId: string }
    | { kind: "not-enrolled" }
    | { kind: "allocated"; taskId: string };
  type CaptureFinishOutcome =
    | { kind: "changed" }
    | { kind: "completed"; receipt: CaptureReceipt }
    | { kind: "replayed"; receipt: CaptureReceipt }
    | { kind: "pending"; message: string }
    | { kind: "recovery"; message: string };

  const captureRequestRow = (
    epoch: string,
    requestId: string,
  ): CaptureRequestRow | undefined =>
    db
      .prepare(
        "SELECT * FROM capture_requests WHERE datasetEpoch=? AND requestId=?",
      )
      .get(epoch, requestId) as CaptureRequestRow | undefined;

  const captureStoredReceipt = (json: string | null): CaptureReceipt | null => {
    if (!json) return null;
    try {
      return parseCaptureReceipt(JSON.parse(json));
    } catch {
      return null;
    }
  };

  /**
   * An accepted request may only be replayed when its immutable receipt still
   * describes the referenced task's identity. These fields never change under
   * legitimate edits, so a mismatch means the records are inconsistent and a
   * replacement task must never be allocated.
   */
  const captureVerifiedReplay = (
    row: CaptureRequestRow,
  ): CaptureReplay | { kind: "recovery" } => {
    const receipt = captureStoredReceipt(row.receiptJson);
    if (
      !receipt ||
      receipt.taskUuid !== row.taskId ||
      receipt.projectId !== row.projectId
    )
      return { kind: "recovery" };
    const taskRow = db
      .prepare("SELECT displayId,createdAt FROM tasks WHERE id=?")
      .get(row.taskId) as { displayId: string; createdAt: string } | undefined;
    if (
      !taskRow ||
      taskRow.displayId !== receipt.displayId ||
      taskRow.createdAt !== receipt.createdAt
    )
      return { kind: "recovery" };
    return { kind: "replay", receipt, taskId: row.taskId };
  };

  /** Epoch check and dedup lookup share one transaction. */
  const capturePlan = (submission: CaptureSubmission): CapturePlan =>
    db.transaction((): CapturePlan => {
      const epoch = submission.datasetEpoch;
      if (dataset().id !== epoch) return { kind: "changed" };
      const row = captureRequestRow(epoch, submission.requestId);
      if (row) {
        if (row.payloadHash !== capturePayloadHash(submission))
          return { kind: "conflict" };
        if (row.state === "accepted") return captureVerifiedReplay(row);
        if (row.state === "recovery-required") return { kind: "recovery" };
        return { kind: "resume", taskId: row.taskId };
      }
      const enrollment = db
        .prepare("SELECT * FROM enrollments WHERE projectId=?")
        .get(submission.projectId) as Enrollment | undefined;
      if (!enrollment) return { kind: "not-enrolled" };
      return { kind: "new", enrollment };
    })();

  const captureReserve = (
    submission: CaptureSubmission,
    expectedHostId: string,
  ): CaptureReserveOutcome =>
    db.transaction((): CaptureReserveOutcome => {
      const epoch = submission.datasetEpoch;
      if (dataset().id !== epoch) return { kind: "changed" };
      const row = captureRequestRow(epoch, submission.requestId);
      if (row) {
        if (row.payloadHash !== capturePayloadHash(submission))
          return { kind: "conflict" };
        if (row.state === "accepted") return captureVerifiedReplay(row);
        if (row.state === "recovery-required") return { kind: "recovery" };
        return { kind: "resume", taskId: row.taskId };
      }
      const enrollment = db
        .prepare("SELECT * FROM enrollments WHERE projectId=?")
        .get(submission.projectId) as Enrollment | undefined;
      if (!enrollment || enrollment.hostId !== expectedHostId)
        return { kind: "not-enrolled" };
      const at = new Date().toISOString();
      const taskId = randomUUID();
      const operationId = randomUUID();
      db.prepare(
        `INSERT INTO tasks(id,enrollmentId,number,displayId,title,description,status,workflowStatus,createdAt,updatedAt,attribution,attributionAt,memoryState) VALUES(?,?,?,?,?,?,'Inbox','Inbox',?,?, 'capture:http',?, 'pending')`,
      ).run(
        taskId,
        enrollment.id,
        enrollment.nextNumber,
        `${enrollment.prefix}-${enrollment.nextNumber}`,
        submission.title,
        submission.description,
        at,
        at,
        at,
      );
      db.prepare(
        "UPDATE enrollments SET nextNumber=nextNumber+1,revision=revision+1,updatedAt=? WHERE id=?",
      ).run(at, enrollment.id);
      db.prepare(
        "INSERT INTO memory_operation_ids(id,taskId,kind,intendedHash) VALUES(?,?,'initialize-memory',?)",
      ).run(operationId, taskId, EMPTY_MEMORY_HASH);
      db.prepare(
        `INSERT INTO memory_operations(
          id,taskId,kind,state,datasetEpoch,oldRevision,oldHash,expectedActualHash,
          intendedHash,attributionKind,attributionRoute,createdAt,updatedAt)
         VALUES(?,?,'initialize-memory','prepared',?,0,NULL,NULL,?,'initialization','capture:http',?,?)`,
      ).run(operationId, taskId, epoch, EMPTY_MEMORY_HASH, at, at);
      db.prepare(
        "INSERT INTO repository_workspaces(taskId,projectId,hostId,repository,updatedAt) VALUES(?,?,?,?,?)",
      ).run(
        taskId,
        enrollment.projectId,
        enrollment.hostId,
        enrollment.repository,
        at,
      );
      db.prepare(
        `INSERT INTO capture_requests(datasetEpoch,requestId,projectId,payloadHash,taskId,state,createdAt,updatedAt)
         VALUES(?,?,?,?,?,'allocated',?,?)`,
      ).run(
        epoch,
        submission.requestId,
        submission.projectId,
        capturePayloadHash(submission),
        taskId,
        at,
        at,
      );
      return { kind: "allocated", taskId };
    })();

  const captureTaskRow = (
    taskId: string,
  ):
    | {
        id: string;
        displayId: string;
        memoryState: string;
        memoryError: string | null;
        memoryRevision: number;
        createdAt: string;
      }
    | undefined =>
    db
      .prepare(
        "SELECT id,displayId,memoryState,memoryError,memoryRevision,createdAt FROM tasks WHERE id=?",
      )
      .get(taskId) as
      | {
          id: string;
          displayId: string;
          memoryState: string;
          memoryError: string | null;
          memoryRevision: number;
          createdAt: string;
        }
      | undefined;

  const captureFinish = (
    submission: CaptureSubmission,
    taskId: string,
  ): CaptureFinishOutcome =>
    db.transaction((): CaptureFinishOutcome => {
      const epoch = submission.datasetEpoch;
      if (dataset().id !== epoch) return { kind: "changed" };
      const taskRow = captureTaskRow(taskId);
      if (!taskRow)
        return { kind: "recovery", message: "The task is missing." };
      if (taskRow.memoryState === "conflict")
        return {
          kind: "recovery",
          message:
            taskRow.memoryError ?? "Task memory is in an unresolved conflict.",
        };
      if (taskRow.memoryRevision < 1 || taskRow.memoryState !== "healthy")
        return {
          kind: "pending",
          message:
            taskRow.memoryError ?? "Capture memory initialization is pending.",
        };
      const row = captureRequestRow(epoch, submission.requestId);
      if (!row) return { kind: "recovery", message: "The request is missing." };
      if (row.state === "accepted") {
        const receipt = captureStoredReceipt(row.receiptJson);
        return receipt
          ? { kind: "replayed", receipt }
          : { kind: "recovery", message: "The accepted receipt is unusable." };
      }
      if (row.state !== "allocated")
        return {
          kind: "recovery",
          message: "The request state is unsupported.",
        };
      const receipt: CaptureReceipt = {
        taskUuid: taskRow.id,
        displayId: taskRow.displayId,
        projectId: submission.projectId,
        status: "Inbox",
        createdAt: taskRow.createdAt,
      };
      const updated = db
        .prepare(
          "UPDATE capture_requests SET state='accepted',receiptJson=?,updatedAt=? WHERE datasetEpoch=? AND requestId=? AND state='allocated'",
        )
        .run(
          JSON.stringify(receipt),
          new Date().toISOString(),
          epoch,
          submission.requestId,
        );
      if (updated.changes !== 1)
        return {
          kind: "recovery",
          message: "The receipt could not be accepted.",
        };
      return { kind: "completed", receipt };
    })();

  const captureProjectAvailable = async (enrollment: Enrollment) => {
    let projects: Awaited<ReturnType<typeof discovery>>["projects"];
    let hosts: Awaited<ReturnType<typeof discovery>>["hosts"];
    try {
      const result = await discovery();
      projects = result.projects;
      hosts = result.hosts;
    } catch (error) {
      throw new CaptureHttpError(
        "PROJECT_UNAVAILABLE",
        503,
        "BB project discovery is temporarily unavailable; the selected project and draft are preserved for explicit retry.",
        { retryable: true },
      );
    }
    if (!projects.some((item) => item.id === enrollment.projectId))
      throw new CaptureHttpError(
        "PROJECT_UNAVAILABLE",
        409,
        "The enrolled BB project is confirmed missing. Refresh discovery, then correct or reassociate explicitly; nothing was captured.",
      );
    if (
      !projects.some(
        (item) =>
          item.id === enrollment.projectId &&
          item.sources.some(
            (source) =>
              source.type === "local_path" &&
              source.hostId === enrollment.hostId,
          ),
      )
    )
      throw new CaptureHttpError(
        "PROJECT_UNAVAILABLE",
        409,
        "The enrolled BB project no longer resolves on its enrolled host. Refresh discovery, then correct or reassociate explicitly; nothing was captured.",
      );
    if (
      !hosts.some(
        (item) => item.id === enrollment.hostId && item.status === "connected",
      )
    )
      throw new CaptureHttpError(
        "PROJECT_UNAVAILABLE",
        503,
        "The enrolled host is not connected. Retry explicitly after it reconnects; the draft is preserved.",
        { retryable: true },
      );
  };

  type CaptureSubmitOutcome = {
    httpStatus: 200 | 201;
    body: CaptureAcceptedResult;
  };
  /**
   * Accepted replay validates current canonical memory through the memory
   * coordinator. A healthy canonical file (including after legitimate edits)
   * replays the original receipt; a transient pending state asks for an
   * explicit retry; missing or externally-changed bytes require recovery.
   * External bytes are never silently accepted as healthy.
   */
  const assertCaptureReplayMemory = async (
    taskId: string,
    requestId: string,
  ): Promise<void> => {
    const view = await memoryCoordinator.read(taskId);
    if (view.state === "healthy") return;
    if (view.state === "pending")
      throw new CaptureHttpError(
        "CAPTURE_PENDING",
        503,
        `Capture replay is temporarily pending; retry explicitly with the same request ID. ${view.message}`,
        { retryable: true, requestId },
      );
    throw new CaptureHttpError(
      "RECOVERY_REQUIRED",
      409,
      `Persisted capture records are inconsistent; the original creation receipt is retained, but its canonical memory requires explicit recovery. ${view.message ?? ""}`.trim(),
      { requestId },
    );
  };
  const captureSubmit = async (
    submission: CaptureSubmission,
  ): Promise<CaptureSubmitOutcome> =>
    maintenance.runMutation(async (): Promise<CaptureSubmitOutcome> => {
      const plan = capturePlan(submission);
      if (plan.kind === "changed")
        throw new CaptureHttpError(
          "DATASET_CHANGED",
          409,
          "The dataset was restored or replaced. Inspect the board, then explicitly resubmit with the current epoch and a new request ID; the original request is never replayed.",
          { requestId: submission.requestId },
        );
      if (plan.kind === "conflict")
        throw new CaptureHttpError(
          "REQUEST_ID_CONFLICT",
          409,
          "This request ID was already used with different content. Recover the original submission before deliberately creating another.",
          { requestId: submission.requestId },
        );
      if (plan.kind === "recovery")
        throw new CaptureHttpError(
          "RECOVERY_REQUIRED",
          409,
          "Persisted capture records are inconsistent. Inspect recovery state in BB; no replacement task was allocated.",
          { requestId: submission.requestId },
        );
      if (plan.kind === "replay") {
        await assertCaptureReplayMemory(plan.taskId, submission.requestId);
        return {
          httpStatus: 200,
          body: {
            apiVersion: CAPTURE_API_VERSION,
            datasetEpoch: dataset().id,
            requestId: submission.requestId,
            replayed: true,
            receipt: plan.receipt,
          },
        };
      }
      if (plan.kind === "not-enrolled")
        throw new CaptureHttpError(
          "PROJECT_NOT_ENROLLED",
          409,
          "The submitted project is not enrolled. Refresh discovery and choose an enrolled project; nothing was captured.",
          { requestId: submission.requestId },
        );
      let taskId: string;
      if (plan.kind === "new") {
        await captureProjectAvailable(plan.enrollment);
        const reserved = captureReserve(submission, plan.enrollment.hostId);
        if (reserved.kind === "changed")
          throw new CaptureHttpError(
            "DATASET_CHANGED",
            409,
            "The dataset was restored or replaced during submission. Inspect the board, then explicitly resubmit with the current epoch.",
            { requestId: submission.requestId },
          );
        if (reserved.kind === "conflict")
          throw new CaptureHttpError(
            "REQUEST_ID_CONFLICT",
            409,
            "This request ID was already used with different content. Recover the original submission before deliberately creating another.",
            { requestId: submission.requestId },
          );
        if (reserved.kind === "recovery")
          throw new CaptureHttpError(
            "RECOVERY_REQUIRED",
            409,
            "Persisted capture records are inconsistent. Inspect recovery state in BB; no replacement task was allocated.",
            { requestId: submission.requestId },
          );
        if (reserved.kind === "not-enrolled")
          throw new CaptureHttpError(
            "PROJECT_NOT_ENROLLED",
            409,
            "The submitted project is no longer enrolled. Refresh discovery and choose an enrolled project; nothing was captured.",
            { requestId: submission.requestId },
          );
        if (reserved.kind === "replay") {
          await assertCaptureReplayMemory(
            reserved.taskId,
            submission.requestId,
          );
          return {
            httpStatus: 200,
            body: {
              apiVersion: CAPTURE_API_VERSION,
              datasetEpoch: dataset().id,
              requestId: submission.requestId,
              replayed: true,
              receipt: reserved.receipt,
            },
          };
        }
        taskId = reserved.taskId;
      } else taskId = plan.taskId;
      // Recoverable create-only initialization of the one allocated task;
      // the allocated identity is always reused, never replaced.
      try {
        await memoryCoordinator.initialize(taskId);
      } catch {
        // reconcilePrepared records bounded errors durably; finish classifies below.
      }
      const finish = captureFinish(submission, taskId);
      if (finish.kind === "changed")
        throw new CaptureHttpError(
          "DATASET_CHANGED",
          409,
          "The dataset was restored or replaced during initialization. Inspect the board, then explicitly resubmit with the current epoch.",
          { requestId: submission.requestId },
        );
      if (finish.kind === "recovery")
        throw new CaptureHttpError(
          "RECOVERY_REQUIRED",
          409,
          `Persisted capture records are inconsistent. Inspect recovery state in BB; no replacement task was allocated. ${finish.message}`,
          { requestId: submission.requestId },
        );
      if (finish.kind === "pending")
        throw new CaptureHttpError(
          "CAPTURE_PENDING",
          503,
          `Capture initialization is incomplete; an explicit retry with this request ID recovers it. ${finish.message}`,
          { retryable: true, requestId: submission.requestId },
        );
      bb.realtime.publish("changed", {});
      return {
        httpStatus: finish.kind === "completed" ? 201 : 200,
        body: {
          apiVersion: CAPTURE_API_VERSION,
          datasetEpoch: dataset().id,
          requestId: submission.requestId,
          replayed: finish.kind === "replayed",
          receipt: finish.receipt,
        },
      };
    });

  type LinkRow = LinkedThread & { taskId: string };
  const currentLink = (threadId: string) =>
    db.prepare("SELECT * FROM thread_links WHERE threadId=?").get(threadId) as
      LinkRow | undefined;
  const assertDataset = (expected: string) => {
    if (dataset().id !== expected)
      throw new Error("Dataset changed; reload before using this thread link.");
  };
  const assertCurrentLink = (
    taskId: string,
    threadId: string,
    linkRevision: number,
  ) => {
    const link = currentLink(threadId);
    if (!link || link.taskId !== taskId)
      throw new Error(
        "This thread is not currently linked to that task; reread task details.",
      );
    if (link.linkRevision !== linkRevision)
      throw new Error(
        "Thread link authorization changed; reread task details before retrying.",
      );
    return link;
  };
  const environmentMismatch = async (
    taskId: string,
    environmentId: string | null,
  ) => {
    const taskRow = getTask(taskId);
    const enrolled = getEnrollment(taskRow.enrollmentId);
    if (!environmentId)
      return {
        hostId: null,
        mismatch:
          "The thread has no BB environment. Discussion remains available, but it is not the task repository workspace.",
      };
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      const problems: string[] = [];
      if (environment.projectId !== enrolled.projectId)
        problems.push(
          `project ${environment.projectId} instead of ${enrolled.projectId}`,
        );
      if (environment.hostId !== enrolled.hostId)
        problems.push(
          `host ${environment.hostId} instead of ${enrolled.hostId}`,
        );
      if (!environment.path) problems.push("environment has no workspace path");
      else {
        try {
          const canonical = await host.call(
            "validateRepository",
            { repository: environment.path },
            { hostId: environment.hostId },
          );
          if (canonical.repository !== enrolled.repository)
            problems.push(
              `canonical path ${canonical.repository} instead of ${enrolled.repository}`,
            );
        } catch (error) {
          problems.push(
            `workspace identity could not be validated: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
          );
        }
      }
      if (
        taskRow.repositoryPreparation.environmentId &&
        environment.id !== taskRow.repositoryPreparation.environmentId
      )
        problems.push(
          `environment ${environment.id} instead of selected ${taskRow.repositoryPreparation.environmentId}`,
        );
      return {
        hostId: environment.hostId,
        mismatch: problems.length
          ? `Actual environment mismatch: ${problems.join("; ")}. No workspace was moved or repaired.`
          : null,
      };
    } catch (error) {
      return {
        hostId: null,
        mismatch: `Thread environment ${environmentId} is unavailable or unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      };
    }
  };
  const readThreadReference = async (
    taskId: string,
    threadId: string,
  ): Promise<LinkedThread> => {
    const retained = currentLink(threadId);
    if (!retained || retained.taskId !== taskId)
      throw new Error("Thread link changed while its reference was refreshed.");
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const environment = await environmentMismatch(
        taskId,
        thread.environmentId,
      );
      const availability = thread.deletedAt
        ? "missing"
        : thread.archivedAt
          ? "archived"
          : "available";
      const message = thread.deletedAt
        ? "BB confirms this conversation is deleted. Its last-known identity remains attached; it was not recreated."
        : thread.archivedAt
          ? "This conversation is archived. Its task reference is retained."
          : environment.mismatch
            ? environment.mismatch
            : "Conversation and task repository environment currently match.";
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE thread_links SET lastKnownTitle=?,lastKnownProjectId=?,
          lastKnownEnvironmentId=?,lastKnownHostId=COALESCE(?,lastKnownHostId),
          availability=?,runtimeStatus=?,environmentMismatch=?,message=?,updatedAt=?
         WHERE threadId=? AND taskId=? AND linkRevision=?`,
      ).run(
        thread.title ?? thread.titleFallback,
        thread.projectId,
        thread.environmentId,
        environment.hostId,
        availability,
        thread.status,
        environment.mismatch,
        message,
        now,
        threadId,
        taskId,
        retained.linkRevision,
      );
    } catch (error) {
      const message = `BB could not read this conversation. It is unavailable, not confirmed missing; last-known identity is retained: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`;
      db.prepare(
        `UPDATE thread_links SET availability='unavailable',runtimeStatus=NULL,
          message=?,updatedAt=? WHERE threadId=? AND taskId=? AND linkRevision=?`,
      ).run(
        message,
        new Date().toISOString(),
        threadId,
        taskId,
        retained.linkRevision,
      );
    }
    const result = currentLink(threadId);
    if (!result || result.taskId !== taskId)
      throw new Error("Thread link changed while its reference was refreshed.");
    return result;
  };
  const renderTaskContext = (taskId: string, memory: MemoryView) => {
    const current = getTask(taskId);
    const enrolled = getEnrollment(current.enrollmentId);
    if (memory.state !== "healthy")
      throw new Error(
        `Current task memory is ${memory.state}; resolve or reconcile it before sending context.`,
      );
    const dependencies = current.dependencyIds.map((id) => {
      const value = getTask(id);
      return `${value.displayId} — ${value.title} (${value.status})`;
    });
    const olderThreads = current.linkedThreads.map(
      (link) =>
        `${link.threadId}${link.lastKnownTitle ? ` — ${link.lastKnownTitle}` : ""} (${link.availability})`,
    );
    return [
      "# Current task context",
      `- ID: ${current.displayId}`,
      `- Title: ${current.title}`,
      `- Status: ${current.status}`,
      `- BB project: ${enrolled.projectId}`,
      `- Repository: ${enrolled.repository}`,
      `- Selected environment: ${current.repositoryPreparation.environmentId ?? "not selected"}`,
      `- Branch: ${current.repositoryPreparation.branchName ?? "not prepared"}`,
      `- Branch prerequisite: ${current.repositoryPreparation.parentBranchName ?? "none"}`,
      "",
      "## Description",
      current.description || "(empty)",
      "",
      "## Attached path references",
      ...(current.paths.length
        ? current.paths.map(
            (path) => `- ${path.label ? `${path.label}: ` : ""}${path.path}`,
          )
        : ["- None"]),
      "",
      "## Dependencies",
      ...(dependencies.length
        ? dependencies.map((value) => `- ${value}`)
        : ["- None"]),
      "",
      "## Task memory",
      memory.content || "(empty)",
      "",
      "## Linked conversation references",
      ...(olderThreads.length
        ? olderThreads.map((value) => `- ${value}`)
        : ["- None"]),
      "",
      "This is a fresh task snapshot, not a transcript. Referenced paths are not imported. Linking and this send do not prepare a branch, change task status, or start repository work automatically.",
    ].join("\n");
  };
  type StartRow = Omit<StartOperation, "linkContext" | "environment"> & {
    linkContextJson: string;
    environmentJson: string;
    executionInputSourcesJson: string;
    requestDigest: string;
    memoryRevision: number;
    memoryHash: string;
  };
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const boundedError = (error: unknown) =>
    String(error instanceof Error ? error.message : error).slice(0, 1000);
  const linkContext = (taskId: string) =>
    linkedThreads(taskId)
      .map(({ threadId, linkRevision }) => ({ threadId, linkRevision }))
      .sort((left, right) => left.threadId.localeCompare(right.threadId));
  const sameLinkContext = (
    left: Array<{ threadId: string; linkRevision: number }>,
    right: Array<{ threadId: string; linkRevision: number }>,
  ) => JSON.stringify(left) === JSON.stringify(right);
  const parseStartRow = (row: StartRow | undefined) => {
    if (!row) throw new Error("Thread start operation not found.");
    return startOperation.parse({
      ...row,
      linkContext: JSON.parse(row.linkContextJson),
      environment: JSON.parse(row.environmentJson),
    });
  };
  const startRow = (operationId: string) =>
    db
      .prepare("SELECT * FROM thread_start_operations WHERE id=?")
      .get(operationId) as StartRow | undefined;
  const readStart = (taskId: string, operationId: string) => {
    const row = startRow(operationId);
    if (!row || row.taskId !== taskId)
      throw new Error("Thread start operation does not belong to this task.");
    return parseStartRow(row);
  };
  const assertStartEpoch = (
    operation: StartOperation,
    expectedEpoch: string,
  ) => {
    assertDataset(expectedEpoch);
    if (operation.datasetEpoch !== expectedEpoch)
      throw new Error(
        "Thread start operation belongs to another dataset epoch; restore and reread before recovery.",
      );
  };
  const startOperations = () =>
    (
      db
        .prepare("SELECT * FROM thread_start_operations ORDER BY createdAt,id")
        .all() as StartRow[]
    ).map((row) => parseStartRow(row));
  const assertStartContext = (
    taskId: string,
    expectedEpoch: string,
    expectedTaskRevision: number,
    expectedLinks: Array<{ threadId: string; linkRevision: number }>,
    expectedMemoryRevision?: number,
    expectedMemoryHash?: string,
  ) => {
    assertDataset(expectedEpoch);
    const current = getTask(taskId);
    if (current.revision !== expectedTaskRevision)
      throw new Error(
        "Task details changed; the composer draft is preserved. Reread before a new start attempt.",
      );
    const normalized = [...expectedLinks].sort((left, right) =>
      left.threadId.localeCompare(right.threadId),
    );
    if (!sameLinkContext(linkContext(taskId), normalized))
      throw new Error(
        "Linked-conversation context changed; the composer draft is preserved. Reread before a new start attempt.",
      );
    if (
      expectedMemoryRevision !== undefined &&
      (current.memoryRevision !== expectedMemoryRevision ||
        current.memoryHash !== expectedMemoryHash)
    )
      throw new Error(
        "Task memory changed before dispatch; no conversation was started.",
      );
    return current;
  };
  const validateStartEnvironment = async (
    taskId: string,
    request: NewThreadRequestPayload,
  ) => {
    const current = getTask(taskId);
    const enrolled = getEnrollment(current.enrollmentId);
    if (request.projectId !== enrolled.projectId)
      throw new Error(
        `Composer selected project ${request.projectId}, not enrolled project ${enrolled.projectId}. Nothing was started.`,
      );
    if (request.environment.type === "reuse") {
      const environment = await bb.sdk.environments.get({
        environmentId: request.environment.environmentId,
      });
      if (
        environment.projectId !== enrolled.projectId ||
        environment.hostId !== enrolled.hostId ||
        environment.managed ||
        environment.isWorktree ||
        environment.workspaceProvisionType !== "unmanaged" ||
        environment.status !== "ready" ||
        !environment.path
      )
        throw new Error(
          "Composer must reuse the ready unmanaged main checkout for this enrolled project and host. Worktrees and branch-mutating choices are not implicit task preparation.",
        );
      const checked = await host.call(
        "validateRepository",
        { repository: environment.path },
        { hostId: environment.hostId },
      );
      if (checked.repository !== enrolled.repository)
        throw new Error(
          "Submitted environment does not resolve to the enrolled main repository. Nothing was started.",
        );
      return enrolled.hostId;
    }
    if (
      request.environment.type !== "host" ||
      request.environment.hostId !== enrolled.hostId ||
      request.environment.workspace.type !== "unmanaged" ||
      request.environment.workspace.path !== null ||
      request.environment.workspace.branch !== undefined
    )
      throw new Error(
        "Choose the enrolled host's unmanaged main checkout with no Branch from operation. Project-default, personal, worktree, existing-branch and new-branch choices are rejected without changing the draft.",
      );
    const project = await bb.sdk.projects.get({
      projectId: enrolled.projectId,
    });
    const source = project.sources.find(
      (candidate) =>
        candidate.type === "local_path" &&
        candidate.hostId === enrolled.hostId &&
        candidate.isDefault,
    );
    if (!source?.path)
      throw new Error(
        "The enrolled project no longer has its default main-checkout source on the submitted host.",
      );
    const checked = await host.call(
      "validateRepository",
      { repository: source.path },
      { hostId: enrolled.hostId },
    );
    if (checked.repository !== enrolled.repository)
      throw new Error(
        "The submitted host's default checkout no longer resolves to the enrolled repository.",
      );
    const targetHost = await bb.sdk.hosts.get({ hostId: enrolled.hostId });
    if (targetHost.status !== "connected")
      throw new Error("The submitted enrolled host is not connected.");
    return enrolled.hostId;
  };
  const validateStartedThreadEnvironment = async (
    taskId: string,
    operation: StartOperation,
    thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>,
  ) => {
    const enrolled = getEnrollment(getTask(taskId).enrollmentId);
    if (thread.projectId !== operation.projectId || !thread.environmentId)
      throw new Error(
        "Created or identified conversation does not have the submitted project and a concrete environment.",
      );
    if (
      operation.environment.type === "reuse" &&
      thread.environmentId !== operation.environment.environmentId
    )
      throw new Error(
        "Created conversation did not reuse the exact submitted environment.",
      );
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (
      environment.projectId !== enrolled.projectId ||
      environment.hostId !== operation.hostId ||
      environment.managed ||
      environment.isWorktree ||
      environment.workspaceProvisionType !== "unmanaged" ||
      !environment.path
    )
      throw new Error(
        "Created or identified conversation is not in the submitted enrolled-project main checkout.",
      );
    const checked = await host.call(
      "validateRepository",
      { repository: environment.path },
      { hostId: environment.hostId },
    );
    if (checked.repository !== enrolled.repository)
      throw new Error(
        "Created or identified conversation resolves to another repository.",
      );
  };
  const setStartState = (
    operationId: string,
    state: StartOperation["state"],
    error: string | null,
    threadId?: string,
  ) => {
    const result = db
      .prepare(
        `UPDATE thread_start_operations SET state=?,error=?,
          threadId=COALESCE(?,threadId),updatedAt=? WHERE id=?`,
      )
      .run(
        state,
        error,
        threadId ?? null,
        new Date().toISOString(),
        operationId,
      );
    if (result.changes !== 1)
      throw new Error("Thread start operation changed or disappeared.");
  };
  const linkValidatedThread = async ({
    taskId,
    expectedEpoch,
    thread,
    expectedCurrentLinkRevision,
    reassign,
    startOperationId,
  }: {
    taskId: string;
    expectedEpoch: string;
    thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
    expectedCurrentLinkRevision: number | null;
    reassign: boolean;
    startOperationId?: string;
  }) => {
    const taskValue = getTask(taskId);
    const enrolled = getEnrollment(taskValue.enrollmentId);
    if (thread.deletedAt)
      throw new Error(
        `BB confirms thread ${thread.id} is deleted; it cannot be linked.`,
      );
    if (thread.projectId !== enrolled.projectId)
      throw new Error(
        `Thread belongs to BB project ${thread.projectId}, not enrolled project ${enrolled.projectId}. Nothing was linked or moved.`,
      );
    const actualEnvironment = await environmentMismatch(
      taskId,
      thread.environmentId,
    );
    const before = currentLink(thread.id);
    const taskIds = [
      taskId,
      ...(before && before.taskId !== taskId ? [before.taskId] : []),
    ];
    await memoryCoordinator.withLinkReassignment(taskIds, () => {
      db.transaction(() => {
        assertDataset(expectedEpoch);
        if (startOperationId) {
          const start = readStart(taskId, startOperationId);
          assertStartEpoch(start, expectedEpoch);
          if (start.abandonedAt)
            throw new Error(
              "This start operation was explicitly abandoned and cannot be linked.",
            );
          if (start.state !== "awaiting-link" || start.threadId !== thread.id)
            throw new Error(
              "Thread start operation changed before link completion.",
            );
        }
        const currentEnrollment = getEnrollment(getTask(taskId).enrollmentId);
        if (thread.projectId !== currentEnrollment.projectId)
          throw new Error(
            `Task enrollment changed to project ${currentEnrollment.projectId} while linking; thread project ${thread.projectId} was rejected without mutation.`,
          );
        const actual = currentLink(thread.id);
        if (actual?.taskId === taskId) {
          if (
            expectedCurrentLinkRevision !== null &&
            expectedCurrentLinkRevision !== actual.linkRevision
          )
            throw new Error(
              "Thread link revision changed; reread before retrying.",
            );
        } else {
          if (actual) {
            if (!reassign)
              throw new Error(
                "Thread is linked to another task. Confirm explicit reassignment after rereading its current link.",
              );
            if (
              expectedCurrentLinkRevision === null ||
              expectedCurrentLinkRevision !== actual.linkRevision
            )
              throw new Error(
                "Thread reassignment requires its exact current link revision.",
              );
          } else if (expectedCurrentLinkRevision !== null) {
            throw new Error(
              "Thread has no current link; reread before retrying this link action.",
            );
          }
          const at = new Date().toISOString();
          const availability = thread.archivedAt ? "archived" : "available";
          const message = thread.archivedAt
            ? "This conversation is archived. Its task reference is retained."
            : (actualEnvironment.mismatch ??
              "Conversation and task repository environment currently match.");
          if (actual)
            db.prepare(
              `UPDATE thread_links SET taskId=?,linkRevision=linkRevision+1,linkedAt=?,
                lastKnownTitle=?,lastKnownProjectId=?,lastKnownEnvironmentId=?,
                lastKnownHostId=?,availability=?,runtimeStatus=?,environmentMismatch=?,
                message=?,updatedAt=? WHERE threadId=? AND linkRevision=?`,
            ).run(
              taskId,
              at,
              thread.title ?? thread.titleFallback,
              thread.projectId,
              thread.environmentId,
              actualEnvironment.hostId,
              availability,
              thread.status,
              actualEnvironment.mismatch,
              message,
              at,
              thread.id,
              actual.linkRevision,
            );
          else
            db.prepare(
              `INSERT INTO thread_links(threadId,taskId,linkRevision,linkedAt,
                lastKnownTitle,lastKnownProjectId,lastKnownEnvironmentId,lastKnownHostId,
                availability,runtimeStatus,environmentMismatch,message,updatedAt)
               VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              thread.id,
              taskId,
              at,
              thread.title ?? thread.titleFallback,
              thread.projectId,
              thread.environmentId,
              actualEnvironment.hostId,
              availability,
              thread.status,
              actualEnvironment.mismatch,
              message,
              at,
            );
        }
        if (startOperationId) {
          testHooks.failStartAt?.("link-final-transaction");
          const updated = db
            .prepare(
              `UPDATE thread_start_operations SET state='linked',error=NULL,
                threadId=?,updatedAt=? WHERE id=? AND taskId=? AND state='awaiting-link'
                AND datasetEpoch=? AND abandonedAt IS NULL`,
            )
            .run(
              thread.id,
              new Date().toISOString(),
              startOperationId,
              taskId,
              expectedEpoch,
            );
          if (updated.changes !== 1)
            throw new Error(
              "Thread start operation changed before link completion.",
            );
        }
      })();
    });
    bb.realtime.publish("changed", {});
    return readThreadReference(taskId, thread.id);
  };
  const completeStartLink = async (
    taskId: string,
    operationId: string,
    expectedEpoch: string,
    expectedCurrentLinkRevision: number | null = null,
    reassign = false,
  ) => {
    const operation = readStart(taskId, operationId);
    assertStartEpoch(operation, expectedEpoch);
    if (operation.abandonedAt) return operation;
    if (operation.state === "linked") return operation;
    if (operation.state !== "awaiting-link" || !operation.threadId)
      return operation;
    try {
      let thread = await bb.sdk.threads.get({
        threadId: operation.threadId,
      });
      // Spawn returns before BB finishes assigning/provisioning the checkout.
      // Only poll the saved thread; never dispatch another conversation.
      const deadline = Date.now() + 10_000;
      while (thread.projectId === operation.projectId) {
        const environment = thread.environmentId
          ? await bb.sdk.environments.get({
              environmentId: thread.environmentId,
            })
          : null;
        if (environment?.status === "ready") break;
        if (environment?.status === "error")
          throw new Error(
            "BB could not prepare the conversation's checkout. Open the conversation to inspect the error, then retry linking.",
          );
        if (Date.now() >= deadline)
          throw new Error(
            "The conversation was created, but BB is still preparing its checkout. Retry linking shortly; no new conversation will be created.",
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const latest = readStart(taskId, operationId);
        assertStartEpoch(latest, expectedEpoch);
        if (latest.abandonedAt || latest.state !== "awaiting-link")
          return latest;
        thread = await bb.sdk.threads.get({ threadId: operation.threadId });
      }
      await validateStartedThreadEnvironment(taskId, operation, thread);
      await linkValidatedThread({
        taskId,
        expectedEpoch,
        thread,
        expectedCurrentLinkRevision,
        reassign,
        startOperationId: operationId,
      });
    } catch (error) {
      assertDataset(expectedEpoch);
      const current = readStart(taskId, operationId);
      assertStartEpoch(current, expectedEpoch);
      if (!current.abandonedAt && current.state === "awaiting-link")
        db.transaction(() => {
          assertDataset(expectedEpoch);
          const latest = readStart(taskId, operationId);
          assertStartEpoch(latest, expectedEpoch);
          if (latest.abandonedAt || latest.state !== "awaiting-link") return;
          db.prepare(
            `UPDATE thread_start_operations SET error=?,updatedAt=?
             WHERE id=? AND taskId=? AND datasetEpoch=? AND state='awaiting-link'
             AND abandonedAt IS NULL`,
          ).run(
            boundedError(error),
            new Date().toISOString(),
            operationId,
            taskId,
            expectedEpoch,
          );
        })();
    }
    return readStart(taskId, operationId);
  };
  type StartSubmission = {
    id: string;
    operationId: string;
    datasetEpoch: string;
    expectedTaskRevision: number;
    expectedLinkContext: Array<{ threadId: string; linkRevision: number }>;
    request: NewThreadRequestPayload;
  };
  const normalizedExpectedLinks = (input: StartSubmission) =>
    [...input.expectedLinkContext].sort((left, right) =>
      left.threadId.localeCompare(right.threadId),
    );
  const assertStartReplay = (row: StartRow, input: StartSubmission) => {
    const links = normalizedExpectedLinks(input);
    if (
      row.taskId !== input.id ||
      row.datasetEpoch !== input.datasetEpoch ||
      row.taskRevision !== input.expectedTaskRevision ||
      row.requestDigest !== digest(input.request) ||
      row.inputDigest !== digest(input.request.input) ||
      !sameLinkContext(JSON.parse(row.linkContextJson), links)
    )
      throw new Error(
        "Thread start operation identity or submitted composer payload does not match. Preserve the original operation for reconciliation or explicitly abandon it before a new attempt.",
      );
  };
  const insertStart = (
    input: StartSubmission,
    values: {
      state: StartOperation["state"];
      hostId: string;
      memoryRevision: number;
      memoryHash: string;
      error?: string | null;
    },
  ) => {
    const now = new Date().toISOString();
    const request = input.request;
    db.prepare(
      `INSERT INTO thread_start_operations(
        id,taskId,state,datasetEpoch,taskRevision,linkContextJson,projectId,
        environmentJson,hostId,providerId,model,reasoningLevel,serviceTier,
        permissionMode,executionInputSourcesJson,sendAt,inputDigest,requestDigest,
        memoryRevision,memoryHash,threadId,error,abandonedAt,createdAt,updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?,?)`,
    ).run(
      input.operationId,
      input.id,
      values.state,
      input.datasetEpoch,
      input.expectedTaskRevision,
      JSON.stringify(normalizedExpectedLinks(input)),
      request.projectId,
      JSON.stringify(request.environment),
      values.hostId,
      request.providerId,
      request.model,
      request.reasoningLevel,
      request.serviceTier ?? null,
      request.permissionMode,
      JSON.stringify(request.executionInputSources),
      request.sendAt ?? null,
      digest(request.input),
      digest(request),
      values.memoryRevision,
      values.memoryHash,
      values.error ?? null,
      now,
      now,
    );
  };
  const runStart = async (input: StartSubmission) => {
    assertDataset(input.datasetEpoch);
    const replay = startRow(input.operationId);
    if (replay) {
      assertStartReplay(replay, input);
      if (replay.abandonedAt) return parseStartRow(replay);
      if (replay.state === "awaiting-link")
        return completeStartLink(
          input.id,
          input.operationId,
          input.datasetEpoch,
        );
      if (replay.state === "dispatching") {
        setStartState(
          input.operationId,
          "uncertain",
          "Dispatch may have occurred before recovery. BB spawn and the first message will not be retried automatically.",
        );
      } else if (replay.state === "prepared") {
        setStartState(
          input.operationId,
          "failed-before-dispatch",
          "The prepared operation was restored before dispatch. No external effect is replayed automatically; explicitly abandon it before a new attempt.",
        );
      }
      return readStart(input.id, input.operationId);
    }
    const active = db
      .prepare(
        "SELECT id FROM thread_start_operations WHERE taskId=? AND abandonedAt IS NULL AND state<>'linked'",
      )
      .get(input.id) as { id: string } | undefined;
    if (active)
      throw new Error(
        `Task has incomplete start operation ${active.id}. Reconcile or explicitly abandon it before a new attempt.`,
      );
    let hostId = "";
    let context = "";
    try {
      assertStartContext(
        input.id,
        input.datasetEpoch,
        input.expectedTaskRevision,
        input.expectedLinkContext,
      );
      hostId = await validateStartEnvironment(input.id, input.request);
      await memoryCoordinator.withLinkReassignment(input.id, async (locked) => {
        const current = assertStartContext(
          input.id,
          input.datasetEpoch,
          input.expectedTaskRevision,
          input.expectedLinkContext,
        );
        const memory = await locked.read(input.id);
        context = renderTaskContext(input.id, memory);
        testHooks.failStartAt?.("before-prepared");
        db.transaction(() => {
          assertStartContext(
            input.id,
            input.datasetEpoch,
            input.expectedTaskRevision,
            input.expectedLinkContext,
          );
          insertStart(input, {
            state: "prepared",
            hostId,
            memoryRevision: current.memoryRevision,
            memoryHash: current.memoryHash ?? EMPTY_MEMORY_HASH,
          });
        })();
      });
    } catch (error) {
      assertDataset(input.datasetEpoch);
      if (!startRow(input.operationId)) {
        try {
          db.transaction(() => {
            assertDataset(input.datasetEpoch);
            if (startRow(input.operationId)) return;
            const current = getTask(input.id);
            insertStart(input, {
              state: "failed-before-dispatch",
              hostId: hostId || getEnrollment(current.enrollmentId).hostId,
              memoryRevision: current.memoryRevision,
              memoryHash: current.memoryHash ?? EMPTY_MEMORY_HASH,
              error: boundedError(error),
            });
          })();
        } catch {
          throw error;
        }
      }
      return readStart(input.id, input.operationId);
    }
    try {
      const dispatchHost = await validateStartEnvironment(
        input.id,
        input.request,
      );
      testHooks.failStartAt?.("persist-dispatching");
      db.transaction(() => {
        const row = startRow(input.operationId);
        if (!row || row.state !== "prepared")
          throw new Error("Prepared start operation changed before dispatch.");
        if (row.datasetEpoch !== input.datasetEpoch || row.abandonedAt)
          throw new Error(
            "Prepared start operation was restored or abandoned before dispatch.",
          );
        const enrolled = getEnrollment(getTask(input.id).enrollmentId);
        if (
          row.projectId !== enrolled.projectId ||
          row.hostId !== enrolled.hostId ||
          dispatchHost !== enrolled.hostId
        )
          throw new Error(
            "Task enrollment, submitted project or host changed before dispatch.",
          );
        assertStartContext(
          input.id,
          input.datasetEpoch,
          input.expectedTaskRevision,
          input.expectedLinkContext,
          row.memoryRevision,
          row.memoryHash,
        );
        setStartState(input.operationId, "dispatching", null);
      })();
    } catch (error) {
      assertDataset(input.datasetEpoch);
      const current = readStart(input.id, input.operationId);
      if (!current.abandonedAt)
        setStartState(
          input.operationId,
          "failed-before-dispatch",
          boundedError(error),
        );
      return readStart(input.id, input.operationId);
    }
    try {
      testHooks.failStartAt?.("after-dispatching");
      const current = getTask(input.id);
      const thread = await maintenance.runExternal(() =>
        bb.sdk.threads.spawn({
          ...(input.request as NewThreadRequest),
          input: [
            ...input.request.input,
            { type: "text", text: context, mentions: [] },
          ],
          title: `${current.displayId}: ${current.title}`,
        }),
      );
      testHooks.failStartAt?.("after-spawn-before-thread-id");
      const shouldLink = db.transaction(() => {
        assertDataset(input.datasetEpoch);
        const row = startRow(input.operationId);
        if (
          !row ||
          row.state !== "dispatching" ||
          row.datasetEpoch !== input.datasetEpoch
        )
          throw new Error(
            "Dispatch operation changed before BB thread ID was saved.",
          );
        setStartState(input.operationId, "awaiting-link", null, thread.id);
        return !row.abandonedAt;
      })();
      if (!shouldLink) return readStart(input.id, input.operationId);
    } catch (error) {
      assertDataset(input.datasetEpoch);
      const current = startRow(input.operationId);
      if (current?.state === "dispatching" && !current.abandonedAt)
        setStartState(
          input.operationId,
          "uncertain",
          `${boundedError(error)} BB spawn or its first message may have occurred; it will not be retried automatically.`,
        );
      return readStart(input.id, input.operationId);
    }
    try {
      testHooks.failStartAt?.("after-awaiting-link");
    } catch (error) {
      db.transaction(() => {
        assertDataset(input.datasetEpoch);
        const latest = readStart(input.id, input.operationId);
        assertStartEpoch(latest, input.datasetEpoch);
        if (latest.abandonedAt || latest.state !== "awaiting-link") return;
        db.prepare(
          `UPDATE thread_start_operations SET error=?,updatedAt=?
           WHERE id=? AND taskId=? AND datasetEpoch=? AND state='awaiting-link'
           AND abandonedAt IS NULL`,
        ).run(
          boundedError(error),
          new Date().toISOString(),
          input.operationId,
          input.id,
          input.datasetEpoch,
        );
      })();
      return readStart(input.id, input.operationId);
    }
    return completeStartLink(input.id, input.operationId, input.datasetEpoch);
  };
  const toolResult = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  });
  const linkedAgentTask = (threadId: string, projectId: string) => {
    const link = currentLink(threadId);
    if (!link)
      throw new Error(
        "not-linked: this BB conversation is not currently linked to a Task Workspace task. Link it in the task drawer, then retry this tool.",
      );
    const current = getTask(link.taskId);
    const enrolled = getEnrollment(current.enrollmentId);
    if (enrolled.projectId !== projectId)
      throw new Error(
        "cross-task: trusted tool project context does not match the linked task's enrolled project.",
      );
    return { link, current, enrolled };
  };
  const runAgentTool = async (action: () => Promise<unknown>) => {
    try {
      // Fire-and-forget for the same admission-ordering reason as RPC
      // mutation routes; the maintenance gate coordinates with the action.
      void ensureDailyBackup().catch(() => undefined);
      return toolResult(await maintenance.runMutation(action));
    } catch (error) {
      return toolResult(
        {
          ok: false,
          message: String(error instanceof Error ? error.message : error).slice(
            0,
            1000,
          ),
        },
        true,
      );
    }
  };
  bb.agents.registerTool({
    name: "task_workspace_read_current_task",
    description:
      "Read the task currently and durably linked to this BB conversation, including its current memory and revision tokens.",
    instructions:
      "This tool derives the task from trusted BB thread context. A task ID in conversation text never authorizes another task.",
    parameters: z.object({}).strict(),
    execute: (_input, ctx) =>
      runAgentTool(async () => {
        const epoch = dataset().id;
        const first = linkedAgentTask(ctx.threadId, ctx.projectId);
        const memory = await memoryCoordinator.read(first.current.id);
        if (dataset().id !== epoch)
          throw new Error(
            "stale-dataset: dataset changed during the read; retry for current context.",
          );
        const second = linkedAgentTask(ctx.threadId, ctx.projectId);
        if (
          second.current.id !== first.current.id ||
          second.link.linkRevision !== first.link.linkRevision
        )
          throw new Error(
            "stale-link: linkage changed during the read; retry for current task context.",
          );
        return {
          ok: true,
          datasetEpoch: epoch,
          linkRevision: second.link.linkRevision,
          task: second.current,
          memory,
        };
      }),
  });
  bb.agents.registerTool({
    name: "task_workspace_save_memory",
    description:
      "Revision-check and replace the canonical Markdown memory of the task currently linked to this conversation.",
    instructions:
      "First call task_workspace_read_current_task. Supply its exact link revision and memory token. On a stale or uncertain result, reread; never automatically resend an uncertain save.",
    parameters: z
      .object({
        operationId: z.string().uuid(),
        expectedLinkRevision: z.number().int().positive(),
        token: memoryToken,
        content: z.string().max(1024 * 1024),
      })
      .strict(),
    execute: (input, ctx) =>
      runAgentTool(async () => {
        const { link, current } = linkedAgentTask(ctx.threadId, ctx.projectId);
        if (link.linkRevision !== input.expectedLinkRevision)
          throw new Error(
            "stale-link: link authorization revision changed; reread current task context.",
          );
        const result = await memoryCoordinator.save({
          id: current.id,
          operationId: input.operationId,
          token: input.token,
          content: input.content,
          source: {
            kind: "agent",
            route: "agent-tool:task_workspace_save_memory",
            threadId: ctx.threadId,
            sessionId: null,
          },
          authorization: {
            threadId: ctx.threadId,
            linkRevision: input.expectedLinkRevision,
            projectId: ctx.projectId,
          },
        });
        return { ok: "token" in result, result };
      }),
  });
  bb.agents.registerTool({
    name: "task_workspace_ready_for_agent_review",
    description:
      "Advance only the currently linked task from In progress to Ready for agent review using exact task, dataset, and link revisions.",
    instructions:
      "This is the only task-status mutation available to agents. It fails if the task is not exactly In progress or any revision changed.",
    parameters: z
      .object({
        datasetEpoch: z.string().uuid(),
        expectedTaskRevision: z.number().int().positive(),
        expectedLinkRevision: z.number().int().positive(),
      })
      .strict(),
    execute: (input, ctx) =>
      runAgentTool(async () => {
        const { link, current } = linkedAgentTask(ctx.threadId, ctx.projectId);
        if (link.linkRevision !== input.expectedLinkRevision)
          throw new Error(
            "stale-link: link authorization revision changed; reread current task context.",
          );
        return memoryCoordinator.withAuthorizedLink(
          current.id,
          {
            threadId: ctx.threadId,
            linkRevision: input.expectedLinkRevision,
            projectId: ctx.projectId,
          },
          () => {
            let updated: ReturnType<typeof getTask>;
            db.transaction(() => {
              assertDataset(input.datasetEpoch);
              assertCurrentLink(
                current.id,
                ctx.threadId,
                input.expectedLinkRevision,
              );
              const actual = rawTask(current.id);
              if (!actual) throw new Error("Task not found.");
              if (actual.revision !== input.expectedTaskRevision)
                throw new Error(
                  "stale-task: task revision changed; reread current task context.",
                );
              if (actual.memoryRevision === 0)
                throw new Error(
                  "Task memory initialization must recover before task changes.",
                );
              if (actual.status !== "In progress")
                throw new Error(
                  "invalid-status: agent review transition requires the exact current status In progress.",
                );
              const at = new Date().toISOString();
              const result = db
                .prepare(
                  `UPDATE tasks SET workflowStatus='Ready for agent review',revision=revision+1,
                    updatedAt=?,attribution=?,attributionAt=?
                   WHERE id=? AND revision=? AND workflowStatus='In progress'`,
                )
                .run(
                  at,
                  `agent-tool:${ctx.threadId}`,
                  at,
                  current.id,
                  input.expectedTaskRevision,
                );
              if (result.changes !== 1)
                throw new Error(
                  "stale-task: task or status changed at the mutation boundary.",
                );
              updated = getTask(current.id);
            })();
            bb.realtime.publish("changed", {});
            return { ok: true, task: updated! };
          },
        );
      }),
  });
  bb.agents.configure((ctx) => {
    const enrolled = db
      .prepare("SELECT 1 FROM enrollments WHERE projectId=?")
      .get(ctx.project.id);
    return enrolled
      ? {
          tools: [
            "task_workspace_read_current_task",
            "task_workspace_save_memory",
            "task_workspace_ready_for_agent_review",
          ],
          skills: [],
          instructions:
            "Task Workspace tools are authorized solely by this conversation's current durable link. Before a mutation, read current task context and use its exact revisions. A not-linked result is recoverable after a human links the thread.",
        }
      : { tools: [], skills: [] };
  });
  async function discovery() {
    const projects = await bb.sdk.projects.list({ includePersonal: false });
    const hosts = await bb.sdk.hosts.list();
    const candidates = projects.flatMap((project) =>
      project.sources
        .filter(
          (source) =>
            source.type === "local_path" &&
            source.isDefault &&
            hosts.some(
              (candidateHost) =>
                candidateHost.id === source.hostId &&
                candidateHost.status === "connected",
            ),
        )
        .map((source) => ({
          projectId: project.id,
          name: project.name,
          sourceId: source.id,
          hostId: source.hostId!,
          repository: source.path!,
        })),
    );
    return { projects, candidates, hosts };
  }
  async function available(e: Enrollment) {
    const { projects, hosts } = await discovery();
    if (!projects.some((project) => project.id === e.projectId))
      throw new Error(
        "BB project missing; retained enrollment requires human correction.",
      );
    if (
      !projects.some(
        (project) =>
          project.id === e.projectId &&
          project.sources.some(
            (source) =>
              source.type === "local_path" && source.hostId === e.hostId,
          ),
      )
    )
      throw new Error("BB project no longer resolves on enrolled host.");
    if (
      !hosts.some((item) => item.id === e.hostId && item.status === "connected")
    )
      throw new Error("Enrolled host unavailable.");
  }
  class WorkspaceProblem extends Error {
    constructor(
      readonly state: "wrong-environment" | "unavailable" | "tool-error",
      message: string,
    ) {
      super(message);
    }
  }
  async function resolveWorkspace(
    taskId: string,
    override?: Partial<Omit<RepositoryPreparation, "observation">>,
  ) {
    const t = getTask(taskId);
    const e = getEnrollment(t.enrollmentId);
    const row = { ...preparationRow(taskId), ...override };
    if (!row.environmentId)
      throw new WorkspaceProblem(
        "wrong-environment",
        "Select the reusable shared main-checkout BB environment first.",
      );
    let environment;
    try {
      environment = await bb.sdk.environments.get({
        environmentId: row.environmentId,
      });
    } catch (error) {
      throw new WorkspaceProblem(
        "unavailable",
        `Selected BB environment ${row.environmentId} is unavailable or unreadable. The saved identity was retained: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      );
    }
    if (environment.projectId !== e.projectId)
      throw new WorkspaceProblem(
        "wrong-environment",
        `Selected environment belongs to project ${environment.projectId}, not enrolled project ${e.projectId}. No environment was changed.`,
      );
    if (environment.hostId !== e.hostId)
      throw new WorkspaceProblem(
        "wrong-environment",
        `Selected environment belongs to host ${environment.hostId}, not enrolled host ${e.hostId}. No environment was changed.`,
      );
    if (environment.status !== "ready")
      throw new WorkspaceProblem(
        "unavailable",
        `Selected environment is ${environment.status}, not ready. The task and saved identity were retained.`,
      );
    if (
      environment.workspaceProvisionType !== "unmanaged" ||
      environment.managed ||
      environment.isWorktree
    )
      throw new WorkspaceProblem(
        "wrong-environment",
        "Select the explicit reusable unmanaged main-checkout environment; managed or worktree environments are not supported and were not repaired.",
      );
    if (!environment.isGitRepo || !environment.path)
      throw new WorkspaceProblem(
        "wrong-environment",
        "Selected environment is not a ready Git main checkout with a path.",
      );
    let selectedHost;
    try {
      selectedHost = await bb.sdk.hosts.get({ hostId: e.hostId });
    } catch (error) {
      throw new WorkspaceProblem(
        "unavailable",
        `Enrolled host ${e.hostId} is unavailable or unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      );
    }
    if (selectedHost.status !== "connected")
      throw new WorkspaceProblem(
        "unavailable",
        `Enrolled host ${e.hostId} is ${selectedHost.status}, not connected.`,
      );
    let project;
    try {
      project = await bb.sdk.projects.get({ projectId: e.projectId });
    } catch (error) {
      throw new WorkspaceProblem(
        "unavailable",
        `Enrolled BB project ${e.projectId} is unavailable or unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      );
    }
    if (
      !project.sources.some(
        (source) =>
          source.type === "local_path" &&
          source.hostId === e.hostId &&
          (source.path === environment.path || source.path === e.repository),
      )
    )
      throw new WorkspaceProblem(
        "wrong-environment",
        "Enrolled project no longer has the selected main repository source on the enrolled host. Use explicit repository reassociation.",
      );
    let inventory: Inventory;
    try {
      inventory = await host.call(
        "inspectRepository",
        { repository: environment.path },
        { hostId: environment.hostId },
      );
    } catch (error) {
      throw new WorkspaceProblem(
        "tool-error",
        String(error instanceof Error ? error.message : error).slice(0, 4000),
      );
    }
    if (inventory.repository !== e.repository)
      throw new WorkspaceProblem(
        "wrong-environment",
        `Selected environment resolves to ${inventory.repository}, not enrolled repository ${e.repository}. No checkout or setup repair was run.`,
      );
    return { row, enrollment: e, environment, inventory };
  }
  async function observeTask(id: string) {
    const current = getTask(id);
    const row = preparationRow(id);
    if (!row.environmentId) return current;
    try {
      const { inventory } = await resolveWorkspace(id);
      return getTask(id, dependencyMap(), classify(row, inventory));
    } catch (error) {
      const problem =
        error instanceof WorkspaceProblem
          ? error
          : new WorkspaceProblem("tool-error", String(error));
      return getTask(
        id,
        dependencyMap(),
        defaultObservation(problem.state, problem.message),
      );
    }
  }
  const assertRepositoryRevision = (
    id: string,
    datasetEpoch: string,
    expectedRevision: number,
  ) => {
    if (dataset().id !== datasetEpoch)
      throw new Error("Dataset changed; reload before repository preparation.");
    const current = rawTask(id);
    if (!current) throw new Error("Task not found.");
    if (current.memoryRevision === 0)
      throw new Error(
        "Task memory initialization must recover before repository preparation.",
      );
    if (preparationRow(id).revision !== expectedRevision) {
      throw new Error(
        "Repository preparation changed; reload and reapply your explicit choice.",
      );
    }
  };
  const savePreparation = (
    id: string,
    datasetEpoch: string,
    expectedRevision: number,
    values: {
      environmentId?: string;
      branchName?: string;
      parentBranchName?: string | null;
      preparedAt?: string | null;
      projectId?: string;
      hostId?: string;
      repository?: string;
    },
  ) => {
    const now = new Date().toISOString();
    db.transaction(() => {
      assertRepositoryRevision(id, datasetEpoch, expectedRevision);
      const current = preparationRow(id);
      const next = { ...current, ...values };
      const result = db
        .prepare(
          `UPDATE repository_workspaces SET projectId=?,hostId=?,repository=?,environmentId=?,branchName=?,parentBranchName=?,preparedAt=?,revision=revision+1,updatedAt=? WHERE taskId=? AND revision=?`,
        )
        .run(
          next.projectId,
          next.hostId,
          next.repository,
          next.environmentId,
          next.branchName,
          next.parentBranchName,
          next.preparedAt,
          now,
          id,
          expectedRevision,
        );
      if (result.changes !== 1) {
        throw new Error(
          "Repository preparation changed; reload and reapply your explicit choice.",
        );
      }
    })();
    bb.realtime.publish("changed", {});
    return preparationRow(id);
  };
  let repositoryTail: Promise<void> = Promise.resolve();
  const serializeRepository = <T>(operation: () => Promise<T>) => {
    const result = repositoryTail.then(operation, operation);
    repositoryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const resolveWayfinderWorkspace = async (taskId: string) => {
    const resolved = await resolveWorkspace(taskId);
    const observation = classify(resolved.row, resolved.inventory);
    if (
      observation.state !== "ready" ||
      !resolved.row.environmentId ||
      !resolved.row.branchName
    )
      throw new Error(
        `Wayfinder source is unavailable until ticket03 repository preparation is currently ready: ${observation.message} No branch or workspace was changed.`,
      );
    return {
      ...resolved,
      environmentId: resolved.row.environmentId,
      branchName: resolved.row.branchName,
    };
  };
  const readWayfinderHost = async (
    taskId: string,
    mapPath: string,
    selectedDirectory: string | null,
  ) => {
    const workspace = await resolveWayfinderWorkspace(taskId);
    const source = await host.call(
      "readWayfinderSource",
      {
        repository: workspace.inventory.repository,
        mapPath,
        selectedDirectory,
      },
      { hostId: workspace.enrollment.hostId },
    );
    if (source.repository !== workspace.inventory.repository)
      throw new Error(
        "Host reader returned another repository identity. The saved attachment was not changed.",
      );
    return { workspace, source };
  };
  const stopWayfinderWatch = async (watchId: string, hostId: string) => {
    wayfinderWatchOwners.delete(watchId);
    await host.call("stopWayfinderWatch", { watchId }, { hostId });
  };
  const beginWayfinderView = (viewId: string, taskId: string) => {
    if (closedWayfinderViews.has(viewId))
      throw new Error("This Wayfinder drawer was closed; open a new view.");
    let view = wayfinderViews.get(viewId);
    if (!view) {
      view = {
        viewId,
        taskId,
        generation: 0,
        closed: false,
        inFlight: 0,
        activeWatch: null,
        pendingWatches: new Map(),
      };
      wayfinderViews.set(viewId, view);
    }
    if (view.closed)
      throw new Error("This Wayfinder drawer was closed; open a new view.");
    if (view.taskId !== taskId)
      throw new Error("A Wayfinder view cannot be reused for another task.");
    view.generation += 1;
    view.inFlight += 1;
    return { view, generation: view.generation };
  };
  const isCurrentWayfinderView = (
    view: WayfinderViewSession,
    generation: number,
  ) =>
    wayfinderViews.get(view.viewId) === view &&
    !view.closed &&
    view.generation === generation;
  const assertCurrentWayfinderView = (
    view: WayfinderViewSession,
    generation: number,
  ) => {
    if (!isCurrentWayfinderView(view, generation))
      throw new Error(
        "Wayfinder view generation was closed or superseded; the late result was discarded.",
      );
  };
  const finishWayfinderView = (view: WayfinderViewSession) => {
    view.inFlight -= 1;
    if (view.closed && view.inFlight === 0) wayfinderViews.delete(view.viewId);
  };
  const closeWayfinderSession = async (viewId: string) => {
    closedWayfinderViews.add(viewId);
    const view = wayfinderViews.get(viewId);
    if (!view) return;
    view.closed = true;
    view.generation += 1;
    const watches = [
      ...(view.activeWatch ? [view.activeWatch] : []),
      ...[...view.pendingWatches].map(([watchId, hostId]) => ({
        watchId,
        hostId,
      })),
    ];
    view.activeWatch = null;
    view.pendingWatches.clear();
    await Promise.allSettled(
      watches.map(({ watchId, hostId }) => stopWayfinderWatch(watchId, hostId)),
    );
    if (view.inFlight === 0) wayfinderViews.delete(viewId);
  };
  type RpcHandlers = Parameters<typeof bb.rpc.register<typeof rpcContract>>[1];
  const rpcHandlers: RpcHandlers = {
    list: async () => {
      let candidates: Awaited<ReturnType<typeof discovery>>["candidates"] = [];
      let discoveryError: string | null = null;
      let projectIds: Set<string> | null = null;
      let connectedHosts = new Set<string>();
      let sourceHosts = new Set<string>();
      try {
        const result = await discovery();
        candidates = result.candidates;
        connectedHosts = new Set(
          result.hosts
            .filter((item) => item.status === "connected")
            .map((item) => item.id),
        );
        projectIds = new Set(result.projects.map((item) => item.id));
        sourceHosts = new Set(
          result.projects.flatMap((project) =>
            project.sources
              .filter((source) => source.type === "local_path")
              .map((source) => `${project.id}:${source.hostId}`),
          ),
        );
      } catch {
        discoveryError =
          "BB project discovery unavailable. Last-known identities are retained.";
      }
      const rows = [];
      for (const item of tasks()) {
        await memoryCoordinator.read(item.id);
        for (const link of linkedThreads(item.id))
          await readThreadReference(item.id, link.threadId).catch(
            () => undefined,
          );
        rows.push(await observeTask(item.id));
      }
      return {
        datasetEpoch: dataset().id,
        tasks: rows,
        startOperations: startOperations(),
        candidates,
        discoveryError,
        backup: dataset().hostId
          ? await host.call(
              "archiveStatus",
              { dataset: dataset().id, hostId: dataset().hostId! },
              { hostId: dataset().hostId! },
            )
          : {
              state: "not-yet-created" as const,
              localDay: new Date().toISOString().slice(0, 10),
              observedAt: new Date().toISOString(),
              lastAttemptAt: null,
              lastSuccessfulAt: null,
              lastSuccessfulLocalDay: null,
              lastSuccessfulPath: null,
              dailyArchiveCount: 0,
              error: null,
              warning: null,
            },
        enrollments: enrollments().map((item) => ({
          ...item,
          availability:
            projectIds === null
              ? "unavailable"
              : !projectIds.has(item.projectId)
                ? "missing project"
                : connectedHosts.has(item.hostId) &&
                    sourceHosts.has(`${item.projectId}:${item.hostId}`)
                  ? "available"
                  : "project or host unavailable",
        })),
      };
    },
    enroll: async ({ projectId, sourceId, prefix }) => {
      const { candidates } = await discovery();
      const candidate = candidates.find(
        (item) => item.projectId === projectId && item.sourceId === sourceId,
      );
      if (!candidate)
        throw new Error(
          "Choose an available local main repository of an existing BB project.",
        );
      const checked = await host.call(
        "validateRepository",
        { repository: candidate.repository },
        { hostId: candidate.hostId },
      );
      const id = randomUUID(),
        now = new Date().toISOString();
      db.transaction(() => {
        if (dataset().hostId && dataset().hostId !== candidate.hostId)
          throw new Error("This dataset is local to its enrolled host.");
        if (
          db
            .prepare("SELECT id FROM enrollments WHERE projectId=? OR prefix=?")
            .get(projectId, prefix)
        )
          throw new Error("Project or prefix is already enrolled.");
        db.prepare("UPDATE dataset SET hostId=?").run(candidate.hostId);
        db.prepare(
          "INSERT INTO enrollments(id,projectId,hostId,repository,name,prefix,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          id,
          projectId,
          candidate.hostId,
          checked.repository,
          candidate.name,
          prefix,
          now,
          now,
        );
      })();
      bb.realtime.publish("changed", {});
      return getEnrollment(id);
    },
    create: async ({ enrollmentId, title, description }) => {
      await available(getEnrollment(enrollmentId));
      const id = randomUUID(),
        operationId = randomUUID(),
        now = new Date().toISOString();
      db.transaction(() => {
        const e = getEnrollment(enrollmentId);
        db.prepare(
          "INSERT INTO tasks(id,enrollmentId,number,displayId,title,description,status,workflowStatus,createdAt,updatedAt,attribution,attributionAt,memoryState) VALUES(?,?,?,?,?,?,'Inbox','Inbox',?,?, 'rpc:create',?,'pending')",
        ).run(
          id,
          e.id,
          e.nextNumber,
          `${e.prefix}-${e.nextNumber}`,
          title,
          description,
          now,
          now,
          now,
        );
        db.prepare(
          "UPDATE enrollments SET nextNumber=nextNumber+1,revision=revision+1,updatedAt=? WHERE id=?",
        ).run(now, e.id);
        db.prepare(
          "INSERT INTO memory_operation_ids(id,taskId,kind,intendedHash) VALUES(?,?,'initialize-memory',?)",
        ).run(operationId, id, EMPTY_MEMORY_HASH);
        db.prepare(
          `INSERT INTO memory_operations(
            id,taskId,kind,state,datasetEpoch,oldRevision,oldHash,expectedActualHash,
            intendedHash,attributionKind,attributionRoute,createdAt,updatedAt)
           VALUES(?,?,'initialize-memory','prepared',?,0,NULL,NULL,?,'initialization','rpc:create',?,?)`,
        ).run(operationId, id, dataset().id, EMPTY_MEMORY_HASH, now, now);
        db.prepare(
          "INSERT INTO repository_workspaces(taskId,projectId,hostId,repository,updatedAt) VALUES(?,?,?,?,?)",
        ).run(id, e.projectId, e.hostId, e.repository, now);
      })();
      await memoryCoordinator.initialize(id);
      const result = getTask(id);
      bb.realtime.publish("changed", {});
      return result;
    },
    updateDetails: ({
      id,
      datasetEpoch,
      expectedRevision,
      title,
      description,
    }) =>
      mutate(id, datasetEpoch, expectedRevision, "rpc:updateDetails", () => {
        db.prepare("UPDATE tasks SET title=?,description=? WHERE id=?").run(
          title,
          description,
          id,
        );
      }),
    setStatus: ({
      id,
      datasetEpoch,
      expectedRevision,
      status: nextStatus,
      blockerReason,
    }) => {
      if (nextStatus === "Blocked" && !blockerReason)
        throw new Error("A blocker reason is required.");
      if (nextStatus !== "Blocked" && blockerReason !== null)
        throw new Error("Blocker reason is only stored while Blocked.");
      return mutate(id, datasetEpoch, expectedRevision, "rpc:setStatus", () => {
        db.prepare(
          "UPDATE tasks SET workflowStatus=?,blockerReason=? WHERE id=?",
        ).run(nextStatus, blockerReason, id);
      });
    },
    replaceRelationships: ({
      id,
      datasetEpoch,
      expectedRevision,
      dependencyIds,
      blockerTaskIds,
    }) => {
      for (const values of [dependencyIds, blockerTaskIds]) {
        if (new Set(values).size !== values.length)
          throw new Error("Duplicate task relationship.");
        if (values.includes(id))
          throw new Error("A task cannot reference itself.");
        for (const targetId of values)
          if (!rawTask(targetId)) throw new Error("Referenced task not found.");
      }
      return mutate(
        id,
        datasetEpoch,
        expectedRevision,
        "rpc:replaceRelationships",
        () => {
          db.prepare("DELETE FROM task_relationships WHERE taskId=?").run(id);
          const insert = db.prepare(
            "INSERT INTO task_relationships(taskId,targetTaskId,kind) VALUES(?,?,?)",
          );
          for (const targetId of dependencyIds)
            insert.run(id, targetId, "depends-on");
          for (const targetId of blockerTaskIds)
            insert.run(id, targetId, "blocker-reference");
        },
      );
    },
    replacePaths: ({ id, datasetEpoch, expectedRevision, paths }) => {
      const ids = paths.flatMap((value) => (value.id ? [value.id] : []));
      if (new Set(ids).size !== ids.length)
        throw new Error("Duplicate path attachment ID.");
      for (const pathId of ids) {
        const owner = db
          .prepare("SELECT taskId FROM attached_paths WHERE id=?")
          .get(pathId) as { taskId: string } | undefined;
        if (!owner || owner.taskId !== id)
          throw new Error("Path attachment does not belong to this task.");
      }
      const enrollmentRow = getEnrollment(getTask(id).enrollmentId);
      return mutate(
        id,
        datasetEpoch,
        expectedRevision,
        "rpc:replacePaths",
        () => {
          db.prepare("DELETE FROM attached_paths WHERE taskId=?").run(id);
          const insert = db.prepare(
            "INSERT INTO attached_paths(id,taskId,hostId,path,label,position) VALUES(?,?,?,?,?,?)",
          );
          paths.forEach((value, position) =>
            insert.run(
              value.id ?? randomUUID(),
              id,
              enrollmentRow.hostId,
              value.path,
              value.label || null,
              position,
            ),
          );
        },
      );
    },
    retryMemory: async ({ id }) => {
      await memoryCoordinator.read(id);
      const result = getTask(id);
      bb.realtime.publish("changed", {});
      return result;
    },
    readMemory: ({ id }) => memoryCoordinator.read(id),
    saveMemory: (input) => memoryCoordinator.save(input),
    acceptExternalMemory: (input) => memoryCoordinator.acceptExternal(input),
    restoreKnownMemory: (input) => memoryCoordinator.restoreKnown(input),
    startLinkedThread: (input) => runStart(input),
    getStartOperation: ({ id, operationId }) => readStart(id, operationId),
    retryStartLink: ({ id, operationId, datasetEpoch }) => {
      const operation = readStart(id, operationId);
      assertStartEpoch(operation, datasetEpoch);
      if (operation.abandonedAt)
        throw new Error("This start operation was explicitly abandoned.");
      return completeStartLink(id, operationId, datasetEpoch);
    },
    identifyStartThread: async ({
      id,
      operationId,
      datasetEpoch,
      threadId,
      expectedCurrentLinkRevision,
      reassign,
    }) => {
      const operation = readStart(id, operationId);
      assertStartEpoch(operation, datasetEpoch);
      if (operation.abandonedAt)
        throw new Error("This start operation was explicitly abandoned.");
      if (!["uncertain", "awaiting-link"].includes(operation.state))
        throw new Error(
          "Only an uncertain or awaiting-link start can be reconciled by exact thread ID.",
        );
      if (operation.threadId && operation.threadId !== threadId)
        throw new Error(
          `This operation already recorded thread ${operation.threadId}; another ID cannot replace it.`,
        );
      const thread = await bb.sdk.threads.get({ threadId });
      const enrolled = getEnrollment(getTask(id).enrollmentId);
      if (thread.deletedAt || thread.projectId !== enrolled.projectId)
        throw new Error(
          "The explicitly identified conversation is deleted or belongs to another project.",
        );
      await validateStartedThreadEnvironment(id, operation, thread);
      db.transaction(() => {
        assertDataset(datasetEpoch);
        const latest = readStart(id, operationId);
        assertStartEpoch(latest, datasetEpoch);
        if (latest.abandonedAt)
          throw new Error("This start operation was explicitly abandoned.");
        if (latest.threadId && latest.threadId !== threadId)
          throw new Error("Start operation thread identity changed.");
        if (!["uncertain", "awaiting-link"].includes(latest.state))
          throw new Error(
            "Start operation state changed; reread before reconciling.",
          );
        setStartState(operationId, "awaiting-link", null, threadId);
      })();
      return completeStartLink(
        id,
        operationId,
        datasetEpoch,
        expectedCurrentLinkRevision,
        reassign,
      );
    },
    abandonStartOperation: ({ id, operationId, datasetEpoch }) => {
      const operation = readStart(id, operationId);
      assertStartEpoch(operation, datasetEpoch);
      if (operation.state === "linked")
        throw new Error("A linked start cannot be abandoned.");
      db.transaction(() => {
        assertDataset(datasetEpoch);
        const latest = readStart(id, operationId);
        assertStartEpoch(latest, datasetEpoch);
        if (latest.state === "linked")
          throw new Error("A linked start cannot be abandoned.");
        if (!latest.abandonedAt) {
          const now = new Date().toISOString();
          const result = db
            .prepare(
              `UPDATE thread_start_operations SET abandonedAt=?,updatedAt=?
               WHERE id=? AND taskId=? AND datasetEpoch=? AND state<>'linked'
               AND abandonedAt IS NULL`,
            )
            .run(now, now, operationId, id, datasetEpoch);
          if (result.changes !== 1)
            throw new Error(
              "Thread start operation changed before abandonment.",
            );
        }
      })();
      bb.realtime.publish("changed", {});
      return readStart(id, operationId);
    },
    inspectThreadCandidate: async ({ id, datasetEpoch, threadId }) => {
      assertDataset(datasetEpoch);
      const enrolled = getEnrollment(getTask(id).enrollmentId);
      let thread;
      try {
        thread = await bb.sdk.threads.get({ threadId });
      } catch (error) {
        throw new Error(
          `BB could not validate thread ${threadId}. It is unavailable, not confirmed missing: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
        );
      }
      if (thread.deletedAt)
        throw new Error(`BB confirms thread ${threadId} is deleted.`);
      if (thread.projectId !== enrolled.projectId)
        throw new Error(
          `Thread belongs to BB project ${thread.projectId}, not enrolled project ${enrolled.projectId}.`,
        );
      const environment = await environmentMismatch(id, thread.environmentId);
      const existing = currentLink(threadId);
      return {
        threadId,
        title: thread.title ?? thread.titleFallback,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        hostId: environment.hostId,
        availability: thread.archivedAt
          ? ("archived" as const)
          : ("available" as const),
        runtimeStatus: thread.status,
        environmentMismatch: environment.mismatch,
        currentLink: existing
          ? {
              taskId: existing.taskId,
              displayId: getTask(existing.taskId).displayId,
              linkRevision: existing.linkRevision,
            }
          : null,
      };
    },
    linkThread: async ({
      id,
      datasetEpoch,
      threadId,
      expectedCurrentLinkRevision,
      reassign,
    }) => {
      assertDataset(datasetEpoch);
      let thread;
      try {
        thread = await bb.sdk.threads.get({ threadId });
      } catch (error) {
        throw new Error(
          `BB could not validate thread ${threadId}; nothing was linked. This is unavailable, not confirmed missing: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
        );
      }
      return linkValidatedThread({
        taskId: id,
        expectedEpoch: datasetEpoch,
        thread,
        expectedCurrentLinkRevision,
        reassign,
      });
    },
    refreshThreadLink: async ({
      id,
      datasetEpoch,
      threadId,
      expectedLinkRevision,
    }) => {
      assertDataset(datasetEpoch);
      assertCurrentLink(id, threadId, expectedLinkRevision);
      return readThreadReference(id, threadId);
    },
    sendTaskContext: async ({
      id,
      datasetEpoch,
      threadId,
      expectedLinkRevision,
    }) => {
      assertDataset(datasetEpoch);
      assertCurrentLink(id, threadId, expectedLinkRevision);
      return memoryCoordinator.withAuthorizedLink(
        id,
        {
          threadId,
          linkRevision: expectedLinkRevision,
          projectId: getEnrollment(getTask(id).enrollmentId).projectId,
        },
        async (locked) => {
          assertDataset(datasetEpoch);
          const enrolled = getEnrollment(getTask(id).enrollmentId);
          const thread = await bb.sdk.threads.get({ threadId });
          assertCurrentLink(id, threadId, expectedLinkRevision);
          if (thread.deletedAt)
            throw new Error(
              "BB confirms this thread is deleted. Context was not sent.",
            );
          if (thread.projectId !== enrolled.projectId)
            throw new Error(
              "Thread project changed and no longer matches the task. Context was not sent.",
            );
          const memory = await locked.read();
          assertDataset(datasetEpoch);
          assertCurrentLink(id, threadId, expectedLinkRevision);
          if (
            getEnrollment(getTask(id).enrollmentId).projectId !==
            thread.projectId
          )
            throw new Error(
              "Task enrollment changed while context was assembled. Context was not sent.",
            );
          const context = renderTaskContext(id, memory);
          const result = await bb.sdk.threads.send({
            threadId,
            mode: "auto",
            input: [{ type: "text", text: context, mentions: [] }],
          });
          return {
            delivery: result.delivery,
            message:
              result.delivery === "queued"
                ? "Current task context was accepted into BB's queue. It will not be resent automatically."
                : "Current task context was sent once by explicit human action.",
          };
        },
      );
    },
    releaseIdleThreadRuntime: async ({
      id,
      datasetEpoch,
      threadId,
      expectedLinkRevision,
    }) =>
      memoryCoordinator.withAuthorizedLink(
        id,
        {
          threadId,
          linkRevision: expectedLinkRevision,
          projectId: getEnrollment(getTask(id).enrollmentId).projectId,
        },
        async () => {
          assertDataset(datasetEpoch);
          const enrolled = getEnrollment(getTask(id).enrollmentId);
          const thread = await bb.sdk.threads.get({ threadId });
          assertCurrentLink(id, threadId, expectedLinkRevision);
          if (thread.projectId !== enrolled.projectId)
            throw new Error(
              `Thread belongs to project ${thread.projectId}, but the task is now enrolled in ${enrolled.projectId}. The idle runtime was not released.`,
            );
          if (thread.status !== "idle")
            throw new Error(
              `Thread runtime is ${thread.status}, not idle. Active work was not stopped.`,
            );
          await bb.sdk.threads.stop({ threadId });
          return {
            released: true as const,
            message:
              "Idle runtime released explicitly and no message was sent. This host may resume the persisted provider session without newly registered tools. If tools remain unavailable, use BB's normal New thread flow in the enrolled project, link that new conversation, then explicitly send current task context; nothing is restarted or duplicated automatically.",
          };
        },
      ),
    selectRepositoryEnvironment: ({
      id,
      datasetEpoch,
      expectedRepositoryRevision,
      environmentId,
    }) =>
      serializeRepository(async () => {
        assertRepositoryRevision(id, datasetEpoch, expectedRepositoryRevision);
        const { inventory } = await resolveWorkspace(id, { environmentId });
        assertRepositoryRevision(id, datasetEpoch, expectedRepositoryRevision);
        const saved = savePreparation(
          id,
          datasetEpoch,
          expectedRepositoryRevision,
          { environmentId },
        );
        return { ...saved, observation: classify(saved, inventory) };
      }),
    prepareRepository: ({
      id,
      datasetEpoch,
      expectedRepositoryRevision,
      action,
      branchName,
      parentBranchName,
    }) =>
      serializeRepository(async () => {
        assertRepositoryRevision(id, datasetEpoch, expectedRepositoryRevision);
        const stacked =
          action === "create-stacked" ||
          action === "associate-stacked" ||
          action === "restack-existing";
        if (stacked !== Boolean(parentBranchName))
          throw new Error(
            stacked
              ? "This explicit stacked action requires an exact prerequisite branch name."
              : "This explicit independent action must not name a prerequisite branch.",
          );
        if (branchName === parentBranchName)
          throw new Error("A task branch cannot be stacked above itself.");
        const resolved = await resolveWorkspace(id);
        assertRepositoryRevision(id, datasetEpoch, expectedRepositoryRevision);
        const prospective = {
          ...resolved.row,
          branchName,
          parentBranchName,
        };
        const before = classify(prospective, resolved.inventory);
        let inventory = resolved.inventory;
        if (action.startsWith("associate-")) {
          if (before.state !== "ready") throw new Error(before.message);
        } else if (action.startsWith("create-")) {
          if (before.state !== "missing")
            throw new Error(
              `Branch ${branchName} already exists or is not safe to recreate. Choose explicit association or correct the reported state.`,
            );
          assertRepositoryRevision(
            id,
            datasetEpoch,
            expectedRepositoryRevision,
          );
          inventory = await host.call(
            "mutateBranch",
            {
              repository: resolved.inventory.repository,
              action:
                action === "create-stacked"
                  ? "create-stacked"
                  : "create-independent",
              branchName,
              parentBranchName,
            },
            { hostId: resolved.environment.hostId },
          );
        } else if (before.state !== "ready") {
          assertRepositoryRevision(
            id,
            datasetEpoch,
            expectedRepositoryRevision,
          );
          inventory = await host.call(
            "mutateBranch",
            {
              repository: resolved.inventory.repository,
              action: "restack-existing",
              branchName,
              parentBranchName,
            },
            { hostId: resolved.environment.hostId },
          );
        }
        const after = classify(prospective, inventory);
        if (after.state !== "ready")
          throw new Error(
            `Repository state changed during preparation: ${after.message} The task, status, memory and thread references were retained.`,
          );
        assertRepositoryRevision(id, datasetEpoch, expectedRepositoryRevision);
        const saved = savePreparation(
          id,
          datasetEpoch,
          expectedRepositoryRevision,
          {
            branchName,
            parentBranchName,
            preparedAt: new Date().toISOString(),
          },
        );
        return { ...saved, observation: classify(saved, inventory) };
      }),
    inspectWayfinderSource: async ({
      id,
      datasetEpoch,
      mapPath,
      selectedDirectory,
    }) => {
      assertDataset(datasetEpoch);
      const repositoryRevision = preparationRow(id).revision;
      const { source } = await readWayfinderHost(
        id,
        mapPath,
        selectedDirectory,
      );
      assertDataset(datasetEpoch);
      if (preparationRow(id).revision !== repositoryRevision)
        throw new Error(
          "Repository preparation changed during source inspection. The candidate result was discarded.",
        );
      return source;
    },
    saveWayfinderAttachment: async ({
      id,
      datasetEpoch,
      expectedAttachmentRevision,
      mapPath,
      selectedDirectory,
    }) => {
      assertDataset(datasetEpoch);
      const repositoryRevision = preparationRow(id).revision;
      const existing = wayfinderAttachmentRow(id);
      if ((existing?.revision ?? 0) !== expectedAttachmentRevision)
        throw new Error(
          "Wayfinder attachment changed; reread before replacing its source identity.",
        );
      const { workspace, source } = await readWayfinderHost(
        id,
        mapPath,
        selectedDirectory,
      );
      if (!source.selectedDirectory || source.status === "selection-required")
        throw new Error(
          "Both or neither sibling ticket directories are selectable. Persist an explicit human issues/ or tickets/ choice.",
        );
      const now = new Date().toISOString();
      db.transaction(() => {
        assertDataset(datasetEpoch);
        if (preparationRow(id).revision !== repositoryRevision)
          throw new Error(
            "Repository preparation changed before the attachment could be saved.",
          );
        const current = wayfinderAttachmentRow(id);
        if ((current?.revision ?? 0) !== expectedAttachmentRevision)
          throw new Error(
            "Wayfinder attachment changed; reread before replacing it.",
          );
        if (current)
          db.prepare(
            `UPDATE wayfinder_attachments SET projectId=?,hostId=?,repository=?,
              mapPath=?,selectedDirectory=?,revision=revision+1,updatedAt=?
             WHERE taskId=? AND revision=?`,
          ).run(
            workspace.enrollment.projectId,
            workspace.enrollment.hostId,
            source.repository,
            source.mapPath,
            source.selectedDirectory,
            now,
            id,
            expectedAttachmentRevision,
          );
        else
          db.prepare(
            `INSERT INTO wayfinder_attachments(
              taskId,projectId,hostId,repository,mapPath,selectedDirectory,revision,updatedAt)
             VALUES(?,?,?,?,?,?,1,?)`,
          ).run(
            id,
            workspace.enrollment.projectId,
            workspace.enrollment.hostId,
            source.repository,
            source.mapPath,
            source.selectedDirectory,
            now,
          );
      })();
      bb.realtime.publish("changed", {});
      return wayfinderAttachment.parse(wayfinderAttachmentRow(id));
    },
    readWayfinderView: async ({ id, datasetEpoch, viewId }) => {
      const authority = beginWayfinderView(viewId, id);
      let ownWatch: { watchId: string; hostId: string } | null = null;
      try {
        assertDataset(datasetEpoch);
        const attachment = wayfinderAttachmentRow(id);
        if (!attachment) throw new Error("Attach a Wayfinder map first.");
        const attachmentRevision = attachment.revision;
        const repositoryRevision = preparationRow(id).revision;
        const enrollmentId = getTask(id).enrollmentId;
        const readDurableAuthority = () => ({
          attachment: wayfinderAttachmentRow(id),
          preparation: preparationRow(id),
          enrollmentId: getTask(id).enrollmentId,
          enrollment: getEnrollment(enrollmentId),
        });
        type DurableAuthority = ReturnType<typeof readDurableAuthority>;
        const sameAttachment = (
          left: DurableAuthority["attachment"],
          right: DurableAuthority["attachment"],
        ) =>
          !!left &&
          !!right &&
          left.revision === right.revision &&
          left.mapPath === right.mapPath &&
          left.selectedDirectory === right.selectedDirectory &&
          left.projectId === right.projectId &&
          left.hostId === right.hostId &&
          left.repository === right.repository;
        const samePreparation = (
          left: DurableAuthority["preparation"],
          right: DurableAuthority["preparation"],
        ) =>
          left.revision === right.revision &&
          left.projectId === right.projectId &&
          left.hostId === right.hostId &&
          left.repository === right.repository &&
          left.environmentId === right.environmentId &&
          left.branchName === right.branchName &&
          left.parentBranchName === right.parentBranchName;
        const sameEnrollment = (
          left: DurableAuthority["enrollment"],
          right: DurableAuthority["enrollment"],
        ) =>
          left.id === right.id &&
          left.revision === right.revision &&
          left.projectId === right.projectId &&
          left.hostId === right.hostId &&
          left.repository === right.repository;
        const assertOriginalAuthority = (current: DurableAuthority) => {
          assertCurrentWayfinderView(authority.view, authority.generation);
          assertDataset(datasetEpoch);
          if (
            current.enrollmentId !== enrollmentId ||
            !sameAttachment(current.attachment, attachment) ||
            current.preparation.revision !== repositoryRevision
          )
            throw new Error(
              "Attachment or workspace identity changed while reading. The late generation was discarded.",
            );
        };
        const validateDurableAuthority = async () => {
          const before = readDurableAuthority();
          assertOriginalAuthority(before);
          const validatedWorkspace = await resolveWayfinderWorkspace(id);
          const after = readDurableAuthority();
          assertOriginalAuthority(after);
          if (
            !sameAttachment(before.attachment, after.attachment) ||
            !samePreparation(before.preparation, after.preparation) ||
            !sameEnrollment(before.enrollment, after.enrollment) ||
            !samePreparation(after.preparation, validatedWorkspace.row) ||
            !sameEnrollment(after.enrollment, validatedWorkspace.enrollment)
          )
            throw new Error(
              "Attachment, repository preparation or enrollment changed during workspace validation. The late generation was discarded.",
            );
          if (
            attachment.projectId !== validatedWorkspace.enrollment.projectId ||
            attachment.hostId !== validatedWorkspace.enrollment.hostId ||
            attachment.repository !== validatedWorkspace.inventory.repository
          )
            throw new Error(
              "The persisted Wayfinder attachment belongs to an older repository identity. Relink it explicitly; no same-path source in the replacement repository was read.",
            );
          return { durable: after, workspace: validatedWorkspace };
        };
        const assertSealedAuthority = (
          seal: Awaited<ReturnType<typeof validateDurableAuthority>>,
        ) => {
          const current = readDurableAuthority();
          assertOriginalAuthority(current);
          if (
            !sameAttachment(current.attachment, seal.durable.attachment) ||
            !samePreparation(current.preparation, seal.durable.preparation) ||
            !sameEnrollment(current.enrollment, seal.durable.enrollment) ||
            !samePreparation(current.preparation, seal.workspace.row) ||
            !sameEnrollment(current.enrollment, seal.workspace.enrollment)
          )
            throw new Error(
              "Attachment, repository preparation or enrollment changed before publication. The current graph was discarded.",
            );
          return current.attachment!;
        };
        await validateDurableAuthority();
        let { workspace, source } = await readWayfinderHost(
          id,
          attachment.mapPath,
          attachment.selectedDirectory,
        );
        assertCurrentWayfinderView(authority.view, authority.generation);
        let refreshState:
          "current" | "degraded" | "source-changing" | "incomplete";
        const watchId = randomUUID();
        ownWatch = { watchId, hostId: workspace.enrollment.hostId };
        authority.view.pendingWatches.set(watchId, ownWatch.hostId);
        wayfinderWatchOwners.set(watchId, {
          view: authority.view,
          generation: authority.generation,
          hostId: ownWatch.hostId,
        });
        try {
          await host.call(
            "startWayfinderWatch",
            {
              watchId,
              repository: source.repository,
              watchRoot: source.watchRoot,
            },
            { hostId: ownWatch.hostId },
          );
          assertCurrentWayfinderView(authority.view, authority.generation);
          ({ workspace, source } = await readWayfinderHost(
            id,
            attachment.mapPath,
            attachment.selectedDirectory,
          ));
          assertCurrentWayfinderView(authority.view, authority.generation);
          refreshState =
            source.status === "ready"
              ? "current"
              : source.status === "source-changing"
                ? "source-changing"
                : "incomplete";
        } catch (error) {
          if (!isCurrentWayfinderView(authority.view, authority.generation))
            throw error;
          refreshState = "degraded";
          bb.log.warn(
            `Wayfinder watch could not start for ${id}: ${boundedError(error)}`,
          );
        }
        const publicationSeal = await validateDurableAuthority();
        const graph = wayfinderGraph.parse(
          readWayfinderSnapshot({
            map: source.map,
            selectedDirectory: attachment.selectedDirectory,
            tickets: source.tickets,
            discoveryComplete: source.discoveryComplete,
            discoveryDiagnostics: source.diagnostics,
            effortDirectoryName:
              posix.basename(posix.dirname(attachment.mapPath)) ||
              posix.basename(attachment.mapPath),
          }),
        );
        assertCurrentWayfinderView(authority.view, authority.generation);
        const previous = authority.view.activeWatch;
        if (refreshState !== "degraded" && ownWatch) {
          authority.view.pendingWatches.delete(ownWatch.watchId);
          authority.view.activeWatch = ownWatch;
          ownWatch = null;
          if (previous)
            await stopWayfinderWatch(previous.watchId, previous.hostId).catch(
              () => undefined,
            );
        } else if (ownWatch) {
          authority.view.pendingWatches.delete(ownWatch.watchId);
          await stopWayfinderWatch(ownWatch.watchId, ownWatch.hostId).catch(
            () => undefined,
          );
          ownWatch = null;
        }
        const currentAttachment = assertSealedAuthority(publicationSeal);
        return {
          attachment: currentAttachment,
          graph,
          scanTime: source.scanTime,
          sourceRevision: source.sourceRevision,
          workspaceLabel: "Combined working-copy view" as const,
          environmentId: publicationSeal.workspace.environmentId,
          branchName: publicationSeal.workspace.branchName,
          refreshState,
        };
      } catch (error) {
        if (ownWatch) {
          authority.view.pendingWatches.delete(ownWatch.watchId);
          await stopWayfinderWatch(ownWatch.watchId, ownWatch.hostId).catch(
            () => undefined,
          );
        }
        if (isCurrentWayfinderView(authority.view, authority.generation)) {
          const obsolete = authority.view.activeWatch;
          authority.view.activeWatch = null;
          if (obsolete)
            await stopWayfinderWatch(obsolete.watchId, obsolete.hostId).catch(
              () => undefined,
            );
        }
        throw error;
      } finally {
        finishWayfinderView(authority.view);
      }
    },
    closeWayfinderView: async ({ viewId }) => {
      await closeWayfinderSession(viewId).catch((error) =>
        bb.log.warn(
          `Wayfinder watch cleanup failed for ${viewId}: ${boundedError(error)}`,
        ),
      );
      return { closed: true as const };
    },
    reassociateEnrollment: ({
      enrollmentId,
      datasetEpoch,
      expectedEnrollmentRevision,
      projectId,
      sourceId,
      environmentId,
    }) =>
      serializeRepository(async () => {
        if (dataset().id !== datasetEpoch)
          throw new Error(
            "Dataset changed; reload before repository correction.",
          );
        const current = getEnrollment(enrollmentId);
        if (current.revision !== expectedEnrollmentRevision)
          throw new Error(
            "Enrollment changed; reload before repository correction.",
          );
        const { candidates } = await discovery();
        const candidate = candidates.find(
          (item) => item.projectId === projectId && item.sourceId === sourceId,
        );
        if (!candidate)
          throw new Error(
            "Choose an available replacement BB project main repository explicitly.",
          );
        if (dataset().hostId && dataset().hostId !== candidate.hostId)
          throw new Error(
            "This dataset is local to its enrolled host; a different host was rejected without repair.",
          );
        const environment = await bb.sdk.environments.get({ environmentId });
        if (
          environment.projectId !== candidate.projectId ||
          environment.hostId !== candidate.hostId ||
          environment.status !== "ready" ||
          environment.workspaceProvisionType !== "unmanaged" ||
          environment.managed ||
          environment.isWorktree ||
          !environment.isGitRepo ||
          !environment.path
        )
          throw new Error(
            "Replacement environment must be the ready reusable unmanaged main checkout for the chosen project, host and repository.",
          );
        const inventory = await host.call(
          "inspectRepository",
          { repository: environment.path },
          { hostId: candidate.hostId },
        );
        const checked = await host.call(
          "validateRepository",
          { repository: candidate.repository },
          { hostId: candidate.hostId },
        );
        if (inventory.repository !== checked.repository)
          throw new Error(
            "Replacement environment path does not resolve to the chosen project repository.",
          );
        const now = new Date().toISOString();
        const affectedTaskIds = (
          db
            .prepare("SELECT id FROM tasks WHERE enrollmentId=? ORDER BY id")
            .all(enrollmentId) as Array<{ id: string }>
        ).map((row) => row.id);
        await memoryCoordinator.withLinkReassignment(affectedTaskIds, () => {
          db.transaction(() => {
            if (dataset().id !== datasetEpoch)
              throw new Error(
                "Dataset changed; reload before repository correction.",
              );
            const latest = getEnrollment(enrollmentId);
            if (latest.revision !== expectedEnrollmentRevision)
              throw new Error(
                "Enrollment changed; reload before repository correction.",
              );
            const latestTaskIds = (
              db
                .prepare(
                  "SELECT id FROM tasks WHERE enrollmentId=? ORDER BY id",
                )
                .all(enrollmentId) as Array<{ id: string }>
            ).map((row) => row.id);
            if (
              latestTaskIds.length !== affectedTaskIds.length ||
              latestTaskIds.some((id, index) => id !== affectedTaskIds[index])
            )
              throw new Error(
                "Enrollment task set changed while correction waited; nothing was reassociated. Retry against the expanded task set.",
              );
            const conflict = db
              .prepare("SELECT id FROM enrollments WHERE projectId=? AND id<>?")
              .get(projectId, enrollmentId);
            if (conflict)
              throw new Error("Replacement BB project is already enrolled.");
            db.prepare(
              `UPDATE enrollments SET projectId=?,hostId=?,repository=?,name=?,revision=revision+1,updatedAt=? WHERE id=?`,
            ).run(
              candidate.projectId,
              candidate.hostId,
              inventory.repository,
              candidate.name,
              now,
              enrollmentId,
            );
            db.prepare(
              `UPDATE repository_workspaces SET projectId=?,hostId=?,repository=?,environmentId=?,preparedAt=NULL,revision=revision+1,updatedAt=? WHERE taskId IN (SELECT id FROM tasks WHERE enrollmentId=?)`,
            ).run(
              candidate.projectId,
              candidate.hostId,
              inventory.repository,
              environmentId,
              now,
              enrollmentId,
            );
          })();
        });
        bb.realtime.publish("changed", {});
        return getEnrollment(enrollmentId);
      }),
    exportBackup: ({ destination }) => runArchive("manual", destination),
    exportRecoveryArchive: ({ reason }) =>
      maintenance.runMaintenance("backup", async () =>
        withoutPublishedPath(await captureRecoveryArchiveInner(reason)),
      ),
    previewRestore: ({ path }) => previewRestore({ path }),
    restoreDataset: (input) => restoreDataset(input),
    retryDailyBackup: () => runArchive("daily", null, { forceForDay: true }),
  };
  const admittedRpcHandlers = new Proxy(rpcHandlers, {
    get(target, property, receiver) {
      const handler = Reflect.get(target, property, receiver) as (
        input: unknown,
      ) => unknown;
      // Export/retry/recovery/restore routes manage the gate themselves and
      // are the explicit retry paths, so they never trigger the daily
      // attempt and are never wrapped in a mutation admission (restore
      // acquires the maintenance gate itself).
      if (
        property === "exportBackup" ||
        property === "retryDailyBackup" ||
        property === "exportRecoveryArchive" ||
        property === "previewRestore" ||
        property === "restoreDataset"
      )
        return handler;
      if (property === "list")
        return async (input: unknown) => {
          await ensureDailyBackup().catch(() => undefined);
          return maintenance.runMutation(() => handler(input));
        };
      // Every other first-use route (including direct human mutations)
      // triggers the day's automatic backup without awaiting it here:
      // awaiting would reorder concurrent first-use mutation admission
      // (task numbering must follow call order). The maintenance gate makes
      // the backup wait for in-flight mutations and then briefly pauses
      // queued ones; backup failures never block task work.
      void ensureDailyBackup().catch(() => undefined);
      return (input: unknown) =>
        maintenance.runMutation(() => Promise.resolve(handler(input)));
    },
  }) as RpcHandlers;
  bb.rpc.register(rpcContract, admittedRpcHandlers);
  // Token-authenticated capture routes under the plugin HTTP namespace.
  // The host verifies the token value; the handlers additionally enforce
  // header-only transport and bounded bodies, and never echo secrets or
  // submitted content in diagnostics.
  const captureTokenFailure = new CaptureHttpError(
    "UNAUTHORIZED",
    401,
    "Capture requires the plugin token via the x-bb-plugin-token header; query credentials are not accepted.",
  );
  bb.http.route(
    "GET",
    "/capture/v1/projects",
    async (context) => {
      try {
        if (new URL(context.req.raw.url).searchParams.has("token"))
          return context.json(captureErrorBody(captureTokenFailure), 401);
        if (!context.req.raw.headers.get("x-bb-plugin-token"))
          return context.json(captureErrorBody(captureTokenFailure), 401);
        void ensureDailyBackup().catch(() => undefined);
        const result = await maintenance.runMutation(async () => {
          await testHooks.captureDiscoveryGate?.();
          // Read the dataset epoch inside the admitted mutation so the
          // returned epoch can never pair with rows from a restored dataset.
          const identity = dataset();
          let projects: Awaited<ReturnType<typeof discovery>>["projects"];
          let hosts: Awaited<ReturnType<typeof discovery>>["hosts"];
          let discoveryUnavailable = false;
          try {
            const result = await discovery();
            projects = result.projects;
            hosts = result.hosts;
          } catch {
            discoveryUnavailable = true;
            projects = [];
            hosts = [];
          }
          const rows = enrollments().map((item) => {
            if (discoveryUnavailable)
              return {
                enrollmentId: item.id,
                projectId: item.projectId,
                name: item.name,
                prefix: item.prefix,
                available: false,
                unavailableReason:
                  "BB project discovery is temporarily unavailable; the enrolled identity is retained for explicit retry.",
              };
            const project = projects.find(
              (candidate) => candidate.id === item.projectId,
            );
            if (!project)
              return {
                enrollmentId: item.id,
                projectId: item.projectId,
                name: item.name,
                prefix: item.prefix,
                available: false,
                unavailableReason:
                  "The enrolled BB project is confirmed missing; retained enrollment requires explicit human correction.",
              };
            const sourceOnHost = project.sources.some(
              (source) =>
                source.type === "local_path" && source.hostId === item.hostId,
            );
            const hostConnected = hosts.some(
              (candidate) =>
                candidate.id === item.hostId &&
                candidate.status === "connected",
            );
            if (!sourceOnHost)
              return {
                enrollmentId: item.id,
                projectId: item.projectId,
                name: item.name,
                prefix: item.prefix,
                available: false,
                unavailableReason:
                  "The enrolled BB project no longer resolves on its enrolled host; retained enrollment requires explicit human correction.",
              };
            if (!hostConnected)
              return {
                enrollmentId: item.id,
                projectId: item.projectId,
                name: item.name,
                prefix: item.prefix,
                available: false,
                unavailableReason:
                  "The enrolled host is not connected; retry explicitly after it reconnects.",
              };
            return {
              enrollmentId: item.id,
              projectId: item.projectId,
              name: item.name,
              prefix: item.prefix,
              available: true,
              unavailableReason: null,
            };
          });
          return {
            apiVersion: CAPTURE_API_VERSION,
            datasetEpoch: identity.id,
            projects: rows,
          };
        });
        return context.json(result, 200);
      } catch (error) {
        bb.log.warn(`capture projects route failed: ${boundedError(error)}`);
        return context.json(
          captureErrorBody(
            new CaptureHttpError(
              "STORAGE_UNAVAILABLE",
              503,
              "Capture discovery is temporarily unavailable; retry explicitly.",
              { retryable: true },
            ),
          ),
          503,
        );
      }
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/capture/v1/tasks",
    async (context) => {
      try {
        if (new URL(context.req.raw.url).searchParams.has("token"))
          return context.json(captureErrorBody(captureTokenFailure), 401);
        if (!context.req.raw.headers.get("x-bb-plugin-token"))
          return context.json(captureErrorBody(captureTokenFailure), 401);
        void ensureDailyBackup().catch(() => undefined);
        const submission = await readCaptureSubmission(context.req.raw);
        const outcome = await captureSubmit(submission);
        return context.json(outcome.body, outcome.httpStatus);
      } catch (error) {
        if (error instanceof CaptureHttpError)
          return context.json(captureErrorBody(error), error.httpStatus);
        bb.log.warn(`capture tasks route failed: ${boundedError(error)}`);
        return context.json(
          captureErrorBody(
            new CaptureHttpError(
              "STORAGE_UNAVAILABLE",
              503,
              "Capture is temporarily unavailable; the draft and request ID are preserved for explicit retry.",
              { retryable: true },
            ),
          ),
          503,
        );
      }
    },
    { auth: "token" },
  );
}

export const experimental_archiveMigrationSupport = {
  migrationStatements: DURABLE_MIGRATIONS,
  adapterTablesBySchema: ARCHIVE_TABLES_BY_SCHEMA,
};

export const createTaskWorkspacePlugin =
  (testHooks: TaskWorkspaceTestHooks) => (bb: BbPluginApi) =>
    plugin(bb, testHooks);
