import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryCoordinator } from "./memory";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("link reassignment stays behind unresolved memory conflicts across coordinator restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-coordinator-"));
  const { bb, harness } = createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: root,
  });
  const db = bb.storage.database();
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      memoryState TEXT NOT NULL,
      memoryError TEXT,
      memoryHash TEXT,
      memoryRevision INTEGER NOT NULL,
      memoryAttributionKind TEXT NOT NULL,
      memoryAttributionRoute TEXT NOT NULL,
      memoryAttributionThreadId TEXT,
      memoryAttributionSessionId TEXT,
      memoryAttributionAt TEXT NOT NULL,
      memoryLatestOperationId TEXT
    );
    CREATE TABLE memory_operations (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      datasetEpoch TEXT NOT NULL,
      oldRevision INTEGER NOT NULL,
      oldHash TEXT,
      expectedActualHash TEXT,
      intendedHash TEXT NOT NULL,
      attributionKind TEXT NOT NULL,
      attributionRoute TEXT NOT NULL,
      attributionThreadId TEXT,
      attributionSessionId TEXT,
      expectedThreadId TEXT,
      expectedLinkRevision INTEGER,
      expectedProjectId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      resultJson TEXT,
      error TEXT
    );
    CREATE UNIQUE INDEX one_prepared_memory_operation_per_task
      ON memory_operations(taskId) WHERE state='prepared';
    CREATE TABLE memory_operation_ids (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      kind TEXT NOT NULL,
      intendedHash TEXT NOT NULL
    );
  `);
  const taskId = randomUUID();
  const epoch = randomUUID();
  const initial = "known";
  let canonical = initial;
  db.prepare(
    `INSERT INTO tasks VALUES(?, 'conflict', 'third hash', ?, 1,
      'human','rpc:saveMemory',NULL,NULL,'2026-09-11T00:00:00.000Z',NULL)`,
  ).run(taskId, digest(initial));
  const conflictId = randomUUID();
  db.prepare(
    `INSERT INTO memory_operations VALUES(
      ?,?,'save','conflict',?,1,?,?,?,'human','rpc:saveMemory',NULL,NULL,NULL,NULL,NULL,
      '2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z',NULL,'third hash')`,
  ).run(
    conflictId,
    taskId,
    epoch,
    digest(initial),
    digest(initial),
    digest("other"),
  );
  db.prepare("INSERT INTO memory_operation_ids VALUES(?,?,'save',?)").run(
    conflictId,
    taskId,
    digest("other"),
  );
  const makeCoordinator = () =>
    createMemoryCoordinator({
      db,
      datasetEpoch: () => epoch,
      readHost: async () => ({
        state: "present" as const,
        content: canonical,
        hash: digest(canonical),
        size: Buffer.byteLength(canonical),
      }),
      initializeHost: async () => ({
        state: "present" as const,
        content: canonical,
        hash: digest(canonical),
        size: Buffer.byteLength(canonical),
      }),
      replaceHost: async ({ content }) => {
        canonical = content;
        return { hash: digest(content), size: Buffer.byteLength(content) };
      },
      confirmHost: async (_id, expectedHash) => ({
        hash: expectedHash,
        size: Buffer.byteLength(canonical),
      }),
      publish: () => undefined,
      now: () => "2026-09-11T01:00:00.000Z",
    });
  const first = makeCoordinator();
  await expect(
    first.withLinkReassignment(taskId, () => "linked"),
  ).rejects.toThrow("unresolved");
  expect(
    await first.save({
      id: taskId,
      operationId: randomUUID(),
      token: {
        datasetEpoch: epoch,
        memoryRevision: 1,
        memoryHash: digest(initial),
      },
      content: "new",
    }),
  ).toMatchObject({ outcome: "external-conflict" });
  const restarted = makeCoordinator();
  await expect(
    restarted.withLinkReassignment(taskId, () => "linked"),
  ).rejects.toThrow("unresolved");
  expect(
    await restarted.restoreKnown({
      id: taskId,
      operationId: randomUUID(),
      token: {
        datasetEpoch: epoch,
        memoryRevision: 1,
        memoryHash: digest(initial),
      },
      observedHash: digest(initial),
      content: initial,
    }),
  ).toMatchObject({ outcome: "restored-known" });
  await expect(
    restarted.withLinkReassignment(taskId, () => "linked"),
  ).resolves.toBe("linked");
  expect(
    db
      .prepare("SELECT state FROM memory_operations WHERE id=?")
      .get(conflictId),
  ).toMatchObject({ state: "resolved" });
  await harness.lifecycle.dispose();
  await rm(root, { recursive: true, force: true });
});
