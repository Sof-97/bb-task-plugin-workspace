import { createHash } from "node:crypto";
import type { ArchiveTable, ArchiveMemory } from "./archive";

export class RestoreValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RestoreValidationError";
  }
}

const fail = (code: string, message: string): never => {
  throw new RestoreValidationError(code, message);
};

export type RestoredDatasetIdentity = {
  datasetId: string;
  hostId: string;
};

export type StagedRestorePlan = {
  schemaVersion: number;
  source: RestoredDatasetIdentity;
  taskCount: number;
  enrollmentCount: number;
  memoryCount: number;
  pendingOperationCount: number;
  startOperationCount: number;
  threadLinkCount: number;
  memoryHashByTask: Map<string, string>;
};

/**
 * Exact column shape of one live record table, derived from `PRAGMA
 * table_info` of the plugin database. `required` lists columns that must be
 * present in an archived row (NOT NULL without a default, or primary key).
 */
export type RestoreColumnShape = {
  columns: readonly string[];
  required: readonly string[];
};

export type RestoreRecordSchema = Record<string, RestoreColumnShape>;

export type RestorePlanOptions = {
  /** Identity captured at preview time; rejects an archive swapped later. */
  expected?: RestoredDatasetIdentity;
  /** The single host this plugin install may restore from. */
  currentHostId: string;
  /** Manifest identity/version the record set must agree with exactly. */
  manifest: { schemaVersion: number; source: RestoredDatasetIdentity };
  /** Live record-table column shapes for unknown/missing-column rejection. */
  schema: RestoreRecordSchema;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const table = (tables: ArchiveTable[], name: string) =>
  tables.find((candidate) => candidate.name === name);

const rows = (db: StagedDatabase, sql: string, ...params: unknown[]) =>
  db.prepare(sql).all(...params) as Record<string, unknown>[];

const get = (db: StagedDatabase, sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...params) as Record<string, unknown> | undefined;

type StagedDatabase = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => { changes: number };
  };
  exec: (sql: string) => unknown;
};

const str = (v: unknown, label: string): string => {
  if (typeof v !== "string")
    fail("INVALID_RECORD", `${label} must be a string.`);
  return v as string;
};
const int = (v: unknown, label: string): number => {
  if (!Number.isSafeInteger(v))
    fail("INVALID_RECORD", `${label} must be an integer.`);
  return v as number;
};

/** Record tables a schema-9, schema-10 or schema-11 complete archive carries. */
export const RESTORE_TABLE_ORDER = [
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
  "bb_migrations",
] as const;

const MEMORY_BYTES_LIMIT = 1024 * 1024;

export const restoreTableName = (name: string) =>
  name === "bb_migrations" ? "_bb_migrations" : name;

function validateSchemaTableSet(
  tables: ArchiveTable[],
  schemaVersion: number,
): void {
  const names = new Set(tables.map((item) => item.name));
  const expected = [...RESTORE_TABLE_ORDER].filter(
    (name) =>
      (schemaVersion >= 10 || name !== "wayfinder_attachments") &&
      (schemaVersion >= 11 || name !== "capture_requests"),
  );
  const missing = expected.filter((name) => !names.has(name));
  if (missing.length)
    fail(
      "INCOMPLETE_ARCHIVE",
      `Archive is missing required record tables: ${missing.join(", ")}.`,
    );
  const unexpected = tables
    .map((item) => item.name)
    .filter(
      (name) => !(RESTORE_TABLE_ORDER as readonly string[]).includes(name),
    );
  if (unexpected.length)
    fail(
      "UNKNOWN_TABLE",
      `Complete archive carries unsupported record tables: ${unexpected.join(", ")}.`,
    );
  if (schemaVersion < 10 && names.has("wayfinder_attachments"))
    fail(
      "INVALID_RELATIONSHIP",
      "A schema-9 archive cannot carry wayfinder_attachments records.",
    );
  if (schemaVersion < 11 && names.has("capture_requests"))
    fail(
      "INVALID_RELATIONSHIP",
      "A schema-10 archive cannot carry capture_requests records.",
    );
}

function validateIdentity(tables: ArchiveTable[]): RestoredDatasetIdentity {
  const found = table(tables, "dataset");
  if (!found || found.rows.length !== 1)
    fail("INVALID_RELATIONSHIP", "Archive must carry exactly one dataset row.");
  const datasetRow = found!;
  const row = datasetRow.rows[0] as Record<string, unknown>;
  const datasetId = str(row.id, "dataset.id");
  const hostId = str(row.hostId, "dataset.hostId");
  if (!UUID.test(datasetId))
    fail("INVALID_RELATIONSHIP", "Archive dataset identity is not a UUID.");
  if (!hostId || hostId.length > 200)
    fail("INVALID_RELATIONSHIP", "Archive dataset host identity is invalid.");
  return { datasetId, hostId };
}

/**
 * Reject archived rows whose columns are unknown to the live schema or that
 * omit a required column. This runs at preview time so a malformed archive can
 * never reach the staging database or the live switch.
 */
function validateColumnShapes(
  tables: ArchiveTable[],
  schema: RestoreRecordSchema,
  schemaVersion: number,
): void {
  const expected = new Set(
    [...RESTORE_TABLE_ORDER].filter(
      (name) =>
        (schemaVersion >= 10 || name !== "wayfinder_attachments") &&
        (schemaVersion >= 11 || name !== "capture_requests"),
    ),
  );
  for (const archiveTable of tables) {
    if (archiveTable.name === "bb_migrations") continue;
    if (
      !expected.has(archiveTable.name as (typeof RESTORE_TABLE_ORDER)[number])
    )
      fail(
        "UNKNOWN_TABLE",
        `Complete archive carries unsupported record table ${archiveTable.name}.`,
      );
    const shape = schema[archiveTable.name];
    if (!shape)
      fail(
        "UNKNOWN_TABLE",
        `No live schema shape exists for record table ${archiveTable.name}.`,
      );
    const allowed = new Set(shape!.columns);
    const required = shape!.required;
    for (const [index, raw] of archiveTable.rows.entries()) {
      const row = raw as Record<string, unknown>;
      for (const key of Object.keys(row))
        if (!allowed.has(key))
          fail(
            "UNKNOWN_COLUMN",
            `${archiveTable.name}[${index}] carries unknown column ${key}.`,
          );
      for (const key of required)
        if (!Object.hasOwn(row, key))
          fail(
            "MISSING_COLUMN",
            `${archiveTable.name}[${index}] is missing required column ${key}.`,
          );
    }
  }
}

function validateEnrollments(
  tables: ArchiveTable[],
  datasetHostId: string,
): { count: number; ids: Set<string> } {
  const enrollmentRows = table(tables, "enrollments");
  if (!enrollmentRows)
    fail("INCOMPLETE_ARCHIVE", "Archive has no enrollments.");
  const enrollmentTable = enrollmentRows!;
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const [index, raw] of enrollmentTable.rows.entries()) {
    const row = raw as Record<string, unknown>;
    const id = str(row.id, `enrollments[${index}].id`);
    if (!UUID.test(id))
      fail("INVALID_RELATIONSHIP", "Enrollment id is invalid.");
    if (ids.has(id)) fail("INVALID_RELATIONSHIP", "Duplicate enrollment id.");
    const prefix = str(row.prefix, `enrollments[${index}].prefix`);
    if (!prefix || prefix.length > 12)
      fail("INVALID_RELATIONSHIP", "Enrollment prefix is invalid.");
    if (prefixes.has(prefix))
      fail("INVALID_RELATIONSHIP", "Duplicate enrollment prefix.");
    const hostId = str(row.hostId, `enrollments[${index}].hostId`);
    if (hostId !== datasetHostId)
      fail(
        "INVALID_RELATIONSHIP",
        "An enrollment references a host other than the dataset host.",
      );
    int(row.nextNumber, `enrollments[${index}].nextNumber`);
    int(row.revision, `enrollments[${index}].revision`);
    ids.add(id);
    prefixes.add(prefix);
  }
  return { count: enrollmentTable.rows.length, ids };
}

function validateTasks(
  tables: ArchiveTable[],
  enrollmentIds: Set<string>,
): {
  count: number;
  ids: Set<string>;
  maxNumber: Map<string, number>;
  numbers: Map<string, Set<number>>;
} {
  const taskRows = table(tables, "tasks");
  if (!taskRows) fail("INCOMPLETE_ARCHIVE", "Archive has no tasks.");
  const taskTable = taskRows!;
  const ids = new Set<string>();
  const displayIds = new Set<string>();
  const numbers = new Map<string, Set<number>>();
  const maxNumber = new Map<string, number>();
  for (const [index, raw] of taskTable.rows.entries()) {
    const row = raw as Record<string, unknown>;
    const id = str(row.id, `tasks[${index}].id`);
    if (!UUID.test(id)) fail("INVALID_RELATIONSHIP", "Task id is invalid.");
    if (ids.has(id)) fail("INVALID_RELATIONSHIP", "Duplicate task id.");
    const enrollmentId = str(row.enrollmentId, `tasks[${index}].enrollmentId`);
    if (!enrollmentIds.has(enrollmentId))
      fail(
        "INVALID_RELATIONSHIP",
        `Task ${String(row.displayId ?? id)} references an unknown enrollment.`,
      );
    const number = int(row.number, `tasks[${index}].number`);
    if (number < 1)
      fail("INVALID_RELATIONSHIP", "Task number must be positive.");
    const seq = numbers.get(enrollmentId) ?? new Set<number>();
    if (seq.has(number))
      fail(
        "INVALID_RELATIONSHIP",
        `Duplicate task number ${number} within one enrollment.`,
      );
    seq.add(number);
    numbers.set(enrollmentId, seq);
    const displayId = str(row.displayId, `tasks[${index}].displayId`);
    if (!displayId) fail("INVALID_RELATIONSHIP", "Task display ID is empty.");
    if (displayIds.has(displayId))
      fail("INVALID_RELATIONSHIP", "Duplicate task display ID.");
    displayIds.add(displayId);
    if (row.status !== "Inbox")
      fail(
        "INVALID_RECORD",
        `Task ${displayId} carries unsupported status ${String(row.status)}; the installed schema stores workflow in workflowStatus.`,
      );
    if (!String(row.title ?? "").length)
      fail("INVALID_RELATIONSHIP", "Task title is empty.");
    const revision = int(row.revision, `tasks[${index}].revision`);
    if (revision < 1)
      fail("INVALID_RELATIONSHIP", "Task revision must be positive.");
    const memoryRevision = int(
      row.memoryRevision,
      `tasks[${index}].memoryRevision`,
    );
    if (memoryRevision < 0)
      fail("INVALID_RELATIONSHIP", "Task memory revision must be nonnegative.");
    if (memoryRevision === 0) {
      if (row.memoryHash !== null && row.memoryHash !== undefined)
        fail(
          "INVALID_RELATIONSHIP",
          `Task ${displayId} has a memory hash without a memory revision.`,
        );
    } else if (row.memoryHash === null || row.memoryHash === undefined) {
      fail(
        "INVALID_RELATIONSHIP",
        `Task ${displayId} has a memory revision without a hash.`,
      );
    } else if (!HASH.test(str(row.memoryHash, `tasks[${index}].memoryHash`)))
      fail("INVALID_RELATIONSHIP", "Task memory hash is not a SHA-256 digest.");
    ids.add(id);
    const seen = maxNumber.get(enrollmentId) ?? 0;
    if (number > seen) maxNumber.set(enrollmentId, number);
  }
  return { count: taskTable.rows.length, ids, maxNumber, numbers };
}

function validateTaskRelationships(
  tables: ArchiveTable[],
  taskIds: Set<string>,
) {
  const relationships = table(tables, "task_relationships");
  if (!relationships) return;
  for (const [index, raw] of relationships.rows.entries()) {
    const row = raw as Record<string, unknown>;
    const taskId = str(row.taskId, `task_relationships[${index}].taskId`);
    const targetTaskId = str(
      row.targetTaskId,
      `task_relationships[${index}].targetTaskId`,
    );
    if (!taskIds.has(taskId) || !taskIds.has(targetTaskId))
      fail(
        "INVALID_RELATIONSHIP",
        "A task relationship references an unknown task.",
      );
    if (taskId === targetTaskId)
      fail("INVALID_RELATIONSHIP", "A task relationship references itself.");
    const kind = str(row.kind, `task_relationships[${index}].kind`);
    if (kind !== "depends-on" && kind !== "blocker-reference")
      fail("INVALID_RELATIONSHIP", "Task relationship kind is unsupported.");
  }
}

function validateForeignKeys(tables: ArchiveTable[], taskIds: Set<string>) {
  const pending = table(tables, "pending_operations");
  if (pending)
    for (const [index, raw] of pending.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const taskId = str(row.taskId, `pending_operations[${index}].taskId`);
      if (!taskIds.has(taskId))
        fail(
          "INVALID_RELATIONSHIP",
          "A pending operation references an unknown task.",
        );
      if (row.state === null || typeof row.state !== "string")
        fail("INVALID_RECORD", "A pending operation has no state.");
    }
  const paths = table(tables, "attached_paths");
  if (paths)
    for (const [index, raw] of paths.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const taskId = str(row.taskId, `attached_paths[${index}].taskId`);
      if (!taskIds.has(taskId))
        fail(
          "INVALID_RELATIONSHIP",
          "An attached path references an unknown task.",
        );
      const id = str(row.id, `attached_paths[${index}].id`);
      if (!UUID.test(id))
        fail("INVALID_RELATIONSHIP", "Attached path identity is invalid.");
      if (!str(row.hostId, `attached_paths[${index}].hostId`))
        fail("INVALID_RELATIONSHIP", "Attached path host identity is empty.");
      const path = str(row.path, `attached_paths[${index}].path`);
      if (!path || path.length > 4096)
        fail("INVALID_RELATIONSHIP", "Attached path reference is invalid.");
    }
  const workspaces = table(tables, "repository_workspaces");
  if (workspaces)
    for (const [index, raw] of workspaces.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const taskId = str(row.taskId, `repository_workspaces[${index}].taskId`);
      if (!taskIds.has(taskId))
        fail(
          "INVALID_RELATIONSHIP",
          "A repository workspace references an unknown task.",
        );
      if (!str(row.projectId, `repository_workspaces[${index}].projectId`))
        fail(
          "INVALID_RELATIONSHIP",
          "Repository workspace project identity is empty.",
        );
    }
  const memoryOps = table(tables, "memory_operations");
  if (memoryOps)
    for (const [index, raw] of memoryOps.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const taskId = str(row.taskId, `memory_operations[${index}].taskId`);
      if (!taskIds.has(taskId))
        fail(
          "INVALID_RELATIONSHIP",
          "A memory operation references an unknown task.",
        );
      if (
        !UUID.test(
          str(row.datasetEpoch, `memory_operations[${index}].datasetEpoch`),
        )
      )
        fail("INVALID_RELATIONSHIP", "Memory operation epoch is invalid.");
      if (
        !HASH.test(
          str(row.intendedHash, `memory_operations[${index}].intendedHash`),
        )
      )
        fail("INVALID_RELATIONSHIP", "Memory operation hash is invalid.");
    }
  const memoryIds = table(tables, "memory_operation_ids");
  if (memoryIds)
    for (const [index, raw] of memoryIds.rows.entries()) {
      const row = raw as Record<string, unknown>;
      if (
        !taskIds.has(str(row.taskId, `memory_operation_ids[${index}].taskId`))
      )
        fail(
          "INVALID_RELATIONSHIP",
          "A memory operation identity references an unknown task.",
        );
    }
  const startOps = table(tables, "thread_start_operations");
  if (startOps)
    for (const [index, raw] of startOps.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const taskId = str(
        row.taskId,
        `thread_start_operations[${index}].taskId`,
      );
      if (!taskIds.has(taskId))
        fail(
          "INVALID_RELATIONSHIP",
          "A thread start operation references an unknown task.",
        );
      if (
        !UUID.test(
          str(
            row.datasetEpoch,
            `thread_start_operations[${index}].datasetEpoch`,
          ),
        )
      )
        fail("INVALID_RELATIONSHIP", "Start operation epoch is invalid.");
      try {
        const parsed: unknown = JSON.parse(
          str(
            row.linkContextJson,
            `thread_start_operations[${index}].linkContextJson`,
          ),
        );
        if (!Array.isArray(parsed)) throw new Error("not an array");
        for (const entry of parsed)
          if (
            !entry ||
            typeof entry !== "object" ||
            typeof (entry as Record<string, unknown>).threadId !== "string"
          )
            throw new Error("malformed entry");
      } catch {
        fail(
          "INVALID_RELATIONSHIP",
          "Start operation link context is invalid.",
        );
      }
    }
  const links = table(tables, "thread_links");
  if (links)
    for (const [index, raw] of links.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const taskId = str(row.taskId, `thread_links[${index}].taskId`);
      if (!taskIds.has(taskId))
        fail(
          "INVALID_RELATIONSHIP",
          "A thread link references an unknown task.",
        );
      if (int(row.linkRevision, `thread_links[${index}].linkRevision`) < 1)
        fail("INVALID_RELATIONSHIP", "Thread link revision must be positive.");
      if (
        !str(
          row.lastKnownProjectId,
          `thread_links[${index}].lastKnownProjectId`,
        )
      )
        fail("INVALID_RELATIONSHIP", "Thread link project identity is empty.");
    }
  const wayfinder = table(tables, "wayfinder_attachments");
  if (wayfinder)
    for (const [index, raw] of wayfinder.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const taskId = str(row.taskId, `wayfinder_attachments[${index}].taskId`);
      if (!taskIds.has(taskId))
        fail(
          "INVALID_RELATIONSHIP",
          "A Wayfinder attachment references an unknown task.",
        );
      const mapPath = str(
        row.mapPath,
        `wayfinder_attachments[${index}].mapPath`,
      );
      if (!mapPath || mapPath.length > 4096)
        fail("INVALID_RELATIONSHIP", "Wayfinder map path is invalid.");
    }
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validate durable capture-request rows: identity, dedup hash shape, task
 * reference and, for accepted records, an immutable creation receipt
 * describing the original Inbox creation.
 */
function validateCaptureRequests(
  tables: ArchiveTable[],
  taskIds: Set<string>,
): number {
  const captureRows = table(tables, "capture_requests");
  if (!captureRows) return 0;
  const keys = new Set<string>();
  for (const [index, raw] of captureRows.rows.entries()) {
    const row = raw as Record<string, unknown>;
    const datasetEpoch = str(
      row.datasetEpoch,
      `capture_requests[${index}].datasetEpoch`,
    );
    if (!UUID.test(datasetEpoch))
      fail("INVALID_RELATIONSHIP", "Capture request epoch is invalid.");
    const requestId = str(
      row.requestId,
      `capture_requests[${index}].requestId`,
    );
    if (!UUID.test(requestId))
      fail("INVALID_RELATIONSHIP", "Capture request identity is invalid.");
    const key = `${datasetEpoch}#${requestId}`;
    if (keys.has(key))
      fail("INVALID_RELATIONSHIP", "Duplicate capture request key.");
    keys.add(key);
    const payloadHash = str(
      row.payloadHash,
      `capture_requests[${index}].payloadHash`,
    );
    if (!HASH.test(payloadHash))
      fail("INVALID_RELATIONSHIP", "Capture payload hash is invalid.");
    if (!taskIds.has(str(row.taskId, `capture_requests[${index}].taskId`)))
      fail(
        "INVALID_RELATIONSHIP",
        "A capture request references an unknown task.",
      );
    if (
      typeof row.projectId !== "string" ||
      row.projectId.length === 0 ||
      row.projectId.length > 200
    )
      fail(
        "INVALID_RELATIONSHIP",
        "Capture request project identity is invalid.",
      );
    const state = str(row.state, `capture_requests[${index}].state`);
    // `recovery-required` is a live state the restore switch itself writes to
    // quarantine a pending request; a later backup must stay restorable.
    if (
      state !== "allocated" &&
      state !== "accepted" &&
      state !== "recovery-required"
    )
      fail("INVALID_RECORD", "Capture request state is unsupported.");
    if (state === "accepted") {
      if (row.receiptJson === null || row.receiptJson === undefined)
        fail(
          "INVALID_RELATIONSHIP",
          "An accepted capture request has no creation receipt.",
        );
      let receipt: unknown;
      try {
        receipt = JSON.parse(
          str(row.receiptJson, `capture_requests[${index}].receiptJson`),
        );
      } catch {
        fail("INVALID_RECORD", "An accepted capture receipt is not JSON.");
      }
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
        fail("INVALID_RECORD", "An accepted capture receipt is malformed.");
      const value = receipt as Record<string, unknown>;
      if (
        typeof value.taskUuid !== "string" ||
        !UUID.test(value.taskUuid) ||
        typeof value.displayId !== "string" ||
        !value.displayId ||
        typeof value.projectId !== "string" ||
        !value.projectId ||
        value.status !== "Inbox" ||
        typeof value.createdAt !== "string" ||
        !INSTANT.test(value.createdAt)
      )
        fail(
          "INVALID_RECORD",
          "An accepted capture receipt does not describe the original Inbox creation.",
        );
    } else if (row.receiptJson !== null && row.receiptJson !== undefined) {
      fail(
        "INVALID_RELATIONSHIP",
        "A pending capture request must not carry a creation receipt.",
      );
    }
  }
  return captureRows.rows.length;
}

/**
 * Reject an archive whose rows would violate the live schema's uniqueness
 * constraints at preview time, before any staging or switch is attempted.
 */
function validateUniqueConstraints(tables: ArchiveTable[]): void {
  const unique = (
    name: string,
    key: (row: Record<string, unknown>, index: number) => string,
  ) => {
    const source = table(tables, name);
    if (!source) return;
    const seen = new Set<string>();
    for (const [index, raw] of source.rows.entries()) {
      const row = raw as Record<string, unknown>;
      const value = key(row, index);
      if (seen.has(value))
        fail("INVALID_RELATIONSHIP", `Duplicate ${name} record for ${value}.`);
      seen.add(value);
    }
  };
  unique("tasks", (row) => str(row.displayId, "displayId"));
  unique("pending_operations", (row, i) =>
    str(row.taskId, `pending_operations[${i}].taskId`),
  );
  unique(
    "attached_paths",
    (row, i) =>
      `${str(row.taskId, `attached_paths[${i}].taskId`)}#${int(row.position, `attached_paths[${i}].position`)}`,
  );
  unique("memory_operation_ids", (row, i) =>
    str(row.id, `memory_operation_ids[${i}].id`),
  );
  unique("thread_links", (row, i) =>
    str(row.threadId, `thread_links[${i}].threadId`),
  );
  unique("repository_workspaces", (row, i) =>
    str(row.taskId, `repository_workspaces[${i}].taskId`),
  );
  unique("wayfinder_attachments", (row, i) =>
    str(row.taskId, `wayfinder_attachments[${i}].taskId`),
  );
}

function validateMemory(
  taskRows: Array<Record<string, unknown>>,
  memories: ArchiveMemory[],
): Map<string, string> {
  const byTask = new Map<string, ArchiveMemory>();
  for (const memory of memories) {
    if (byTask.has(memory.taskId))
      fail(
        "INVALID_RELATIONSHIP",
        `Duplicate memory entry for ${memory.taskId}.`,
      );
    if (memory.bytes.byteLength > MEMORY_BYTES_LIMIT)
      fail(
        "INVALID_MEMORY",
        `Memory for ${memory.taskId} exceeds the byte limit.`,
      );
    byTask.set(memory.taskId, memory);
  }
  const memoryHashByTask = new Map<string, string>();
  for (const row of taskRows) {
    const id = str(row.id, "task id");
    const displayId = String(row.displayId ?? id);
    const memoryRevision = int(row.memoryRevision, "memoryRevision");
    if (memoryRevision < 1)
      fail(
        "INVALID_RELATIONSHIP",
        `Task ${displayId} has no initialized memory; complete archives carry only recovered memory.`,
      );
    const memory = byTask.get(id);
    if (!memory)
      fail("MISSING_MEMORY", `Task ${displayId} has no archived memory file.`);
    const expectedHash = str(row.memoryHash, "memoryHash");
    const actual = createHash("sha256").update(memory!.bytes).digest("hex");
    if (actual !== expectedHash)
      fail(
        "HASH_MISMATCH",
        `Archived memory for ${displayId} does not match its committed hash.`,
      );
    try {
      utf8.decode(memory!.bytes);
    } catch {
      fail("INVALID_MEMORY", `Memory for ${displayId} is not UTF-8.`);
    }
    memoryHashByTask.set(id, expectedHash);
  }
  for (const taskId of byTask.keys())
    if (!taskRows.some((row) => row.id === taskId))
      fail(
        "INVALID_RELATIONSHIP",
        `Memory entry ${taskId} has no archived task record.`,
      );
  return memoryHashByTask;
}

function validateSequenceContinuity(
  enrollments: ArchiveTable,
  tasks: {
    numbers: Map<string, Set<number>>;
    maxNumber: Map<string, number>;
  },
) {
  for (const raw of enrollments.rows) {
    const row = raw as Record<string, unknown>;
    const id = str(row.id, "enrollment id");
    const nextNumber = int(row.nextNumber, "enrollment nextNumber");
    const seen = tasks.numbers.get(id) ?? new Set<number>();
    const highest = tasks.maxNumber.get(id) ?? 0;
    for (let n = 1; n < nextNumber; n += 1)
      if (!seen.has(n))
        fail(
          "INVALID_RELATIONSHIP",
          `Enrollment ${String(row.prefix)} archives task numbers out of sequence: ${n} is missing below nextNumber ${nextNumber}.`,
        );
    if (highest >= nextNumber)
      fail(
        "INVALID_RELATIONSHIP",
        `Enrollment ${String(row.prefix)} archives a task number at or above its next allocation.`,
      );
  }
}

export function planStagedRestore(
  tables: ArchiveTable[],
  memories: ArchiveMemory[],
  options: RestorePlanOptions,
): StagedRestorePlan {
  const ledger = table(tables, "bb_migrations");
  if (!ledger) fail("INCOMPLETE_ARCHIVE", "Archive has no migration ledger.");
  const ledgerTable = ledger!;
  validateLedgerRows(ledgerTable);
  const schemaVersion = ledgerTable.rows.length;
  if (schemaVersion !== 9 && schemaVersion !== 10 && schemaVersion !== 11)
    fail(
      "UNSUPPORTED_SCHEMA",
      `Archive schema ${schemaVersion} has no restore adapter (supported: 9, 10, 11).`,
    );
  const manifestVersion = options.manifest.schemaVersion;
  if (manifestVersion !== schemaVersion)
    fail(
      "SCHEMA_MISMATCH",
      `Archive manifest declares schema ${manifestVersion} but its record ledger has ${schemaVersion} migrations.`,
    );
  validateSchemaTableSet(tables, schemaVersion);
  const identity = validateIdentity(tables);
  if (
    identity.datasetId !== options.manifest.source.datasetId ||
    identity.hostId !== options.manifest.source.hostId
  )
    fail(
      "IDENTITY_MISMATCH",
      "Archive manifest source does not match its dataset record.",
    );
  if (
    options.expected &&
    (options.expected.datasetId !== identity.datasetId ||
      options.expected.hostId !== identity.hostId)
  )
    fail(
      "IDENTITY_MISMATCH",
      "Archive dataset identity changed between preview and restore.",
    );
  if (identity.hostId !== options.currentHostId)
    fail(
      "FOREIGN_HOST",
      `Archive was captured on host ${identity.hostId}; this single-machine plugin restores only archives captured on ${options.currentHostId}. Restore it on its original host instead.`,
    );
  validateColumnShapes(tables, options.schema, schemaVersion);
  const enrollments = validateEnrollments(tables, identity.hostId);
  const tasks = validateTasks(tables, enrollments.ids);
  validateTaskRelationships(tables, tasks.ids);
  validateForeignKeys(tables, tasks.ids);
  validateUniqueConstraints(tables);
  validateCaptureRequests(tables, tasks.ids);
  const memoryHashByTask = validateMemory(
    table(tables, "tasks")!.rows as Array<Record<string, unknown>>,
    memories,
  );
  const preparedMemoryOps = (
    table(tables, "memory_operations")?.rows ?? []
  ).filter((row) => (row as Record<string, unknown>).state === "prepared");
  if (preparedMemoryOps.length)
    fail(
      "PENDING_OPERATIONS",
      "The archive carries a prepared memory operation; complete archives only record settled memory state.",
    );
  validateSequenceContinuity(table(tables, "enrollments")!, tasks);
  return {
    schemaVersion,
    source: identity,
    taskCount: tasks.count,
    enrollmentCount: enrollments.count,
    memoryCount: memories.length,
    pendingOperationCount:
      table(tables, "pending_operations")?.rows.length ?? 0,
    startOperationCount:
      table(tables, "thread_start_operations")?.rows.length ?? 0,
    threadLinkCount: table(tables, "thread_links")?.rows.length ?? 0,
    memoryHashByTask,
  };
}

function validateLedgerRows(ledger: ArchiveTable): Array<number> {
  return ledger.rows.map((row, index) => {
    const id = int(row.id, `bb_migrations[${index}].id`);
    if (id !== index) fail("INVALID_RECORD", "Migration ledger is not dense.");
    return id;
  });
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Build the staging schema by applying the plugin's own migration statements.
 * The staging database is an isolated SQLite connection, so these DDL
 * statements exactly reproduce the live schema a real switch would target.
 */
export function createStagedSchema(
  db: StagedDatabase,
  migrations: readonly string[],
  count: number,
): void {
  for (const sql of migrations.slice(0, count)) db.exec(sql);
}

/**
 * Insert the archive's rows into the staged schema. Rows are written in the
 * live column order derived from the destination schema, so a column reorder
 * can never shift values silently and SQLite's own CHECK/UNIQUE/NOT NULL/FK
 * constraints are enforced on the staged copy before the live table is touched.
 */
export function insertStagedRows(
  db: StagedDatabase,
  tables: ArchiveTable[],
  schema: RestoreRecordSchema,
  schemaVersion: number,
): void {
  const byName = new Map(tables.map((item) => [item.name, item]));
  for (const name of RESTORE_TABLE_ORDER) {
    if (name === "wayfinder_attachments" && schemaVersion < 10) continue;
    if (name === "capture_requests" && schemaVersion < 11) continue;
    const source = byName.get(name);
    if (!source || source.rows.length === 0) continue;
    const shape = schema[name];
    if (!shape) continue;
    const columns = shape.columns;
    const insert = db.prepare(
      `INSERT INTO ${quote(restoreTableName(name))}(${columns
        .map(quote)
        .join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    );
    for (const raw of source.rows) {
      const row = raw as Record<string, unknown>;
      const values = columns.map((column) => {
        if (!Object.hasOwn(row, column)) {
          if (shape.required.includes(column))
            fail(
              "MISSING_COLUMN",
              `Archived ${name} row is missing required column ${column}.`,
            );
          return null;
        }
        return row[column] ?? null;
      });
      try {
        insert.run(...values);
      } catch (error) {
        fail(
          "INVALID_RECORD",
          `Staged ${name} row was rejected: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
        );
      }
    }
  }
}

/**
 * Post-insert checks the staged database must satisfy before the switch:
 * SQLite integrity plus a foreign-key sweep across the staged copy.
 */
export function verifyStagedRestore(
  db: StagedDatabase,
  options: { schemaVersion: number },
): void {
  const applied = new Set(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  for (const name of RESTORE_TABLE_ORDER) {
    if (name === "bb_migrations") continue;
    if (name === "wayfinder_attachments" && options.schemaVersion < 10)
      continue;
    if (name === "capture_requests" && options.schemaVersion < 11) continue;
    if (!applied.has(name))
      fail(
        "INCOMPLETE_ARCHIVE",
        `Staged schema is missing record table ${name}.`,
      );
  }
  const foreignKeys = rows(db, "PRAGMA foreign_key_check");
  if (foreignKeys.length)
    fail(
      "INVALID_RELATIONSHIP",
      "Staged restore failed the SQLite foreign-key check.",
    );
  const integrity = get(db, "PRAGMA integrity_check");
  if (!integrity || integrity.integrity_check !== "ok")
    fail("INVALID_RELATIONSHIP", "Staged restore failed the integrity check.");
  const datasetRow = get(db, "SELECT id, hostId FROM dataset");
  if (!datasetRow?.id || !datasetRow.hostId)
    fail("INVALID_RELATIONSHIP", "Staged dataset identity is incomplete.");
}

/** Read every staged record table back in canonical form, parents first. */
export function readStagedRows(db: StagedDatabase): ArchiveTable[] {
  const out: ArchiveTable[] = [];
  for (const name of RESTORE_TABLE_ORDER) {
    if (name === "bb_migrations" || name === "dataset") continue;
    try {
      out.push({
        name,
        classification: "canonical",
        rows: db
          .prepare(
            `SELECT * FROM ${quote(restoreTableName(name))} ORDER BY rowid`,
          )
          .all() as ArchiveTable["rows"],
      });
    } catch {
      // A table absent from the staged schema (an older archive without a
      // later migration's table) is simply not reconstructed.
    }
  }
  return out;
}

/**
 * Run the isolated staging path: reproduce the archive's schema version,
 * insert and constraint-check the archived rows, migrate the staged copy
 * forward to the live schema version, verify again and return the migrated
 * rows. The returned rows are exactly what a subsequent switch installs.
 */
export function stageRestore(
  db: StagedDatabase,
  tables: ArchiveTable[],
  schema: RestoreRecordSchema,
  migrations: readonly string[],
  archiveSchemaVersion: number,
): ArchiveTable[] {
  createStagedSchema(db, migrations, archiveSchemaVersion);
  insertStagedRows(db, tables, schema, archiveSchemaVersion);
  verifyStagedRestore(db, { schemaVersion: archiveSchemaVersion });
  // Migrate the staged copy forward to the live schema version; because the
  // rows are then read back from the migrated copy, the old-schema records
  // transformed by that migration are exactly the records the switch installs.
  for (const sql of migrations.slice(archiveSchemaVersion)) db.exec(sql);
  verifyStagedRestore(db, { schemaVersion: migrations.length });
  return readStagedRows(db);
}

/**
 * Durable quarantine applied inside the same SQLite transaction that installs
 * the restored rows and switches the active dataset epoch. Running it in the
 * switch transaction means a crash before commit rolls the whole switch back,
 * while a crash after commit can never expose an unquarantined restored
 * pending start. No external effect is ever replayed.
 */
export const RESTORE_RECOVERY_STATEMENTS = [
  `UPDATE thread_start_operations
   SET state='uncertain',
       error='Restored from an archive. Dispatch may have occurred before the snapshot; BB spawn or its first message will not be replayed automatically. Inspect before any recovery action.'
   WHERE state='dispatching'`,
  `UPDATE thread_start_operations
   SET state='failed-before-dispatch',
       error='Restored from an archive in a prepared state. Dispatch was never confirmed; no external effect is replayed automatically. Explicitly abandon before a new attempt.'
   WHERE state='prepared'`,
  `UPDATE thread_start_operations
   SET error='Restored from an archive. Reconcile the linked conversation explicitly or abandon this start before any retry; nothing is replayed automatically.',
        updatedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE state='awaiting-link'`,
] as const;

/**
 * Capture-request quarantine for schema-11 archives, applied in the same
 * switch transaction only when the restored snapshot carries capture
 * records. Pending capture requests are visible but never replayed or
 * resubmitted automatically; an explicit retry reconciles them.
 */
export const RESTORE_CAPTURE_QUARANTINE = `UPDATE capture_requests
   SET state='recovery-required',
       error='Restored from an archive before its creation receipt was accepted. Nothing is replayed or resubmitted automatically; a deliberate explicit retry with the original request identity may reconcile it against the restored task.',
       updatedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE state<>'accepted'`;

export type StagedDatabaseHelpers = {
  rows: typeof rows;
  get: typeof get;
};
export { rows, get };
