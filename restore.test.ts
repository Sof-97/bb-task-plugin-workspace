import { afterEach, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import hostEntry from "./host";
import plugin, {
  experimental_archiveMigrationSupport,
  type TaskWorkspaceTestHooks,
} from "./server";
import { canonicalJson, encodeArchive, validateArchive } from "./archive";
import {
  planStagedRestore,
  RESTORE_RECOVERY_STATEMENTS,
  type RestoreRecordSchema,
} from "./restore";
import { enrollment, task } from "./contract";

const cleanups: Array<() => Promise<unknown>> = [];
const dailyAttempts: Array<Promise<unknown>> = [];
afterEach(async () => {
  await Promise.allSettled(
    dailyAttempts.splice(0).map((attempt) => attempt.catch(() => undefined)),
  );
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-restore-"));
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }),
  );
  const worker = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: {
      dataDir: join(root, "host"),
      tempDir: join(root, "temp"),
    },
  });
  cleanups.push(() => worker.experimental_dispose());
  let stageFailures = 0;
  const project = {
    id: "project-1",
    kind: "standard" as const,
    name: "Fixture project",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "source-1",
        projectId: "project-1",
        type: "local_path" as const,
        hostId: "host-1",
        path: "/fixture",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  const host = {
    id: "host-1",
    name: "Local",
    type: "persistent" as const,
    status: "connected" as const,
    maxPermissionMode: "full" as const,
    lastSeenAt: 1,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const { bb, harness } = await createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "plugin"),
    experimental_hostEntry: true,
    sdk: {
      projects: {
        list: async () => [project],
        get: async ({ projectId }) => {
          if (projectId !== project.id) throw Error("Project not found");
          return project;
        },
      },
      hosts: {
        list: async () => [host],
        get: async ({ hostId }) => {
          if (hostId !== host.id) throw Error("Host not found");
          return host;
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "validateRepository" || method === "inspectRepository")
        return {
          repository: (input as { repository: string }).repository,
          version: "fixture",
        };
      if (method === "stageRestoredMemory" && stageFailures > 0) {
        stageFailures -= 1;
        throw Error("Injected staging failure");
      }
      return worker.experimental_call(method as never, input as never);
    },
  });
  const hooks: TaskWorkspaceTestHooks = {};
  await plugin(bb, hooks);
  const call = harness.behavior.callRpc;
  const db = bb.storage.database();
  const dirs = async () => {
    const datasetRow = db.prepare("SELECT id FROM dataset").get() as {
      id: string;
    };
    return {
      datasetId: datasetRow.id,
      datasetRoot: join(root, "host", "datasets", datasetRow.id),
      datasetsRoot: join(root, "host", "datasets"),
      memory: join(root, "host", "datasets", datasetRow.id, "memory"),
      recovery: join(
        root,
        "host",
        "datasets",
        datasetRow.id,
        "archives",
        "recovery",
      ),
    };
  };
  return {
    root,
    call,
    db,
    hooks,
    dirs,
    worker,
    setStageFailures: (value: number) => (stageFailures = value),
    datasetsRoot: join(root, "host", "datasets"),
  };
}

const enrollAndCreate = async (
  f: Awaited<ReturnType<typeof fixture>>,
  title: string,
) => {
  const enrolled = enrollment.parse(
    await f.call("enroll", {
      projectId: "project-1",
      sourceId: "source-1",
      prefix: "fx",
    }),
  );
  const created = task.parse(
    await f.call("create", { enrollmentId: enrolled.id, title }),
  );
  return { enrolled, created };
};

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type ArchiveEnvelope = {
  entries: Array<{ path: string; encoding: string; data: string }>;
  manifest: Record<string, unknown>;
};

const rebuild = (parsed: ArchiveEnvelope): Uint8Array => {
  const payloadByPath = new Map(
    parsed.entries.map((entry: { path: string }) => [entry.path, entry]),
  );
  let records = 0;
  let tables = 0;
  let memories = 0;
  let memoryBytes = 0;
  let payloadBytes = 0;
  const manifestEntries = (
    parsed.manifest.entries as Array<{
      path: string;
      sha256: string;
      size: number;
      type: string;
    }>
  ).map((entry) => {
    const payload = payloadByPath.get(entry.path) as
      { data: string } | undefined;
    if (!payload) throw new Error(`fixture payload ${entry.path} missing`);
    const bytes = Buffer.from(payload.data, "base64");
    payloadBytes += bytes.byteLength;
    if (entry.type === "records") {
      const decoded = JSON.parse(bytes.toString("utf8")) as {
        rows: unknown[];
      };
      records += decoded.rows.length;
      tables += 1;
    } else {
      memories += 1;
      memoryBytes += bytes.byteLength;
    }
    return {
      ...entry,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  });
  parsed.manifest.entries = manifestEntries;
  parsed.manifest.counts = {
    entries: manifestEntries.length,
    memories,
    memoryBytes,
    records,
    tables,
    totalPayloadBytes: payloadBytes,
  };
  return Buffer.from(canonicalJson(parsed), "utf8");
};

const withTable = (
  bytes: Uint8Array,
  name: string,
  mutate: (rows: Record<string, unknown>[]) => void,
): Uint8Array => {
  const parsed = JSON.parse(
    Buffer.from(bytes).toString("utf8"),
  ) as ArchiveEnvelope;
  const payload = parsed.entries.find(
    (entry) => entry.path === `records/${name}.json`,
  );
  if (!payload) throw new Error(`fixture table ${name} missing`);
  const table = JSON.parse(
    Buffer.from(payload.data, "base64").toString("utf8"),
  ) as { rows: Record<string, unknown>[] };
  mutate(table.rows);
  payload.data = Buffer.from(canonicalJson(table), "utf8").toString("base64");
  return rebuild(parsed);
};

test("preview shows archive facts and restore replaces the whole dataset under a fresh epoch", async () => {
  const f = await fixture();
  const { enrolled, created } = await enrollAndCreate(f, "Archived task");
  const archivePath = join(f.root, "snapshot.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const second = task.parse(
    await f.call("create", {
      enrollmentId: enrolled.id,
      title: "Not archived",
    }),
  );
  expect(second.number).toBe(2);
  const preview = (await f.call("previewRestore", { path: archivePath })) as {
    digest: string;
    schemaVersion: number;
    createdAt: string;
    counts: { tasks: number; enrollments: number; memories: number };
    warnings: string[];
    current: { datasetId: string; tasks: number };
    source: { datasetId: string; hostId: string };
  };
  expect(preview.counts.tasks).toBe(1);
  expect(preview.counts.enrollments).toBe(1);
  expect(preview.counts.memories).toBe(1);
  expect(preview.current.tasks).toBe(2);
  expect(preview.schemaVersion).toBe(11);
  expect(preview.source.datasetId).toBe((await f.dirs()).datasetId);
  expect(preview.warnings.some((w) => /older snapshot/i.test(w))).toBe(true);

  const before = (await f.dirs()).datasetId;
  const result = (await f.call("restoreDataset", {
    path: archivePath,
    expectedDigest: preview.digest,
    currentDatasetEpoch: before,
    confirmReplace: true,
  })) as {
    datasetEpoch: string;
    restoredCounts: { tasks: number };
    protective: { kind: string; path: string | null };
  };
  expect(result.datasetEpoch).not.toBe(before);
  expect(result.restoredCounts.tasks).toBe(1);
  expect(result.protective.kind).toBe("complete");
  expect(result.protective.path).toBeTruthy();

  const list = (await f.call("list", null)) as {
    datasetEpoch: string;
    tasks: Array<{ displayId: string; memoryState: string }>;
  };
  expect(list.datasetEpoch).toBe(result.datasetEpoch);
  expect(list.tasks).toHaveLength(1);
  expect(list.tasks[0]!.displayId).toBe(created.displayId);
  expect(list.tasks[0]!.memoryState).toBe("healthy");

  // Actual host placement: the staged epoch directory carries the memory
  // bytes, and the replaced dataset directory is retained.
  const stagedMemory = await readFile(
    join(f.datasetsRoot, result.datasetEpoch, "memory", `${created.id}.md`),
    "utf8",
  );
  expect(stagedMemory).toBe(await archiveMemoryOf(created.id, archivePath));
  expect(await exists(join(f.datasetsRoot, before))).toBe(true);
  expect(await exists(join(f.datasetsRoot, before, "memory"))).toBe(true);

  // A new task continues the archived numbering without collision.
  const recreated = task.parse(
    await f.call("create", {
      enrollmentId: enrolled.id,
      title: "After restore",
    }),
  );
  expect(recreated.number).toBe(2);
  expect(recreated.displayId).toBe("FX-2");

  // Pre-restore session tokens are dead: every epoch-bearing call fails.
  await expect(
    f.call("updateDetails", {
      id: created.id,
      datasetEpoch: before,
      expectedRevision: 1,
      title: "Stale",
      description: "",
    }),
  ).rejects.toThrow(/Dataset changed/);
  const staleSave = (await f.call("saveMemory", {
    id: created.id,
    operationId: randomUUID(),
    token: {
      datasetEpoch: before,
      memoryRevision: 1,
      memoryHash: hashOf(""),
    },
    content: "stale write",
  })) as { outcome: string };
  expect(staleSave.outcome).toBe("stale");
  // The restored thread start operation is quarantined under its old epoch;
  // abandon against the live epoch is refused without any external action.
  await expect(
    f.call("abandonStartOperation", {
      id: created.id,
      operationId: randomUUID(),
      datasetEpoch: before,
    }),
  ).rejects.toThrow(/Thread start operation/);

  // The protective archive lives in the replaced (pre-restore) dataset's
  // recovery directory and is retained until recovery is confirmed.
  const protectiveNames = await readdir(
    join(f.datasetsRoot, before, "archives", "recovery"),
  );
  expect(protectiveNames.some((n) => n.startsWith("protective-"))).toBe(true);
});

const archiveMemoryOf = async (taskId: string, path: string) => {
  const parsed = JSON.parse(
    (await readFile(path)).toString("utf8"),
  ) as ArchiveEnvelope;
  const payload = parsed.entries.find(
    (entry) => entry.path === `memory/${taskId}.md`,
  )!;
  return Buffer.from(payload.data, "base64").toString("utf8");
};

const hashOf = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

const exists = async (path: string) => {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
};

test("restore refuses recovery-only, corrupt and newer archives at preview", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Guarded");
  const archivePath = join(f.root, "good.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  // Corrupt bytes.
  const good = await readFile(archivePath);
  const corrupt = Buffer.concat([
    good.subarray(0, 40),
    Buffer.from("X"),
    good.subarray(51),
  ]);
  const corruptPath = join(f.root, "corrupt.task-workspace.json");
  await writeFile(corruptPath, corrupt);
  await expect(
    f.call("previewRestore", { path: corruptPath }),
  ).rejects.toThrow();
  // Newer schema.
  const parsed = JSON.parse(good.toString("utf8")) as ArchiveEnvelope;
  parsed.manifest.schemaVersion = 12;
  const newerPath = join(f.root, "newer.task-workspace.json");
  await writeFile(newerPath, rebuild(parsed));
  await expect(f.call("previewRestore", { path: newerPath })).rejects.toThrow(
    /newer than this plugin|schema/i,
  );
  // Recovery-only archives are never restore sources.
  const { datasetRoot } = await f.dirs();
  await f.call("exportRecoveryArchive", { reason: "Recovery source test" });
  const recoveryNames = await readdir(
    join(datasetRoot, "archives", "recovery"),
  );
  const recoveryPath = join(
    datasetRoot,
    "archives",
    "recovery",
    recoveryNames.find((n) => n.startsWith("recovery-only-"))!,
  );
  await expect(
    f.call("previewRestore", { path: recoveryPath }),
  ).rejects.toThrow(/recovery-only/i);
});

test("an archive changed after the preview cannot slip through", async () => {
  const f = await fixture();
  const { enrolled } = await enrollAndCreate(f, "Preview race");
  const archivePath = join(f.root, "changing.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const preview = (await f.call("previewRestore", { path: archivePath })) as {
    digest: string;
  };
  // Rewrite the archive with different contents (still a valid archive).
  const second = task.parse(
    await f.call("create", { enrollmentId: enrolled.id, title: "Later" }),
  );
  void second;
  const fresh = join(f.root, "fresh.task-workspace.json");
  await f.call("exportBackup", { destination: fresh });
  await writeFile(archivePath, await readFile(fresh));
  await expect(
    f.call("restoreDataset", {
      path: archivePath,
      expectedDigest: preview.digest,
      currentDatasetEpoch: (await f.dirs()).datasetId,
      confirmReplace: true,
    }),
  ).rejects.toThrow(/changed since the preview/);
  const list = (await f.call("list", null)) as {
    tasks: unknown[];
  };
  expect(list.tasks).toHaveLength(2);
});

test("structurally invalid complete archives are rejected before touching active data", async () => {
  const f = await fixture();
  const { enrolled, created } = await enrollAndCreate(f, "Invalid source");
  const base = join(f.root, "base.task-workspace.json");
  await f.call("exportBackup", { destination: base });
  const original = await readFile(base);
  const cases: Array<[string, Uint8Array, RegExp]> = [];
  // Foreign-key violation: a task referencing an unknown enrollment.
  cases.push([
    "fk",
    withTable(original, "tasks", (rows) => {
      rows[0]!.enrollmentId = randomUUID();
    }),
    /unknown enrollment/,
  ] as [string, Uint8Array, RegExp]);
  // Missing memory file for an initialized task.
  {
    const parsed = JSON.parse(
      Buffer.from(original).toString("utf8"),
    ) as ArchiveEnvelope;
    const memoryPath = `memory/${created.id}.md`;
    parsed.entries = parsed.entries.filter(
      (entry) => entry.path !== memoryPath,
    );
    parsed.manifest.entries = (
      parsed.manifest.entries as Array<{ path: string }>
    ).filter((entry) => entry.path !== memoryPath);
    cases.push([
      "missing-memory",
      rebuild(parsed),
      /no archived memory file/,
    ] as [string, Uint8Array, RegExp]);
  }
  // Memory hash mismatch: rewrite memory bytes and re-stamp the manifest.
  {
    const parsed = JSON.parse(
      Buffer.from(original).toString("utf8"),
    ) as ArchiveEnvelope;
    const payload = parsed.entries.find(
      (entry) => entry.path === `memory/${created.id}.md`,
    )!;
    payload.data = Buffer.from("# Tampered memory", "utf8").toString("base64");
    cases.push([
      "hash",
      rebuild(parsed),
      /does not match its committed hash/,
    ] as [string, Uint8Array, RegExp]);
  }
  // Task number gap below nextNumber.
  cases.push([
    "gap",
    withTable(original, "tasks", (rows) => {
      rows[0]!.number = 5;
    }),
    /missing below nextNumber/,
  ] as [string, Uint8Array, RegExp]);
  // Prepared memory operation in a complete archive.
  {
    const parsed = JSON.parse(
      Buffer.from(original).toString("utf8"),
    ) as ArchiveEnvelope;
    const manifest = parsed.manifest as { source: { datasetId: string } };
    cases.push([
      "prepared-op",
      withTable(original, "memory_operations", (rows) => {
        rows.push({
          id: randomUUID(),
          taskId: created.id,
          kind: "save",
          state: "prepared",
          datasetEpoch: manifest.source.datasetId,
          oldRevision: 1,
          oldHash: null,
          expectedActualHash: null,
          intendedHash: hashOf("x"),
          expectedThreadId: null,
          expectedLinkRevision: null,
          expectedProjectId: null,
          attributionKind: "human",
          attributionRoute: "rpc:saveMemory",
          attributionThreadId: null,
          attributionSessionId: null,
          createdAt: "2026-09-12T00:00:00.000Z",
          updatedAt: "2026-09-12T00:00:00.000Z",
          resultJson: null,
          error: null,
        });
      }),
      /prepared memory operation/,
    ] as [string, Uint8Array, RegExp]);
  }
  // Unsupported record table.
  {
    const parsed = JSON.parse(
      Buffer.from(original).toString("utf8"),
    ) as ArchiveEnvelope;
    const table = {
      name: "future_records",
      classification: "canonical",
      rows: [],
    };
    const data = Buffer.from(canonicalJson(table), "utf8").toString("base64");
    parsed.entries.push({
      path: "records/future_records.json",
      encoding: "base64",
      data,
    });
    (
      parsed.manifest.entries as Array<{
        path: string;
        sha256: string;
        size: number;
        type: string;
      }>
    ).push({
      path: "records/future_records.json",
      sha256: createHash("sha256")
        .update(Buffer.from(data, "base64"))
        .digest("hex"),
      size: Buffer.from(data, "base64").byteLength,
      type: "records",
    });
    cases.push([
      "unknown-table",
      rebuild(parsed),
      /unsupported record tables/,
    ] as [string, Uint8Array, RegExp]);
  }
  // Duplicate archive entry.
  {
    const parsed = JSON.parse(
      Buffer.from(original).toString("utf8"),
    ) as ArchiveEnvelope;
    const first = parsed.entries[0]!;
    parsed.entries.push({ ...first });
    const manifestEntry = (
      parsed.manifest.entries as Array<{ path: string }>
    )[0]!;
    (parsed.manifest.entries as unknown[]).push({ ...manifestEntry });
    const duplicate = Buffer.from(canonicalJson(parsed), "utf8");
    cases.push(["duplicate", duplicate, /Duplicate/] as [
      string,
      Uint8Array,
      RegExp,
    ]);
  }
  // Unsafe path entry.
  {
    const parsed = JSON.parse(
      Buffer.from(original).toString("utf8"),
    ) as ArchiveEnvelope;
    const data = Buffer.from("x").toString("base64");
    parsed.entries.push({
      path: "../../evil.json",
      encoding: "base64",
      data,
    });
    (parsed.manifest.entries as unknown[]).push({
      path: "../../evil.json",
      sha256: createHash("sha256")
        .update(Buffer.from(data, "base64"))
        .digest("hex"),
      size: 1,
      type: "records",
    });
    const unsafe = Buffer.from(canonicalJson(parsed), "utf8");
    cases.push(["unsafe-path", unsafe, /[Uu]nsafe|path/] as [
      string,
      Uint8Array,
      RegExp,
    ]);
  }
  void enrolled;
  for (const [name, bytes, pattern] of cases) {
    const path = join(f.root, `case-${name}.task-workspace.json`);
    await writeFile(path, bytes);
    await expect(f.call("previewRestore", { path })).rejects.toThrow(pattern);
  }
  // The current dataset is untouched by every rejected preview.
  const list = (await f.call("list", null)) as { tasks: unknown[] };
  expect(list.tasks).toHaveLength(1);
});

test("a failed protective capture aborts restore and leaves the current dataset untouched", async () => {
  const f = await fixture();
  const { enrolled } = await enrollAndCreate(f, "Protected");
  const archivePath = join(f.root, "abort.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const preview = (await f.call("previewRestore", { path: archivePath })) as {
    digest: string;
  };
  const { recovery, datasetId } = await f.dirs();
  // Read-only recovery directory fails both the complete protective
  // publication and the recovery-only fallback publication.
  await chmod(recovery, 0o555);
  let failure: unknown;
  try {
    await f.call("restoreDataset", {
      path: archivePath,
      expectedDigest: preview.digest,
      currentDatasetEpoch: datasetId,
      confirmReplace: true,
    });
  } catch (error) {
    failure = error;
  } finally {
    await chmod(recovery, 0o755);
  }
  expect(String(failure)).toMatch(/aborted|protective|left untouched/i);
  const list = (await f.call("list", null)) as {
    datasetEpoch: string;
    tasks: unknown[];
  };
  expect(list.datasetEpoch).toBe(datasetId);
  expect(list.tasks).toHaveLength(1);
  // No staging directory survived the abort.
  const datasets = await readdir(f.datasetsRoot);
  expect(datasets.filter((name) => name !== datasetId)).toHaveLength(0);
  void enrolled;
});

test("a damaged current dataset is preserved by a recovery-only protective copy and restore still succeeds", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Damaged current");
  const archivePath = join(f.root, "repair.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const { memory, datasetId, recovery } = await f.dirs();
  // Damage the current canonical memory beyond repair.
  await writeFile(
    join(memory, `${created.id}.md`),
    Buffer.from([0xff, 0xfe, 0x00]),
  );
  const beforeEpoch = datasetId;
  const result = (await f.call("restoreDataset", {
    path: archivePath,
    expectedDigest: (
      (await f.call("previewRestore", { path: archivePath })) as {
        digest: string;
      }
    ).digest,
    currentDatasetEpoch: beforeEpoch,
    confirmReplace: true,
  })) as {
    datasetEpoch: string;
    protective: { kind: string; path: string | null };
  };
  expect(result.protective.kind).toBe("recovery-only");
  expect(result.datasetEpoch).not.toBe(beforeEpoch);
  const names = await readdir(recovery);
  expect(names.some((n) => n.startsWith("recovery-only-"))).toBe(true);
  const list = (await f.call("list", null)) as {
    tasks: Array<{ id: string; displayId: string; memoryState: string }>;
  };
  expect(list.tasks).toHaveLength(1);
  expect(list.tasks[0]!.displayId).toBe(created.displayId);
  expect(list.tasks[0]!.memoryState).toBe("healthy");
}, 20_000);

test("a staging failure aborts restore, cleans staging and keeps the current dataset", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Stage failure");
  const archivePath = join(f.root, "stage.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const preview = (await f.call("previewRestore", { path: archivePath })) as {
    digest: string;
  };
  const { datasetId, recovery } = await f.dirs();
  f.setStageFailures(1);
  await expect(
    f.call("restoreDataset", {
      path: archivePath,
      expectedDigest: preview.digest,
      currentDatasetEpoch: datasetId,
      confirmReplace: true,
    }),
  ).rejects.toThrow(/staging|Injected/i);
  const list = (await f.call("list", null)) as {
    datasetEpoch: string;
    tasks: unknown[];
  };
  expect(list.datasetEpoch).toBe(datasetId);
  expect(list.tasks).toHaveLength(1);
  const datasets = await readdir(f.datasetsRoot);
  expect(datasets.filter((name) => name !== datasetId)).toHaveLength(0);
  // The protective copy was retained even though the restore aborted.
  expect(
    (await readdir(recovery)).some((n) => n.startsWith("protective-")),
  ).toBe(true);
  void created;
});

test("a crash before the commit rolls back and leaves the old dataset active", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Pre commit");
  const archivePath = join(f.root, "pre.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const preview = (await f.call("previewRestore", { path: archivePath })) as {
    digest: string;
  };
  const { datasetId } = await f.dirs();
  f.hooks.failRestoreAt = (point) => {
    if (point === "before-commit") throw new Error("Injected pre-commit crash");
  };
  await expect(
    f.call("restoreDataset", {
      path: archivePath,
      expectedDigest: preview.digest,
      currentDatasetEpoch: datasetId,
      confirmReplace: true,
    }),
  ).rejects.toThrow(/Injected pre-commit crash/);
  const list = (await f.call("list", null)) as {
    datasetEpoch: string;
    tasks: unknown[];
  };
  expect(list.datasetEpoch).toBe(datasetId);
  expect(list.tasks).toHaveLength(1);
  expect(
    (await readdir(f.datasetsRoot)).filter((name) => name !== datasetId),
  ).toHaveLength(0);
  void created;
});

test("a crash after the commit resumes against the restored dataset", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Post commit");
  const archivePath = join(f.root, "post.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const preview = (await f.call("previewRestore", { path: archivePath })) as {
    digest: string;
  };
  const { datasetId } = await f.dirs();
  f.hooks.failRestoreAt = (point) => {
    if (point === "after-commit") throw new Error("Injected post-commit crash");
  };
  await expect(
    f.call("restoreDataset", {
      path: archivePath,
      expectedDigest: preview.digest,
      currentDatasetEpoch: datasetId,
      confirmReplace: true,
    }),
  ).rejects.toThrow(/Injected post-commit crash/);
  // The transaction committed: the restored dataset is the live one.
  const datasetRow = f.db.prepare("SELECT id FROM dataset").get() as {
    id: string;
  };
  expect(datasetRow.id).not.toBe(datasetId);
  const list = (await f.call("list", null)) as {
    datasetEpoch: string;
    tasks: Array<{ displayId: string; memoryState: string }>;
  };
  expect(list.datasetEpoch).toBe(datasetRow.id);
  expect(list.tasks).toHaveLength(1);
  expect(list.tasks[0]!.displayId).toBe(created.displayId);
  expect(list.tasks[0]!.memoryState).toBe("healthy");
});

test("restored pending operations are quarantined for human inspection without any external action", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Quarantine");
  const archivePath = join(f.root, "quarantine.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const original = await readFile(archivePath);
  const epoch = (
    JSON.parse(Buffer.from(original).toString("utf8")) as ArchiveEnvelope
  ).manifest as {
    source: { datasetId: string };
  };
  const startOpId = randomUUID();
  const crafted = withTable(original, "thread_start_operations", (rows) => {
    rows.push({
      id: startOpId,
      taskId: created.id,
      state: "dispatching",
      datasetEpoch: epoch.source.datasetId,
      taskRevision: 1,
      linkContextJson: "[]",
      projectId: "project-1",
      environmentJson: JSON.stringify({
        type: "host",
        hostId: "host-1",
        workspace: { type: "unmanaged", path: null },
      }),
      hostId: "host-1",
      providerId: "fixture",
      model: "fixture",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "auto",
      executionInputSourcesJson: "{}",
      sendAt: null,
      inputDigest: createHash("sha256").update("input").digest("hex"),
      requestDigest: createHash("sha256").update("request").digest("hex"),
      memoryRevision: 1,
      memoryHash: hashOf(""),
      threadId: null,
      error: null,
      abandonedAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
  });
  const quarantinePath = join(f.root, "quarantine-craft.task-workspace.json");
  await writeFile(quarantinePath, crafted);
  const preview = (await f.call("previewRestore", {
    path: quarantinePath,
  })) as { digest: string };
  const result = (await f.call("restoreDataset", {
    path: quarantinePath,
    expectedDigest: preview.digest,
    currentDatasetEpoch: (await f.dirs()).datasetId,
    confirmReplace: true,
  })) as { datasetEpoch: string };
  const list = (await f.call("list", null)) as {
    startOperations: Array<{
      id: string;
      state: string;
      error: string | null;
      datasetEpoch: string;
    }>;
  };
  const op = list.startOperations.find((item) => item.id === startOpId)!;
  expect(op.state).toBe("uncertain");
  expect(op.error).toMatch(/Restored from an archive/);
  expect(op.datasetEpoch).not.toBe(result.datasetEpoch);
  // Recovery against the quarantined op is refused: it belongs to the old epoch.
  await expect(
    f.call("retryStartLink", {
      id: created.id,
      operationId: startOpId,
      datasetEpoch: result.datasetEpoch,
    }),
  ).rejects.toThrow(/another dataset epoch/);
  await expect(
    f.call("abandonStartOperation", {
      id: created.id,
      operationId: startOpId,
      datasetEpoch: result.datasetEpoch,
    }),
  ).rejects.toThrow(/another dataset epoch/);
}, 20_000);

test("a prepared start operation restores to failed-before-dispatch with no replay", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Prepared restore");
  const archivePath = join(f.root, "prepared.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const original = await readFile(archivePath);
  const parsed = JSON.parse(
    Buffer.from(original).toString("utf8"),
  ) as ArchiveEnvelope;
  const manifest = parsed.manifest as { source: { datasetId: string } };
  const opId = randomUUID();
  const crafted = withTable(original, "thread_start_operations", (rows) => {
    rows.push({
      id: opId,
      taskId: created.id,
      state: "prepared",
      datasetEpoch: manifest.source.datasetId,
      taskRevision: 1,
      linkContextJson: "[]",
      projectId: "project-1",
      environmentJson: JSON.stringify({
        type: "host",
        hostId: "host-1",
        workspace: { type: "unmanaged", path: null },
      }),
      hostId: "host-1",
      providerId: "fixture",
      model: "fixture",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "auto",
      executionInputSourcesJson: "{}",
      sendAt: null,
      inputDigest: createHash("sha256").update("input").digest("hex"),
      requestDigest: createHash("sha256").update("request").digest("hex"),
      memoryRevision: 1,
      memoryHash: hashOf(""),
      threadId: null,
      error: null,
      abandonedAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
  });
  const craftedPath = join(f.root, "prepared-craft.task-workspace.json");
  await writeFile(craftedPath, crafted);
  const preview = (await f.call("previewRestore", {
    path: craftedPath,
  })) as { digest: string };
  await f.call("restoreDataset", {
    path: craftedPath,
    expectedDigest: preview.digest,
    currentDatasetEpoch: (await f.dirs()).datasetId,
    confirmReplace: true,
  });
  const list = (await f.call("list", null)) as {
    startOperations: Array<{ id: string; state: string; error: string | null }>;
  };
  const op = list.startOperations.find((item) => item.id === opId)!;
  expect(op.state).toBe("failed-before-dispatch");
  expect(op.error).toMatch(/Restored from an archive/);
});

test("a schema-9 archive is migrated in staging and restored", async () => {
  const f = await fixture();
  const { enrolled, created } = await enrollAndCreate(f, "Nine schema");
  const archivePath = join(f.root, "nine.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const original = await readFile(archivePath);
  // Downgrade to schema 9: drop wayfinder_attachments, capture_requests and one ledger row.
  const parsed = JSON.parse(
    Buffer.from(original).toString("utf8"),
  ) as ArchiveEnvelope;
  parsed.entries = parsed.entries.filter(
    (entry) =>
      entry.path !== "records/wayfinder_attachments.json" &&
      entry.path !== "records/capture_requests.json",
  );
  parsed.manifest.entries = (
    parsed.manifest.entries as Array<{ path: string }>
  ).filter(
    (entry) =>
      entry.path !== "records/wayfinder_attachments.json" &&
      entry.path !== "records/capture_requests.json",
  );
  const ledgerPayload = parsed.entries.find(
    (entry) => entry.path === "records/bb_migrations.json",
  )!;
  const ledger = JSON.parse(
    Buffer.from(ledgerPayload.data, "base64").toString("utf8"),
  ) as { rows: unknown[] };
  ledger.rows = ledger.rows.slice(0, 9);
  ledgerPayload.data = Buffer.from(canonicalJson(ledger), "utf8").toString(
    "base64",
  );
  parsed.manifest.schemaVersion = 9;
  const ninePath = join(f.root, "nine-craft.task-workspace.json");
  await writeFile(ninePath, rebuild(parsed));
  const preview = (await f.call("previewRestore", { path: ninePath })) as {
    digest: string;
    schemaVersion: number;
    warnings: string[];
  };
  expect(preview.schemaVersion).toBe(9);
  expect(preview.warnings.some((w) => /migrated to schema 11/.test(w))).toBe(
    true,
  );
  const result = (await f.call("restoreDataset", {
    path: ninePath,
    expectedDigest: preview.digest,
    currentDatasetEpoch: (await f.dirs()).datasetId,
    confirmReplace: true,
  })) as { datasetEpoch: string; restoredCounts: { tasks: number } };
  expect(result.restoredCounts.tasks).toBe(1);
  const list = (await f.call("list", null)) as {
    tasks: Array<{ displayId: string; memoryState: string }>;
  };
  expect(list.tasks).toHaveLength(1);
  expect(list.tasks[0]!.displayId).toBe(created.displayId);
  expect(
    (
      f.db.prepare("SELECT COUNT(*) AS c FROM _bb_migrations").get() as {
        c: number;
      }
    ).c,
  ).toBe(11);
  expect(
    (
      f.db.prepare("SELECT COUNT(*) AS c FROM wayfinder_attachments").get() as {
        c: number;
      }
    ).c,
  ).toBe(0);
  void enrolled;
}, 20_000);

test("restore retains the replaced dataset directory and preserves healthy memory bytes", async () => {
  const f = await fixture();
  const { enrolled, created } = await enrollAndCreate(f, "Bytes kept");
  const archivePath = join(f.root, "bytes.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const memoryBefore = await readFile(
    join((await f.dirs()).memory, `${created.id}.md`),
    "utf8",
  );
  const beforeEpoch = (await f.dirs()).datasetId;
  const result = (await f.call("restoreDataset", {
    path: archivePath,
    expectedDigest: (
      (await f.call("previewRestore", { path: archivePath })) as {
        digest: string;
      }
    ).digest,
    currentDatasetEpoch: beforeEpoch,
    confirmReplace: true,
  })) as { datasetEpoch: string };
  const staged = await readFile(
    join(f.datasetsRoot, result.datasetEpoch, "memory", `${created.id}.md`),
    "utf8",
  );
  expect(staged).toBe(memoryBefore);
  expect(await exists(join(f.datasetsRoot, beforeEpoch))).toBe(true);
  void enrolled;
});

test("staging cleanup requires an explicit ownership marker and never removes active or unrelated roots", async () => {
  const f = await fixture();
  const { datasetId, datasetRoot } = await f.dirs();
  // The active dataset directory is memory-only (archives are created lazily):
  // its shape alone used to be accepted as staging ownership. With no explicit
  // staging marker it must never be removed.
  await mkdir(join(datasetRoot, "memory"), { recursive: true });
  await writeFile(
    join(datasetRoot, "memory", `${randomUUID()}.md`),
    "# active memory",
  );
  const active = (await f.worker.experimental_call("discardStagedDataset", {
    dataset: datasetId,
    token: randomUUID(),
  })) as { removed: boolean };
  expect(active.removed).toBe(false);
  expect(await exists(datasetRoot)).toBe(true);
  expect(await exists(join(datasetRoot, "memory"))).toBe(true);

  // A genuine owned staging directory can be discarded with its own token.
  const stagingId = randomUUID();
  const token = randomUUID();
  await f.worker.experimental_call("beginStagedDataset", {
    dataset: stagingId,
    token,
  });
  const stagedTask = randomUUID();
  await f.worker.experimental_call("stageRestoredMemory", {
    dataset: stagingId,
    token,
    taskId: stagedTask,
    bytesBase64: Buffer.from("# staged", "utf8").toString("base64"),
    expectedHash: hashOf("# staged"),
  });
  const wrongToken = (await f.worker.experimental_call("discardStagedDataset", {
    dataset: stagingId,
    token: randomUUID(),
  })) as { removed: boolean };
  expect(wrongToken.removed).toBe(false);
  expect(await exists(join(f.datasetsRoot, stagingId))).toBe(true);
  const removed = (await f.worker.experimental_call("discardStagedDataset", {
    dataset: stagingId,
    token,
  })) as { removed: boolean };
  expect(removed.removed).toBe(true);
  expect(await exists(join(f.datasetsRoot, stagingId))).toBe(false);

  // A different, marker-owned directory whose shape is not a bare staging
  // inventory (an extra unowned entry) is retained even with the right token.
  const foreign = join(f.datasetsRoot, randomUUID());
  await mkdir(join(foreign, "memory"), { recursive: true });
  await writeFile(
    join(foreign, "restore-staging.json"),
    JSON.stringify({ token, dataset: foreign.split("/").pop()! }),
  );
  await writeFile(join(foreign, "memory", "stray.txt"), "keep me");
  const refused = (await f.worker.experimental_call("discardStagedDataset", {
    dataset: foreign.split("/").pop()!,
    token,
  })) as { removed: boolean };
  expect(refused.removed).toBe(false);
  expect(await exists(foreign)).toBe(true);

  // A symlink swapped in for the dataset directory is never followed.
  const linkedId = randomUUID();
  await symlink(datasetRoot, join(f.datasetsRoot, linkedId));
  const refusedLink = (await f.worker.experimental_call(
    "discardStagedDataset",
    { dataset: linkedId, token },
  )) as { removed: boolean };
  expect(refusedLink.removed).toBe(false);
  expect(await exists(datasetRoot)).toBe(true);
});

test("an interrupted restore is reconciled against the active dataset on restart", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Reconcile");
  const { datasetId, datasetRoot } = await f.dirs();
  // Abandoned staging (not the active dataset) is fully owned staging and is
  // removed by reconciliation.
  const abandoned = randomUUID();
  const abandonedToken = randomUUID();
  await f.worker.experimental_call("beginStagedDataset", {
    dataset: abandoned,
    token: abandonedToken,
  });
  await f.worker.experimental_call("stageRestoredMemory", {
    dataset: abandoned,
    token: abandonedToken,
    taskId: randomUUID(),
    bytesBase64: Buffer.from("# abandoned", "utf8").toString("base64"),
    expectedHash: hashOf("# abandoned"),
  });
  // A post-commit crash leaves the marker on the now-active dataset: the
  // directory and its memory must be kept, and only the marker cleared.
  const activeMemory = join(datasetRoot, "memory");
  const activeFile = (await readdir(activeMemory))[0]!;
  const activeContent = await readFile(join(activeMemory, activeFile), "utf8");
  await writeFile(
    join(datasetRoot, "restore-staging.json"),
    JSON.stringify({ token: randomUUID(), dataset: datasetId }),
  );
  const reconciled = (await f.worker.experimental_call(
    "reconcileStagedDatasets",
    { activeDataset: datasetId },
  )) as { discarded: string[]; finalized: string[] };
  expect(reconciled.discarded).toContain(abandoned);
  expect(reconciled.finalized).toContain(datasetId);
  expect(await exists(join(f.datasetsRoot, abandoned))).toBe(false);
  expect(await exists(datasetRoot)).toBe(true);
  expect(await readFile(join(activeMemory, activeFile), "utf8")).toBe(
    activeContent,
  );
  expect(await exists(join(datasetRoot, "restore-staging.json"))).toBe(false);
});

test("foreign-host and manifest/ledger mismatched archives are rejected before any write", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Host bound");
  const base = join(f.root, "hostbase.task-workspace.json");
  await f.call("exportBackup", { destination: base });
  const original = await readFile(base);

  // The dataset record disagrees with the manifest source.
  const mismatched = withTable(original, "dataset", (rows) => {
    rows[0]!.hostId = "host-foreign";
  });
  const mismatchedPath = join(f.root, "mismatch.task-workspace.json");
  await writeFile(mismatchedPath, mismatched);
  await expect(
    f.call("previewRestore", { path: mismatchedPath }),
  ).rejects.toThrow(/manifest source|dataset record/i);

  // Record and manifest agree on a foreign host: single-machine policy rejects.
  const parsed = JSON.parse(
    Buffer.from(original).toString("utf8"),
  ) as ArchiveEnvelope;
  const foreign = withTable(original, "dataset", (rows) => {
    rows[0]!.hostId = "host-foreign";
  });
  const foreignParsed = JSON.parse(
    Buffer.from(foreign).toString("utf8"),
  ) as ArchiveEnvelope;
  (foreignParsed.manifest.source as { hostId: string }).hostId = "host-foreign";
  const foreignPath = join(f.root, "foreign.task-workspace.json");
  await writeFile(
    foreignPath,
    Buffer.from(canonicalJson(foreignParsed), "utf8"),
  );
  await expect(f.call("previewRestore", { path: foreignPath })).rejects.toThrow(
    /single-machine|host-foreign/i,
  );

  // Manifest schema version disagrees with the dense record ledger.
  parsed.manifest.schemaVersion = 9;
  const schemaPath = join(f.root, "schema-mismatch.task-workspace.json");
  await writeFile(schemaPath, rebuild(parsed));
  await expect(f.call("previewRestore", { path: schemaPath })).rejects.toThrow(
    /manifest declares schema|ledger/i,
  );

  const list = (await f.call("list", null)) as { tasks: unknown[] };
  expect(list.tasks).toHaveLength(1);
  void created;
});

test("preview rejects unknown columns, missing required columns, bad status and duplicates", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Column shape");
  const base = join(f.root, "shape.task-workspace.json");
  await f.call("exportBackup", { destination: base });
  const original = await readFile(base);

  const unknowns = withTable(original, "tasks", (rows) => {
    rows[0]!.futureColumn = "not in the installed schema";
  });
  await writeFile(join(f.root, "unknown-col.task-workspace.json"), unknowns);
  await expect(
    f.call("previewRestore", {
      path: join(f.root, "unknown-col.task-workspace.json"),
    }),
  ).rejects.toThrow(/unknown column/i);

  const missing = withTable(original, "tasks", (rows) => {
    delete rows[0]!.displayId;
  });
  await writeFile(join(f.root, "missing-col.task-workspace.json"), missing);
  await expect(
    f.call("previewRestore", {
      path: join(f.root, "missing-col.task-workspace.json"),
    }),
  ).rejects.toThrow(/missing required column/i);

  const badStatus = withTable(original, "tasks", (rows) => {
    rows[0]!.status = "Completed";
  });
  await writeFile(join(f.root, "bad-status.task-workspace.json"), badStatus);
  await expect(
    f.call("previewRestore", {
      path: join(f.root, "bad-status.task-workspace.json"),
    }),
  ).rejects.toThrow(/unsupported status/i);

  const duplicate = withTable(original, "tasks", (rows) => {
    rows.push({ ...rows[0]!, id: randomUUID(), number: 2 });
  });
  await writeFile(join(f.root, "duplicate.task-workspace.json"), duplicate);
  await expect(
    f.call("previewRestore", {
      path: join(f.root, "duplicate.task-workspace.json"),
    }),
  ).rejects.toThrow(/Duplicate task display ID/i);

  void created;
});

test("a post-commit crash leaves restored pending starts already quarantined", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Atomic quarantine");
  const archivePath = join(f.root, "atomic.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const original = await readFile(archivePath);
  const source = (
    JSON.parse(Buffer.from(original).toString("utf8")) as ArchiveEnvelope
  ).manifest as { source: { datasetId: string } };
  const opId = randomUUID();
  const crafted = withTable(original, "thread_start_operations", (rows) => {
    rows.push({
      id: opId,
      taskId: created.id,
      state: "dispatching",
      datasetEpoch: source.source.datasetId,
      taskRevision: 1,
      linkContextJson: "[]",
      projectId: "project-1",
      environmentJson: JSON.stringify({
        type: "host",
        hostId: "host-1",
        workspace: { type: "unmanaged", path: null },
      }),
      hostId: "host-1",
      providerId: "fixture",
      model: "fixture",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "auto",
      executionInputSourcesJson: "{}",
      sendAt: null,
      inputDigest: createHash("sha256").update("input").digest("hex"),
      requestDigest: createHash("sha256").update("request").digest("hex"),
      memoryRevision: 1,
      memoryHash: hashOf(""),
      threadId: null,
      error: null,
      abandonedAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
  });
  const craftedPath = join(f.root, "atomic-craft.task-workspace.json");
  await writeFile(craftedPath, crafted);
  const preview = (await f.call("previewRestore", {
    path: craftedPath,
  })) as { digest: string };
  f.hooks.failRestoreAt = (point) => {
    if (point === "after-commit") throw new Error("Injected post-commit crash");
  };
  await expect(
    f.call("restoreDataset", {
      path: craftedPath,
      expectedDigest: preview.digest,
      currentDatasetEpoch: (await f.dirs()).datasetId,
      confirmReplace: true,
    }),
  ).rejects.toThrow(/Injected post-commit crash/);
  // The switch and its quarantine committed together: the restored pending
  // start is already uncertain with no second transaction needed.
  const list = (await f.call("list", null)) as {
    startOperations: Array<{ id: string; state: string }>;
  };
  expect(list.startOperations.find((op) => op.id === opId)?.state).toBe(
    "uncertain",
  );
}, 20_000);

test("staging validation reproduces the installed schema and reads migrated rows back", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Ledger hash");
  const archivePath = join(f.root, "ledger.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const decoded = validateArchive(await readFile(archivePath));
  const schema: RestoreRecordSchema = {};
  for (const archiveTable of decoded.tables) {
    if (archiveTable.name === "bb_migrations") continue;
    const columns = new Set<string>();
    for (const row of archiveTable.rows)
      for (const key of Object.keys(row)) columns.add(key);
    schema[archiveTable.name] = {
      columns: [...columns],
      required: [...columns],
    };
  }
  const plan = planStagedRestore(decoded.tables, decoded.memories, {
    currentHostId: (decoded.manifest.source as { hostId: string }).hostId,
    manifest: decoded.manifest as {
      schemaVersion: number;
      source: { datasetId: string; hostId: string };
    },
    schema,
  });
  expect(plan.schemaVersion).toBe(11);
  expect(plan.taskCount).toBe(1);
  expect(plan.memoryHashByTask.size).toBe(1);
  void RESTORE_RECOVERY_STATEMENTS;
  void experimental_archiveMigrationSupport;
});
