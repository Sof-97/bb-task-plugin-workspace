import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  MemoryAttribution,
  MemoryMutationResult,
  MemoryToken,
  MemoryView,
} from "./memory-types";

export const MEMORY_BYTE_LIMIT = 1024 * 1024;
export const EMPTY_MEMORY_HASH = createHash("sha256").update("").digest("hex");

type SqlDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export type HostMemoryObservation =
  | { state: "present"; content: string; hash: string; size: number }
  | { state: "missing" }
  | {
      state: "invalid";
      reason: "symlink" | "oversize" | "invalid-utf8" | "unsafe-path";
      message: string;
      observedHash: string | null;
    };

type OperationKind =
  "initialize-memory" | "save" | "accept-external" | "restore-known";
type OperationRow = {
  id: string;
  taskId: string;
  kind: OperationKind;
  state: "prepared" | "accepted" | "not-applied" | "conflict" | "resolved";
  datasetEpoch: string;
  oldRevision: number;
  oldHash: string | null;
  expectedActualHash: string | null;
  intendedHash: string;
  expectedThreadId: string | null;
  expectedLinkRevision: number | null;
  expectedProjectId: string | null;
  attributionKind: MemoryAttribution["kind"];
  attributionRoute: string;
  attributionThreadId: string | null;
  attributionSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  resultJson: string | null;
  error: string | null;
};

type TaskMemoryRow = {
  id: string;
  memoryState: string;
  memoryError: string | null;
  memoryHash: string | null;
  memoryRevision: number;
  memoryAttributionKind: MemoryAttribution["kind"];
  memoryAttributionRoute: string;
  memoryAttributionThreadId: string | null;
  memoryAttributionSessionId: string | null;
  memoryAttributionAt: string;
  memoryLatestOperationId: string | null;
};

type Dependencies = {
  db: SqlDatabase;
  datasetEpoch: () => string;
  readHost: (taskId: string) => Promise<HostMemoryObservation>;
  initializeHost: (
    taskId: string,
  ) => Promise<Exclude<HostMemoryObservation, { state: "missing" }>>;
  replaceHost: (input: {
    taskId: string;
    operationId: string;
    expectedHash: string | null;
    content: string;
  }) => Promise<{ hash: string; size: number }>;
  confirmHost: (
    taskId: string,
    expectedHash: string,
  ) => Promise<{ hash: string; size: number }>;
  publish: () => void;
  now?: () => string;
};

function hash(content: string) {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
}

function boundedError(value: unknown) {
  return String(value instanceof Error ? value.message : value).slice(0, 1000);
}

export function createMemoryCoordinator(dependencies: Dependencies) {
  const { db } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const tails = new Map<string, Promise<void>>();
  const coordinate = <T>(taskId: string, action: () => Promise<T>) => {
    const previous = tails.get(taskId) ?? Promise.resolve();
    const result = previous.then(action, action);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(taskId, tail);
    void tail.finally(() => {
      if (tails.get(taskId) === tail) tails.delete(taskId);
    });
    return result;
  };
  const linkMatches = (
    taskId: string,
    threadId: string,
    linkRevision: number,
    projectId?: string,
  ) => {
    const row = db
      .prepare(
        `SELECT thread_links.taskId,thread_links.linkRevision,enrollments.projectId
         FROM thread_links
         JOIN tasks ON tasks.id=thread_links.taskId
         JOIN enrollments ON enrollments.id=tasks.enrollmentId
         WHERE thread_links.threadId=?`,
      )
      .get(threadId) as
      { taskId: string; linkRevision: number; projectId: string } | undefined;
    return (
      row?.taskId === taskId &&
      row.linkRevision === linkRevision &&
      (projectId === undefined || row.projectId === projectId)
    );
  };
  const assertLink = (
    taskId: string,
    authorization: {
      threadId: string;
      linkRevision: number;
      projectId: string;
    },
  ) => {
    if (
      !linkMatches(
        taskId,
        authorization.threadId,
        authorization.linkRevision,
        authorization.projectId,
      )
    )
      throw new Error(
        "Task link changed or no longer belongs to this thread; reread current task context.",
      );
  };
  const taskRow = (taskId: string) => {
    const row = db
      .prepare(
        `SELECT id,memoryState,memoryError,memoryHash,memoryRevision,memoryAttributionKind,
          memoryAttributionRoute,memoryAttributionThreadId,memoryAttributionSessionId,
          memoryAttributionAt,memoryLatestOperationId FROM tasks WHERE id=?`,
      )
      .get(taskId) as TaskMemoryRow | undefined;
    if (!row) throw new Error("Task not found.");
    return row;
  };
  const operation = (id: string) =>
    db.prepare("SELECT * FROM memory_operations WHERE id=?").get(id) as
      OperationRow | undefined;
  const operationIdentity = (id: string) =>
    db.prepare("SELECT * FROM memory_operation_ids WHERE id=?").get(id) as
      | {
          id: string;
          taskId: string;
          kind: OperationKind;
          intendedHash: string;
        }
      | undefined;
  const prepared = (taskId: string) =>
    db
      .prepare(
        "SELECT * FROM memory_operations WHERE taskId=? AND state='prepared' ORDER BY createdAt,id LIMIT 1",
      )
      .get(taskId) as OperationRow | undefined;
  const unresolved = (taskId: string) =>
    db
      .prepare(
        "SELECT * FROM memory_operations WHERE taskId=? AND state IN ('prepared','conflict') ORDER BY createdAt DESC,id DESC LIMIT 1",
      )
      .get(taskId) as OperationRow | undefined;
  const attribution = (row: TaskMemoryRow): MemoryAttribution => ({
    kind: row.memoryAttributionKind,
    route: row.memoryAttributionRoute,
    threadId: row.memoryAttributionThreadId,
    sessionId: row.memoryAttributionSessionId,
    at: row.memoryAttributionAt,
  });
  const token = (row: TaskMemoryRow): MemoryToken => {
    return {
      datasetEpoch: dependencies.datasetEpoch(),
      memoryRevision: row.memoryRevision,
      memoryHash: row.memoryHash ?? EMPTY_MEMORY_HASH,
    };
  };
  const resultFromOperation = (
    row: OperationRow,
  ): MemoryMutationResult | null => {
    if (!row.resultJson) return null;
    return JSON.parse(row.resultJson) as MemoryMutationResult;
  };
  const pruneSettled = (taskId: string) => {
    db.prepare(
      `DELETE FROM memory_operations
       WHERE taskId=? AND state IN ('accepted','resolved','not-applied')
         AND id IS NOT (SELECT memoryLatestOperationId FROM tasks WHERE id=?)
         AND id NOT IN (
           SELECT id FROM memory_operations
           WHERE taskId=? AND state IN ('accepted','resolved','not-applied')
           ORDER BY updatedAt DESC,id DESC LIMIT 7
         )`,
    ).run(taskId, taskId, taskId);
  };
  const pendingResult = (taskId: string): MemoryMutationResult | null => {
    const row = prepared(taskId);
    return row
      ? {
          outcome: "recovery-pending",
          operationId: row.id,
          message:
            "A previously prepared memory operation still awaits durable confirmation; no later operation was started.",
        }
      : null;
  };
  const conflictResult = (
    operationId: string,
    observation: HostMemoryObservation,
  ): Extract<MemoryMutationResult, { message: string }> => ({
    outcome:
      observation.state === "missing" ? "missing-file" : "external-conflict",
    operationId,
    message:
      observation.state === "missing"
        ? "Canonical memory is missing; the absence was preserved for explicit recovery."
        : observation.state === "invalid"
          ? observation.message
          : "Canonical memory contains a third hash; its bytes were preserved for explicit recovery.",
  });
  const finishAccepted = (row: OperationRow) => {
    const current = taskRow(row.taskId);
    if (
      dependencies.datasetEpoch() !== row.datasetEpoch ||
      current.memoryRevision !== row.oldRevision ||
      current.memoryHash !== row.oldHash ||
      (row.expectedThreadId !== null &&
        (row.expectedLinkRevision === null ||
          !linkMatches(
            row.taskId,
            row.expectedThreadId,
            row.expectedLinkRevision,
            row.expectedProjectId ?? undefined,
          )))
    ) {
      const value: MemoryMutationResult = {
        outcome: "recovery-pending",
        operationId: row.id,
        message:
          "Memory metadata changed while finalizing the prepared operation; human recovery is required.",
      };
      db.prepare(
        "UPDATE memory_operations SET state='conflict',error=?,resultJson=?,updatedAt=? WHERE id=? AND state='prepared'",
      ).run(value.message, JSON.stringify(value), now(), row.id);
      db.prepare(
        "UPDATE tasks SET memoryState='conflict',memoryError=? WHERE id=?",
      ).run(value.message, row.taskId);
      return value;
    }
    const acceptedAt = now();
    let nextRevision = row.oldRevision;
    let nextHash = row.oldHash!;
    let nextAttribution = attribution(current);
    let outcome: "saved" | "accepted-external" | "restored-known";
    if (row.kind === "restore-known" && row.oldRevision > 0) {
      outcome = "restored-known";
    } else {
      nextRevision += 1;
      nextHash = row.intendedHash;
      nextAttribution = {
        kind: row.attributionKind,
        route: row.attributionRoute,
        threadId: row.attributionThreadId,
        sessionId: row.attributionSessionId,
        at: acceptedAt,
      };
      outcome =
        row.kind === "accept-external"
          ? "accepted-external"
          : row.kind === "restore-known"
            ? "restored-known"
            : "saved";
    }
    const value: MemoryMutationResult = {
      outcome,
      operationId: row.id,
      token: {
        datasetEpoch: row.datasetEpoch,
        memoryRevision: nextRevision,
        memoryHash: nextHash,
      },
      attribution: nextAttribution,
    };
    db.transaction(() => {
      const updated = db
        .prepare(
          `UPDATE tasks SET memoryState='healthy',memoryError=NULL,memoryHash=?,memoryRevision=?,
            memoryAttributionKind=?,memoryAttributionRoute=?,memoryAttributionThreadId=?,
            memoryAttributionSessionId=?,memoryAttributionAt=?,memoryLatestOperationId=?
           WHERE id=? AND memoryRevision=? AND memoryHash IS ?`,
        )
        .run(
          nextHash,
          nextRevision,
          nextAttribution.kind,
          nextAttribution.route,
          nextAttribution.threadId,
          nextAttribution.sessionId,
          nextAttribution.at,
          row.id,
          row.taskId,
          row.oldRevision,
          row.oldHash,
        );
      if (updated.changes !== 1)
        throw new Error("Memory metadata changed during finalization.");
      const finalized = db
        .prepare(
          "UPDATE memory_operations SET state='accepted',resultJson=?,error=NULL,updatedAt=? WHERE id=? AND state='prepared'",
        )
        .run(JSON.stringify(value), acceptedAt, row.id);
      if (finalized.changes !== 1)
        throw new Error("Memory operation changed during finalization.");
      db.prepare(
        "UPDATE memory_operations SET state='resolved',error='Resolved by explicit memory recovery.',updatedAt=? WHERE taskId=? AND state='conflict' AND id<>?",
      ).run(acceptedAt, row.taskId, row.id);
    })();
    pruneSettled(row.taskId);
    dependencies.publish();
    return value;
  };
  const reconcilePrepared = async (taskId: string) => {
    const row = prepared(taskId);
    if (!row) return null;
    let observation: HostMemoryObservation;
    try {
      observation = await dependencies.readHost(taskId);
      if (
        row.kind === "initialize-memory" &&
        row.oldRevision === 0 &&
        observation.state === "missing"
      )
        observation = await dependencies.initializeHost(taskId);
    } catch (error) {
      const message = boundedError(error);
      const value: MemoryMutationResult = {
        outcome: "recovery-pending",
        operationId: row.id,
        message,
      };
      db.transaction(() => {
        db.prepare(
          "UPDATE memory_operations SET error=?,updatedAt=? WHERE id=? AND state='prepared'",
        ).run(message, now(), row.id);
        db.prepare(
          "UPDATE tasks SET memoryState='error',memoryError=? WHERE id=?",
        ).run(message, taskId);
      })();
      return value;
    }
    if (
      observation.state === "present" &&
      observation.hash === row.intendedHash
    ) {
      try {
        await dependencies.confirmHost(taskId, row.intendedHash);
      } catch (error) {
        const message = `Durability confirmation is still pending: ${boundedError(error)}`;
        const value: MemoryMutationResult = {
          outcome: "recovery-pending",
          operationId: row.id,
          message,
        };
        db.transaction(() => {
          db.prepare(
            "UPDATE memory_operations SET error=?,updatedAt=? WHERE id=? AND state='prepared'",
          ).run(message, now(), row.id);
          db.prepare(
            "UPDATE tasks SET memoryState='pending',memoryError=? WHERE id=?",
          ).run(message, taskId);
        })();
        return value;
      }
      return finishAccepted(row);
    }
    const wasNotApplied =
      (observation.state === "missing" && row.expectedActualHash === null) ||
      (observation.state === "present" &&
        observation.hash === row.expectedActualHash);
    if (wasNotApplied && row.kind !== "initialize-memory") {
      const value: MemoryMutationResult = {
        outcome: "not-applied",
        operationId: row.id,
        message:
          "The canonical file still has the pre-operation state; the save was not applied. Reread before an explicit retry.",
      };
      db.transaction(() => {
        db.prepare(
          "UPDATE memory_operations SET state='not-applied',resultJson=?,error=NULL,updatedAt=? WHERE id=? AND state='prepared'",
        ).run(JSON.stringify(value), now(), row.id);
        if (taskRow(taskId).memoryRevision > 0)
          db.prepare(
            "UPDATE tasks SET memoryState='healthy',memoryError=NULL WHERE id=?",
          ).run(taskId);
      })();
      return value;
    }
    const value = conflictResult(row.id, observation);
    db.transaction(() => {
      db.prepare(
        "UPDATE memory_operations SET state='conflict',resultJson=?,error=?,updatedAt=? WHERE id=? AND state='prepared'",
      ).run(JSON.stringify(value), value.message, now(), row.id);
      db.prepare(
        "UPDATE tasks SET memoryState='conflict',memoryError=? WHERE id=?",
      ).run(value.message, taskId);
    })();
    return value;
  };
  const inspect = async (taskId: string): Promise<MemoryView> => {
    await reconcilePrepared(taskId);
    const row = taskRow(taskId);
    const active = unresolved(taskId);
    if (active?.state === "prepared")
      return {
        state: "pending",
        operationId: active.id,
        committedToken:
          row.memoryRevision > 0 && row.memoryHash ? token(row) : null,
        message: row.memoryError ?? "Task memory initialization is pending.",
      };
    const observed = await dependencies.readHost(taskId);
    if (
      !active &&
      row.memoryRevision > 0 &&
      observed.state === "present" &&
      observed.hash === row.memoryHash
    ) {
      if (row.memoryState !== "healthy" || row.memoryError)
        db.prepare(
          "UPDATE tasks SET memoryState='healthy',memoryError=NULL WHERE id=?",
        ).run(taskId);
      return {
        state: "healthy",
        content: observed.content,
        token: token(row),
        attribution: attribution(row),
      };
    }
    const reason =
      observed.state === "missing"
        ? "missing"
        : observed.state === "invalid"
          ? observed.reason
          : "external-change";
    const observedHash =
      observed.state === "present"
        ? observed.hash
        : observed.state === "invalid"
          ? observed.observedHash
          : null;
    const message =
      active?.state === "conflict"
        ? (active.error ??
          "A durable memory operation has an unresolved conflict; explicit recovery is required.")
        : observed.state === "missing"
          ? "Canonical memory is missing. It was not recreated."
          : observed.state === "invalid"
            ? observed.message
            : "Canonical memory changed outside supported handlers. Attribution is unknown.";
    db.prepare(
      "UPDATE tasks SET memoryState='conflict',memoryError=? WHERE id=?",
    ).run(message, taskId);
    return {
      state: "conflict",
      operationId: active?.id ?? null,
      content: observed.state === "present" ? observed.content : null,
      committedToken: token(row),
      observedHash,
      reason,
      message,
      attribution: "unknown-external",
      allowedActions:
        observed.state === "present"
          ? ["accept-external", "restore-known"]
          : observed.state === "missing"
            ? ["restore-known"]
            : observed.observedHash
              ? ["restore-known"]
              : [],
    };
  };
  const operationMismatch = (operationId: string): MemoryMutationResult => ({
    outcome: "operation-mismatch",
    operationId,
    message:
      "This operation ID was already used for a different task, operation kind, or content.",
  });
  const replay = async (
    taskId: string,
    operationId: string,
    kind: OperationKind,
    intendedHash: string,
  ) => {
    const row = operation(operationId);
    if (!row) {
      const identity = operationIdentity(operationId);
      if (!identity) return null;
      if (
        identity.taskId !== taskId ||
        identity.kind !== kind ||
        identity.intendedHash !== intendedHash
      )
        return operationMismatch(operationId);
      return {
        outcome: "stale" as const,
        operationId,
        message:
          "This older operation ID has no retained retry result; reread current memory.",
      };
    }
    if (
      row.taskId !== taskId ||
      row.kind !== kind ||
      row.intendedHash !== intendedHash
    )
      return operationMismatch(operationId);
    if (row.datasetEpoch !== dependencies.datasetEpoch())
      return {
        outcome: "stale" as const,
        operationId,
        message:
          "This operation belongs to an older dataset epoch; reread current memory.",
      };
    if (row.state === "prepared") await reconcilePrepared(taskId);
    const currentOperation = operation(operationId)!;
    const stored = resultFromOperation(currentOperation);
    if (currentOperation.state === "accepted" && stored && "token" in stored) {
      const current = taskRow(taskId);
      if (
        current.memoryLatestOperationId !== operationId ||
        current.memoryRevision !== stored.token.memoryRevision ||
        (current.memoryHash ?? EMPTY_MEMORY_HASH) !== stored.token.memoryHash
      )
        return {
          outcome: "stale" as const,
          operationId,
          message:
            "This accepted operation is older than the current memory revision; reread current memory.",
        };
      const observed = await dependencies.readHost(taskId);
      if (
        observed.state !== "present" ||
        observed.hash !== stored.token.memoryHash
      )
        return conflictResult(operationId, observed);
      return stored;
    }
    return (
      stored ?? {
        outcome: "recovery-pending" as const,
        operationId,
        message: "The durable operation remains unresolved.",
      }
    );
  };
  const validToken = (expected: MemoryToken, row: TaskMemoryRow) =>
    expected.datasetEpoch === dependencies.datasetEpoch() &&
    expected.memoryRevision === row.memoryRevision &&
    expected.memoryHash === (row.memoryHash ?? EMPTY_MEMORY_HASH);
  const prepare = (
    taskId: string,
    operationId: string,
    kind: OperationKind,
    current: TaskMemoryRow,
    expectedActualHash: string | null,
    intendedHash: string,
    source: Omit<MemoryAttribution, "at">,
    authorization?: {
      threadId: string;
      linkRevision: number;
      projectId: string;
    },
  ) => {
    const timestamp = now();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO memory_operation_ids(id,taskId,kind,intendedHash) VALUES(?,?,?,?)",
      ).run(operationId, taskId, kind, intendedHash);
      db.prepare(
        `INSERT INTO memory_operations(
        id,taskId,kind,state,datasetEpoch,oldRevision,oldHash,expectedActualHash,
        intendedHash,attributionKind,attributionRoute,attributionThreadId,
        attributionSessionId,expectedThreadId,expectedLinkRevision,expectedProjectId,
        createdAt,updatedAt)
       VALUES(?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        operationId,
        taskId,
        kind,
        dependencies.datasetEpoch(),
        current.memoryRevision,
        current.memoryHash,
        expectedActualHash,
        intendedHash,
        source.kind,
        source.route,
        source.threadId,
        source.sessionId,
        authorization?.threadId ?? null,
        authorization?.linkRevision ?? null,
        authorization?.projectId ?? null,
        timestamp,
        timestamp,
      );
      db.prepare(
        "UPDATE tasks SET memoryState='pending',memoryError=NULL WHERE id=?",
      ).run(taskId);
    })();
    return operation(operationId)!;
  };
  const save = (input: {
    id: string;
    operationId: string;
    token: MemoryToken;
    content: string;
    source?: Omit<MemoryAttribution, "at">;
    authorization?: {
      threadId: string;
      linkRevision: number;
      projectId: string;
    };
  }) =>
    coordinate(input.id, async (): Promise<MemoryMutationResult> => {
      const bytes = Buffer.byteLength(input.content, "utf8");
      const intendedHash = hash(input.content);
      if (input.token.datasetEpoch !== dependencies.datasetEpoch())
        return {
          outcome: "stale",
          operationId: input.operationId,
          message:
            "Dataset changed; reread memory before retrying this operation.",
        };
      if (input.authorization) assertLink(input.id, input.authorization);
      const repeated = await replay(
        input.id,
        input.operationId,
        "save",
        intendedHash,
      );
      if (repeated) return repeated;
      if (bytes > MEMORY_BYTE_LIMIT)
        return {
          outcome: "invalid-content",
          operationId: input.operationId,
          message: `Memory exceeds the ${MEMORY_BYTE_LIMIT} byte limit.`,
        };
      await reconcilePrepared(input.id);
      const stillPending = pendingResult(input.id);
      if (stillPending) return stillPending;
      if (unresolved(input.id)?.state === "conflict")
        return {
          outcome: "external-conflict",
          operationId: input.operationId,
          message:
            "A durable memory conflict remains unresolved; use an explicit accept or restore action.",
        };
      const current = taskRow(input.id);
      if (!validToken(input.token, current))
        return {
          outcome: "stale",
          operationId: input.operationId,
          message: "Memory changed; reread and reapply the draft.",
        };
      const observed = await dependencies.readHost(input.id);
      if (observed.state !== "present" || observed.hash !== current.memoryHash)
        return conflictResult(input.operationId, observed);
      if (intendedHash === current.memoryHash) {
        const value: MemoryMutationResult = {
          outcome: "no-op",
          operationId: input.operationId,
          token: token(current),
          attribution: attribution(current),
        };
        const timestamp = now();
        db.transaction(() => {
          db.prepare(
            "INSERT INTO memory_operation_ids(id,taskId,kind,intendedHash) VALUES(?,?,'save',?)",
          ).run(input.operationId, input.id, intendedHash);
          const source = input.source ?? {
            kind: "human" as const,
            route: "rpc:saveMemory",
            threadId: null,
            sessionId: null,
          };
          db.prepare(
            `INSERT INTO memory_operations(id,taskId,kind,state,datasetEpoch,oldRevision,oldHash,
            expectedActualHash,intendedHash,attributionKind,attributionRoute,attributionThreadId,
            attributionSessionId,expectedThreadId,expectedLinkRevision,expectedProjectId,
            createdAt,updatedAt,resultJson)
           VALUES(?,?,'save','accepted',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            input.operationId,
            input.id,
            dependencies.datasetEpoch(),
            current.memoryRevision,
            current.memoryHash,
            current.memoryHash,
            intendedHash,
            source.kind,
            source.route,
            source.threadId,
            source.sessionId,
            input.authorization?.threadId ?? null,
            input.authorization?.linkRevision ?? null,
            input.authorization?.projectId ?? null,
            timestamp,
            timestamp,
            JSON.stringify(value),
          );
          db.prepare(
            "UPDATE tasks SET memoryLatestOperationId=? WHERE id=?",
          ).run(input.operationId, input.id);
        })();
        pruneSettled(input.id);
        return value;
      }
      prepare(
        input.id,
        input.operationId,
        "save",
        current,
        current.memoryHash,
        intendedHash,
        input.source ?? {
          kind: "human",
          route: "rpc:saveMemory",
          threadId: null,
          sessionId: null,
        },
        input.authorization,
      );
      if (input.authorization) assertLink(input.id, input.authorization);
      try {
        await dependencies.replaceHost({
          taskId: input.id,
          operationId: input.operationId,
          expectedHash: current.memoryHash,
          content: input.content,
        });
      } catch {
        // The response can be lost after replacement; durable reconciliation decides by hash.
      }
      return (
        (await reconcilePrepared(input.id)) ?? {
          outcome: "recovery-pending",
          operationId: input.operationId,
          message: "Memory save remains unresolved.",
        }
      );
    });
  const acceptExternal = (input: {
    id: string;
    operationId: string;
    token: MemoryToken;
    observedHash: string;
  }) =>
    coordinate(input.id, async (): Promise<MemoryMutationResult> => {
      if (input.token.datasetEpoch !== dependencies.datasetEpoch())
        return {
          outcome: "stale",
          operationId: input.operationId,
          message: "Dataset changed; reread before accepting external memory.",
        };
      const repeated = await replay(
        input.id,
        input.operationId,
        "accept-external",
        input.observedHash,
      );
      if (repeated) return repeated;
      await reconcilePrepared(input.id);
      const stillPending = pendingResult(input.id);
      if (stillPending) return stillPending;
      const current = taskRow(input.id);
      if (!validToken(input.token, current))
        return {
          outcome: "stale",
          operationId: input.operationId,
          message:
            "Committed memory token changed; reread before accepting external content.",
        };
      const observed = await dependencies.readHost(input.id);
      if (observed.state !== "present" || observed.hash !== input.observedHash)
        return conflictResult(input.operationId, observed);
      prepare(
        input.id,
        input.operationId,
        "accept-external",
        current,
        observed.hash,
        observed.hash,
        {
          kind: "unknown-external",
          route: "rpc:acceptExternalMemory",
          threadId: null,
          sessionId: null,
        },
      );
      return (
        (await reconcilePrepared(input.id)) ?? {
          outcome: "recovery-pending",
          operationId: input.operationId,
          message: "External acceptance remains unresolved.",
        }
      );
    });
  const restoreKnown = (input: {
    id: string;
    operationId: string;
    token: MemoryToken;
    observedHash: string | null;
    content: string;
  }) =>
    coordinate(input.id, async (): Promise<MemoryMutationResult> => {
      const intendedHash = hash(input.content);
      if (input.token.datasetEpoch !== dependencies.datasetEpoch())
        return {
          outcome: "stale",
          operationId: input.operationId,
          message: "Dataset changed; reread before restoring memory.",
        };
      const repeated = await replay(
        input.id,
        input.operationId,
        "restore-known",
        intendedHash,
      );
      if (repeated) return repeated;
      if (Buffer.byteLength(input.content, "utf8") > MEMORY_BYTE_LIMIT)
        return {
          outcome: "invalid-content",
          operationId: input.operationId,
          message: `Memory exceeds the ${MEMORY_BYTE_LIMIT} byte limit.`,
        };
      await reconcilePrepared(input.id);
      const stillPending = pendingResult(input.id);
      if (stillPending) return stillPending;
      const current = taskRow(input.id);
      if (
        !validToken(input.token, current) ||
        intendedHash !== (current.memoryHash ?? EMPTY_MEMORY_HASH)
      )
        return {
          outcome: "stale",
          operationId: input.operationId,
          message:
            "Restore bytes must hash to the current committed token; reread and supply verified known content.",
        };
      const observed = await dependencies.readHost(input.id);
      const observedMatches =
        input.observedHash === null
          ? observed.state === "missing"
          : (observed.state === "present" &&
              observed.hash === input.observedHash) ||
            (observed.state === "invalid" &&
              observed.observedHash === input.observedHash);
      if (!observedMatches) return conflictResult(input.operationId, observed);
      prepare(
        input.id,
        input.operationId,
        "restore-known",
        current,
        input.observedHash,
        intendedHash,
        {
          kind: "human",
          route: "rpc:restoreKnownMemory",
          threadId: null,
          sessionId: null,
        },
      );
      try {
        await dependencies.replaceHost({
          taskId: input.id,
          operationId: input.operationId,
          expectedHash: input.observedHash,
          content: input.content,
        });
      } catch {
        // Reconcile the actual canonical outcome below.
      }
      return (
        (await reconcilePrepared(input.id)) ?? {
          outcome: "recovery-pending",
          operationId: input.operationId,
          message: "Memory restore remains unresolved.",
        }
      );
    });
  const initialize = (taskId: string) =>
    coordinate(taskId, () => reconcilePrepared(taskId));
  const withTaskLocks = <T>(
    taskIds: string[],
    action: () => Promise<T> | T,
  ) => {
    const ordered = [...new Set(taskIds)].sort();
    const acquire = (index: number): Promise<T> =>
      index === ordered.length
        ? Promise.resolve(action())
        : coordinate(ordered[index]!, () => acquire(index + 1));
    return acquire(0);
  };
  const withLinkReassignment = <T>(
    taskIds: string[] | string,
    action: (locked: {
      read: (taskId: string) => Promise<MemoryView>;
    }) => Promise<T> | T,
  ) => {
    const ids = typeof taskIds === "string" ? [taskIds] : taskIds;
    return withTaskLocks(ids, async () => {
      for (const taskId of [...new Set(ids)].sort()) {
        await reconcilePrepared(taskId);
        if (unresolved(taskId))
          throw new Error(
            `Memory operation for task ${taskId} remains unresolved; link reassignment is blocked.`,
          );
      }
      return action({ read: (taskId: string) => inspect(taskId) });
    });
  };
  const withAuthorizedLink = <T>(
    taskId: string,
    authorization: {
      threadId: string;
      linkRevision: number;
      projectId: string;
    },
    action: (locked: { read: () => Promise<MemoryView> }) => Promise<T> | T,
  ) =>
    coordinate(taskId, async () => {
      assertLink(taskId, authorization);
      return action({ read: () => inspect(taskId) });
    });
  return {
    initialize,
    read: (taskId: string) => coordinate(taskId, () => inspect(taskId)),
    save,
    acceptExternal,
    restoreKnown,
    withLinkReassignment,
    withAuthorizedLink,
    reconcile: (taskId: string) =>
      coordinate(taskId, () => reconcilePrepared(taskId)),
  };
}

export type MemoryCoordinator = ReturnType<typeof createMemoryCoordinator>;
