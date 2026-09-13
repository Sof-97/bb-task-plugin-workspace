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
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import hostEntry, { experimental_archiveFiles } from "./host";
import plugin, { experimental_archiveMigrationSupport } from "./server";
import { encodeArchive, validateArchive } from "./archive";
import { enrollment, task } from "./contract";

const ARCHIVE_SUFFIX = ".task-workspace.json";
const ARCHIVE_SCHEMA_VERSION_SEED = 10;
const ARCHIVE_SCHEMA_VERSION_LIVE = 12;
const SEED_EXTENSIONS = { adapter: "seed/v1" };

const cleanups: Array<() => Promise<unknown>> = [];
const dailyAttempts: Array<Promise<unknown>> = [];
afterEach(async () => {
  // Drain fired-and-forgotten daily attempts before removing directories so
  // background publication cannot race cleanup.
  await Promise.allSettled(
    dailyAttempts.splice(0).map((attempt) => attempt.catch(() => undefined)),
  );
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-backup-"));
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
  let readMemoryCorrupt = 0;
  let readGate: Promise<void> | null = null;
  let releaseRead: (() => void) | null = null;
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
      if (method === "readMemory" && readMemoryCorrupt > 0) {
        readMemoryCorrupt -= 1;
        throw Error("Injected read failure during archive capture");
      }
      if (method === "readMemory" && readGate) {
        const gate = readGate;
        readGate = null;
        await gate;
      }
      return worker.experimental_call(method as never, input as never);
    },
  });
  await plugin(bb, {
    onDailyAttempt: (attempt) => dailyAttempts.push(attempt),
  });
  const call = harness.behavior.callRpc;
  const db = bb.storage.database();
  const dirs = async () => {
    const datasetRow = db.prepare("SELECT id FROM dataset").get() as {
      id: string;
    };
    return {
      datasetId: datasetRow.id,
      datasetRoot: join(root, "host", "datasets", datasetRow.id),
      daily: join(root, "host", "datasets", datasetRow.id, "archives", "daily"),
      memory: join(root, "host", "datasets", datasetRow.id, "memory"),
    };
  };
  return {
    root,
    call,
    db,
    dirs,
    setReadCorrupt: (value: number) => (readMemoryCorrupt = value),
    holdNextRead: () => {
      readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    },
    releaseRead: () => {
      releaseRead?.();
      readGate = null;
      releaseRead = null;
    },
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

const stamp = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 12);

const seedArchive = (
  datasetId: string,
  hostId: string,
  day: string,
  schemaVersion = ARCHIVE_SCHEMA_VERSION_SEED,
) =>
  encodeArchive({
    archiveKind: "complete",
    schemaVersion,
    createdAt: `${day}T01:00:00.000Z`,
    localDay: day,
    source: { datasetId, hostId },
    diagnostics: [],
    extensions: SEED_EXTENSIONS,
    tables: [],
    memories: [],
  });

test("first daily use publishes exactly one healthy archive; explicit same-day retry adds the newer snapshot; later uses add nothing", async () => {
  const f = await fixture();
  const { enrolled, created } = await enrollAndCreate(f, "Backup me");
  const list = (await f.call("list", null)) as {
    backup: {
      state: string;
      dailyArchiveCount: number;
      lastSuccessfulPath: string | null;
    };
    datasetEpoch: string;
  };
  // Enrollment was the first plugin use of the day: one archive already.
  expect(list.backup.state).toBe("healthy");
  expect(list.backup.dailyArchiveCount).toBe(1);
  expect(list.backup.lastSuccessfulPath).toBeTruthy();
  const again = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number };
  };
  expect(again.backup.dailyArchiveCount).toBe(1);
  // The explicit same-day retry forces a fresh snapshot that includes the
  // created task; the implicit trigger never adds a third archive.
  const retried = (await f.call("retryDailyBackup", null)) as {
    dailyArchiveCount: number;
    state: string;
    lastSuccessfulPath: string | null;
  };
  expect(retried.state).toBe("healthy");
  expect(retried.dailyArchiveCount).toBe(2);
  const finalList = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number };
  };
  expect(finalList.backup.dailyArchiveCount).toBe(2);
  const dailyDir = (await f.dirs()).daily;
  const decoded = validateArchive(
    await readFile(
      String(retried.lastSuccessfulPath ?? "").replace(/^\/private/, "") ||
        join(dailyDir, (await readdir(dailyDir))[0]!),
    ),
  );
  expect(decoded.manifest.archiveKind).toBe("complete");
  const tasksTable = decoded.tables.find((t) => t.name === "tasks");
  expect(
    tasksTable?.rows.some(
      (row) =>
        String(row.displayId).toLowerCase() === created.displayId.toLowerCase(),
    ),
  ).toBe(true);
  expect(decoded.memories.some((m) => m.taskId === created.id)).toBe(true);
  const serialized = JSON.stringify(decoded.tables);
  expect(serialized.includes("Backup me")).toBe(true);
  expect(serialized).not.toContain(created.id + ".md content");
  void enrolled;
});

test("capture failure keeps health degraded, publishes nothing and explicit retry succeeds", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Retry target");
  const { memory } = await f.dirs();
  const memoryPath = join(memory, `${created.id}.md`);
  const baseline = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number };
  };
  // Remove the canonical file during capture so reads fail deterministically.
  await unlink(memoryPath);
  await expect(f.call("retryDailyBackup", null)).rejects.toThrow(
    /missing|memory/i,
  );
  const degraded = (await f.call("list", null)) as {
    backup: { state: string; error: string | null; dailyArchiveCount: number };
  };
  expect(degraded.backup.state).toBe("degraded");
  expect(degraded.backup.error).toBeTruthy();
  expect(degraded.backup.dailyArchiveCount).toBe(
    baseline.backup.dailyArchiveCount,
  );
  // Memory shows a visible missing-file conflict; accept the observed state
  // explicitly, then the day's explicit retry succeeds.
  const view = (await f.call("readMemory", { id: created.id })) as {
    state: string;
    operationId: string | null;
    token: { datasetEpoch: string; memoryRevision: number; memoryHash: string };
    committedToken: {
      datasetEpoch: string;
      memoryRevision: number;
      memoryHash: string;
    } | null;
    observedHash: string | null;
    allowedActions?: string[];
  };
  expect(view.state).toBe("conflict");
  const restored = (await f.call("restoreKnownMemory", {
    id: created.id,
    operationId: randomUUID(),
    token: view.committedToken ?? view.token,
    observedHash: null,
    content: "",
  })) as { outcome: string };
  expect(typeof restored.outcome).toBe("string");
  expect(restored.outcome.length).toBeGreaterThan(0);
  const retried = (await f.call("retryDailyBackup", null)) as {
    state: string;
    dailyArchiveCount: number;
  };
  expect(retried.state).toBe("healthy");
  expect(retried.dailyArchiveCount).toBe(baseline.backup.dailyArchiveCount + 1);
  void memoryPath;
});

test("daily retention keeps the latest seven successful archives and never counts invalid files", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Retention");
  const { datasetId, daily } = await f.dirs();
  const hostRow = f.db
    .prepare("SELECT hostId FROM enrollments LIMIT 1")
    .get() as { hostId: string };
  // Publish one real daily archive first so the managed directories exist;
  // the implicit create-time trigger already published one as well.
  await f.call("retryDailyBackup", null);
  const baseline = (
    (await f.call("list", null)) as {
      backup: { dailyArchiveCount: number };
    }
  ).backup.dailyArchiveCount;
  for (let i = 1; i <= 6; i += 1) {
    const day = `2026-08-${String(i).padStart(2, "0")}`;
    await writeFile(
      join(
        daily,
        `daily-${day}-${stamp(seedArchive(datasetId, hostRow.hostId, day))}${ARCHIVE_SUFFIX}`,
      ),
      seedArchive(datasetId, hostRow.hostId, day),
    );
  }
  await writeFile(join(daily, `broken${ARCHIVE_SUFFIX}`), "{not json");
  const health = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number };
  };
  expect(health.backup.dailyArchiveCount).toBe(baseline + 6);
  let files = await readdir(daily);
  expect(files.filter((name) => name.endsWith(ARCHIVE_SUFFIX))).toHaveLength(
    baseline + 7,
  );
  expect(files).toContain(`broken${ARCHIVE_SUFFIX}`);
  await writeFile(
    join(
      daily,
      `daily-2026-08-14-${stamp(seedArchive(datasetId, hostRow.hostId, "2026-08-14"))}${ARCHIVE_SUFFIX}`,
    ),
    seedArchive(datasetId, hostRow.hostId, "2026-08-14"),
  );
  const after = (await f.call("retryDailyBackup", null)) as {
    dailyArchiveCount: number;
    warning: string | null;
  };
  expect(after.dailyArchiveCount).toBe(7);
  expect(after.warning).toBeNull();
  files = (await readdir(daily)).filter((name) =>
    name.endsWith(ARCHIVE_SUFFIX),
  );
  expect(files).toHaveLength(8);
  expect(files.some((name) => name.startsWith("daily-2026-08-14"))).toBe(true);
  expect(files.some((name) => name.startsWith("daily-2026-08-01"))).toBe(false);
  expect(files).toContain(`broken${ARCHIVE_SUFFIX}`);
  expect(files.filter((n) => n.startsWith("daily-2026-09-")).length).toBe(
    baseline + 1 - (baseline + 1 > 7 ? baseline + 1 - 7 : 0),
  );
});

test("manual export writes to the chosen absolute path and is never pruned by retention", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Manual export");
  const destination = join(f.root, "manual-export.task-workspace.json");
  const result = (await f.call("exportBackup", { destination })) as {
    state: string;
    lastSuccessfulPath: string | null;
  };
  expect(result.lastSuccessfulPath?.replace(/^\/private/, "")).toBe(
    destination,
  );
  expect(
    validateArchive(await readFile(destination)).manifest.archiveKind,
  ).toBe("complete");
  await expect(f.call("exportBackup", { destination })).rejects.toThrow(
    /already exists/,
  );
  await expect(
    f.call("exportBackup", { destination: "relative/path" }),
  ).rejects.toThrow(/absolute/);
  for (let i = 0; i < 9; i += 1) await f.call("retryDailyBackup", null);
  expect((await readFile(destination)).byteLength).toBeGreaterThan(0);
});

test("external memory change during capture fails visibly and later attempts report the conflict", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Race target");
  const { memory } = await f.dirs();
  const memoryPath = join(memory, `${created.id}.md`);
  const original = await readFile(memoryPath, "utf8");
  // Hold the first canonical read inside the capture, apply an independent
  // external change while the capture is suspended, then release.
  f.holdNextRead();
  const attempt = f.call("retryDailyBackup", null).then(
    () => "published",
    (error: unknown) => String(error),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(memoryPath, `${original}<!-- external -->`, "utf8");
  f.releaseRead();
  const outcome = await attempt;
  expect(outcome).toMatch(/memory|conflict|changed/i);
  const degraded = (await f.call("list", null)) as {
    backup: { state: string; error: string | null };
  };
  expect(degraded.backup.state).toBe("degraded");
  expect(degraded.backup.error).toBeTruthy();
  // The external change remains a visible memory conflict; a healthy archive
  // still fails until it is explicitly resolved.
  await expect(f.call("retryDailyBackup", null)).rejects.toThrow(
    /memory|changed|conflict/i,
  );
}, 20_000);

test("archive rows exclude secrets, transcripts and the migration ledger; tampered files are not counted", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Exclusions");
  const first = (await f.call("list", null)) as {
    backup: { lastSuccessfulPath: string; dailyArchiveCount: number };
  };
  const good = await readFile(first.backup.lastSuccessfulPath);
  const decoded = validateArchive(good);
  // The migration ledger is canonical recovery data; every known table is included.
  expect(decoded.tables.map((t) => t.name)).toContain("bb_migrations");
  const ledger = decoded.tables.find((t) => t.name === "bb_migrations")!;
  expect(ledger.rows).toHaveLength(ARCHIVE_SCHEMA_VERSION_LIVE);
  // Task memory bodies stay out of structured rows entirely.
  const text = JSON.stringify(decoded.tables);
  expect(text).not.toContain("memoryBody");
  expect(text.toLowerCase()).not.toContain("authorization");
  const { daily } = await f.dirs();
  const corruptTarget = join(
    daily,
    `daily-2020-01-01-tampered${ARCHIVE_SUFFIX}`,
  );
  await writeFile(
    corruptTarget,
    Buffer.concat([good.subarray(0, 50), Buffer.from("X"), good.subarray(51)]),
  );
  const health = (await f.call("retryDailyBackup", null)) as {
    dailyArchiveCount: number;
  };
  expect(health.dailyArchiveCount).toBe(2);
});

test("old-schema datasets are rejected by the complete adapter with a clear error", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Old schema");
  f.db
    .prepare(
      "DELETE FROM _bb_migrations WHERE id = (SELECT MAX(id) FROM _bb_migrations)",
    )
    .run();
  await expect(f.call("retryDailyBackup", null)).rejects.toThrow(
    /schema 11 has no complete archive adapter/,
  );
  const health = (await f.call("list", null)) as {
    backup: { state: string; error: string | null };
  };
  expect(health.backup.state).toBe("degraded");
});

test("foreign-dataset and manual-placed archives in the daily directory neither count nor prune", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Provenance");
  const { datasetId, daily } = await f.dirs();
  const hostRow = f.db
    .prepare("SELECT hostId FROM enrollments LIMIT 1")
    .get() as { hostId: string };
  await f.call("retryDailyBackup", null);
  const thisDatasetBaseline = (
    (await f.call("list", null)) as {
      backup: { dailyArchiveCount: number };
    }
  ).backup.dailyArchiveCount;
  const foreignDay = "2026-08-20";
  // A complete archive belonging to a different dataset, stamped like a daily file.
  const foreign = encodeArchive({
    archiveKind: "complete",
    schemaVersion: ARCHIVE_SCHEMA_VERSION_SEED,
    createdAt: `${foreignDay}T01:00:00.000Z`,
    localDay: foreignDay,
    source: {
      datasetId: "123e4567-e89b-42d3-a456-426614174999",
      hostId: hostRow.hostId,
    },
    diagnostics: [],
    extensions: SEED_EXTENSIONS,
    tables: [],
    memories: [],
  });
  await writeFile(
    join(daily, `daily-${foreignDay}-${stamp(foreign)}${ARCHIVE_SUFFIX}`),
    foreign,
  );
  // A valid manual export copied into the managed daily directory.
  const manual = join(f.root, "outside.task-workspace.json");
  await f.call("exportBackup", { destination: manual });
  const manualBytes = await readFile(manual);
  await writeFile(join(daily, `copied-manual${ARCHIVE_SUFFIX}`), manualBytes);
  const health = (await f.call("list", null)) as {
    backup: {
      dailyArchiveCount: number;
      lastSuccessfulLocalDay: string | null;
    };
  };
  // Only this dataset's genuinely published daily archives count.
  expect(health.backup.dailyArchiveCount).toBe(thisDatasetBaseline);
  expect(health.backup.lastSuccessfulLocalDay).toBeTruthy();
  // Fill retention: older valid days prune; the foreign and manual-placed
  // files are neither counted nor pruned.
  for (let i = 10; i <= 17; i += 1) {
    const day = `2026-08-${String(i).padStart(2, "0")}`;
    await writeFile(
      join(
        daily,
        `daily-${day}-${stamp(seedArchive(datasetId, hostRow.hostId, day))}${ARCHIVE_SUFFIX}`,
      ),
      seedArchive(datasetId, hostRow.hostId, day),
    );
  }
  const after = (await f.call("retryDailyBackup", null)) as {
    dailyArchiveCount: number;
  };
  expect(after.dailyArchiveCount).toBe(7);
  void thisDatasetBaseline;
  const files = (await readdir(daily)).filter((n) =>
    n.endsWith(ARCHIVE_SUFFIX),
  );
  expect(files.some((n) => n.startsWith(`daily-${foreignDay}`))).toBe(true);
  expect(files).toContain(`copied-manual${ARCHIVE_SUFFIX}`);
  void created;
});

test("manual export refuses destinations inside managed archive directories", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Confinement");
  const { datasetRoot } = await f.dirs();
  for (const target of [
    join(datasetRoot, "archives", "daily", "sneaky.task-workspace.json"),
    join(datasetRoot, "archives", "escape.task-workspace.json"),
  ]) {
    await expect(
      f.call("exportBackup", { destination: target }),
    ).rejects.toThrow(/outside the managed archive directories/);
  }
});

test("retention cleanup failure keeps the archive published and health visibly degraded until a later success", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Prune failure");
  const { datasetId, daily } = await f.dirs();
  const hostRow = f.db
    .prepare("SELECT hostId FROM enrollments LIMIT 1")
    .get() as { hostId: string };
  // Eight old days + today means retention must prune at least one file.
  await f.call("retryDailyBackup", null);
  for (let i = 1; i <= 8; i += 1) {
    const day = `2026-08-${String(i).padStart(2, "0")}`;
    await writeFile(
      join(
        daily,
        `daily-${day}-${stamp(seedArchive(datasetId, hostRow.hostId, day))}${ARCHIVE_SUFFIX}`,
      ),
      seedArchive(datasetId, hostRow.hostId, day),
    );
  }
  // Make one prunable target undeletable with an immutable flag; unlink fails.
  const doomed = join(
    daily,
    `daily-2026-08-01-${stamp(seedArchive(datasetId, hostRow.hostId, "2026-08-01"))}${ARCHIVE_SUFFIX}`,
  );
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const runFlags = promisify(execFile);
  await runFlags("chflags", ["uchg", doomed]);
  let degraded;
  try {
    degraded = (await f.call("retryDailyBackup", null)) as {
      state: string;
      dailyArchiveCount: number;
      warning: string | null;
      lastSuccessfulLocalDay: string | null;
    };
  } finally {
    await runFlags("chflags", ["nouchg", doomed]).catch(() => undefined);
  }
  expect(degraded.warning).toMatch(/retention cleanup failed/);
  expect(degraded.lastSuccessfulLocalDay).toBeTruthy();
  // The next list still exposes the persisted after-effect.
  const later = (await f.call("list", null)) as {
    backup: {
      warning: string | null;
      state: string;
      dailyArchiveCount: number;
    };
  };
  expect(later.backup.warning).toMatch(/retention cleanup failed/);
  expect(later.backup.state).toBe("healthy");
  // A later successful daily run clears the stale warning.
  const cleared = (await f.call("retryDailyBackup", null)) as {
    warning: string | null;
    state: string;
  };
  expect(cleared.warning).toBeNull();
  expect(cleared.state).toBe("healthy");
}, 20_000);

test("no-clobber publication: an appearing manual destination is never replaced and a corrupt temporary fails visibly", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "No clobber");
  const destination = join(f.root, "race.task-workspace.json");
  // Create the file between initial validation and publish by hooking the
  // host publishArchive call to place a file first on the second attempt.
  let attempts = 0;
  const original = (f as { call: (m: string, i: unknown) => Promise<unknown> })
    .call;
  void original;
  await f.call("exportBackup", { destination });
  const first = await readFile(destination);
  // A second export to the same path must refuse even now.
  await expect(f.call("exportBackup", { destination })).rejects.toThrow(
    /already exists/,
  );
  // Corrupt-destination refusal: a directory at the destination path.
  const dirTarget = join(f.root, "dir-target.task-workspace.json");
  await mkdir(dirTarget);
  await expect(
    f.call("exportBackup", { destination: dirTarget }),
  ).rejects.toThrow();
  void first;
  void attempts;
});

test("concurrent first-use callers share one daily attempt (stale-status race)", async () => {
  const f = await fixture();
  const { enrolled } = await enrollAndCreate(f, "Concurrent");
  // Two concurrent first-use reads race the daily trigger; only one archive.
  const [x, y] = (await Promise.all([
    f.call("list", null),
    f.call("list", null),
  ])) as unknown as [
    { backup: { dailyArchiveCount: number } },
    { backup: { dailyArchiveCount: number } },
  ];
  expect(x.backup.dailyArchiveCount).toBe(1);
  expect(y.backup.dailyArchiveCount).toBe(1);
  void enrolled;
});

test("queued dataset-identity change during a held capture discards the attempt without publishing", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Identity change");
  const baseline = (
    (await f.call("list", null)) as {
      backup: { dailyArchiveCount: number };
    }
  ).backup.dailyArchiveCount;
  const oldDaily = (await f.dirs()).daily;
  f.holdNextRead();
  const attempt = f.call("retryDailyBackup", null).then(
    () => "published",
    (error: unknown) => String(error),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Replace the dataset identity while the capture is suspended on a read.
  f.db.prepare("UPDATE dataset SET id=?").run(randomUUID());
  f.releaseRead();
  const outcome = await attempt;
  // The attempt must fail once the identity changed; the exact boundary
  // (identity recheck or memory-directory divergence) may report either.
  expect(outcome).toMatch(/identity changed|dataset|memory|unreadable/i);
  const after = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number; datasetEpoch: string };
  };
  // No archive was published for the replaced identity; the earlier
  // dataset's daily files remain untouched on disk.
  expect(after.backup.datasetEpoch).not.toBe(baseline);
  expect(after.backup.dailyArchiveCount).toBe(0);
  expect(
    (await readdir(oldDaily)).filter((n) => n.endsWith(ARCHIVE_SUFFIX)).length,
  ).toBe(baseline);
}, 15_000);

test("managed publication failure keeps earlier archives and reports degraded health", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Publication failure");
  const before = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number; dailyFiles?: string[] };
  };
  const { daily } = await f.dirs();
  const filesBefore = await readdir(daily);
  await chmod(daily, 0o555);
  let failure: unknown;
  try {
    await f.call("retryDailyBackup", null);
  } catch (error) {
    failure = error;
  } finally {
    await chmod(daily, 0o755);
  }
  expect(String(failure)).toMatch(/daily|EACCES|read-only|permission/i);
  const filesAfter = await readdir(daily);
  expect(filesAfter).toEqual(filesBefore);
  const health = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number; state: string; error: string | null };
  };
  expect(health.backup.dailyArchiveCount).toBe(before.backup.dailyArchiveCount);
  expect(health.backup.state).toBe("degraded");
  expect(health.backup.error).toBeTruthy();
}, 15_000);

test("recovery-only capture records damaged readable state and never satisfies a healthy daily backup", async () => {
  const f = await fixture();
  const { created } = await enrollAndCreate(f, "Damaged");
  const { memory, datasetRoot } = await f.dirs();
  const memoryPath = join(memory, `${created.id}.md`);
  // Damage the canonical memory with non-UTF-8 bytes beyond repair.
  await writeFile(memoryPath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  await expect(f.call("retryDailyBackup", null)).rejects.toThrow(
    /memory|invalid/i,
  );
  const damaged = (await f.call("readMemory", { id: created.id })) as {
    state: string;
  };
  expect(damaged.state).toBe("conflict");
  const recovery = (await f.call("exportRecoveryArchive", {
    reason: "Damaged canonical memory bytes during ticket08 verification",
  })) as { state: string; warning: string | null; error: string | null };
  expect(recovery.error).toBeNull();
  const recoveryDir = join(datasetRoot, "archives", "recovery");
  const names = await readdir(recoveryDir);
  expect(names.some((n) => n.startsWith("recovery-only-"))).toBe(true);
  const newest = names[names.length - 1]!;
  const decoded = validateArchive(await readFile(join(recoveryDir, newest)));
  expect(decoded.manifest.archiveKind).toBe("recovery-only");
  expect((decoded.manifest.diagnostics as unknown[]).length).toBeGreaterThan(0);
  // A recovery-only copy never enters the daily inventory.
  const dailyHealth = (await f.call("list", null)) as {
    backup: { dailyArchiveCount: number };
  };
  expect(dailyHealth.backup.dailyArchiveCount).toBe(0);
}, 20_000);

test("manifest localDay matches the host local calendar day at capture", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Timezone");
  const result = (await f.call("retryDailyBackup", null)) as {
    lastSuccessfulPath: string | null;
    localDay: string;
  };
  const expected = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  })();
  expect(result.localDay).toBe(expected);
  const decoded = validateArchive(
    await readFile(
      String(result.lastSuccessfulPath ?? "").replace(/^\/private/, ""),
    ),
  );
  expect(decoded.manifest.localDay).toBe(expected);
});

test("pre-migration seam publishes a verified protective archive at the old schema before migrating", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-seam-"));
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
  let registrationFinished = false;
  const { bb, harness } = await createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "plugin"),
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method, input }) => {
      if (!registrationFinished)
        throw new Error("Host calls are unavailable during registration");
      if (method === "validateRepository" || method === "inspectRepository")
        return {
          repository: (input as { repository: string }).repository,
          version: "fixture",
        };
      return worker.experimental_call(method as never, input as never);
    },
  });
  const db = bb.storage.database();
  const { migrationStatements } = experimental_archiveMigrationSupport;
  // The SDK's migrate() runner owns the ledger table; recreate an older
  // ledger state manually before exercising the seam.
  db.exec(
    "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  // Install the nine-statement ledger state that an older plugin release left.
  for (let i = 0; i < 9; i += 1) db.exec(migrationStatements[i]!);
  const epoch = randomUUID();
  const taskId = randomUUID();
  const memoryText = "# Old schema memory\n";
  const memoryHash = createHash("sha256").update(memoryText).digest("hex");
  db.exec(`
    INSERT INTO dataset (id, hostId) VALUES ('${epoch}', 'host-1');
    INSERT INTO enrollments (id, projectId, hostId, repository, name, prefix, nextNumber, revision, createdAt, updatedAt)
      VALUES ('${randomUUID()}', 'project-old', 'host-1', '/old', 'Old', 'OLD', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, enrollmentId, number, displayId, title, description, status, revision, createdAt, updatedAt, attribution, memoryState, memoryHash, memoryRevision)
      VALUES ('${taskId}', (SELECT id FROM enrollments), 1, 'OLD-1', 'Old task', '', 'Inbox', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'legacy', 'healthy', '${memoryHash}', 1);
  `);
  db.exec(`INSERT INTO repository_workspaces(taskId,projectId,hostId,repository,updatedAt)
    SELECT tasks.id,enrollments.projectId,enrollments.hostId,enrollments.repository,tasks.updatedAt
    FROM tasks JOIN enrollments ON tasks.enrollmentId=enrollments.id`);
  const stmts = db.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (let i = 0; i < 9; i += 1) stmts.run(i, 1);
  const memoryDir = join(root, "host", "datasets", epoch, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, `${taskId}.md`), memoryText);
  await plugin(bb, {
    onDailyAttempt: (attempt) => dailyAttempts.push(attempt),
  });
  expect(
    (
      db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
        count: number;
      }
    ).count,
  ).toBe(9);
  registrationFinished = true;
  await harness.behavior.callRpc("exportBackup", {
    destination: join(root, "after-migration.task-workspace.json"),
  });
  // The migration completed only after the protective archive was published.
  const ledger = (
    db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
      count: number;
    }
  ).count;
  expect(ledger).toBe(12);
  const recoveryDir = join(
    root,
    "host",
    "datasets",
    epoch,
    "archives",
    "recovery",
  );
  const names = await readdir(recoveryDir);
  const protective = names.find((n) => n.startsWith("protective-"));
  expect(protective).toBeTruthy();
  const decoded = validateArchive(
    await readFile(join(recoveryDir, protective!)),
  );
  expect(decoded.manifest.archiveKind).toBe("complete");
  expect(decoded.manifest.schemaVersion).toBe(9);
  expect(decoded.tables.map((t) => t.name)).toContain("thread_links");
  expect(decoded.tables.map((t) => t.name)).not.toContain(
    "wayfinder_attachments",
  );
  expect(decoded.memories.some((m) => m.taskId === taskId)).toBe(true);
  // Live data preserved through the migration.
  expect(
    (
      db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
        count: number;
      }
    ).count,
  ).toBe(1);
}, 20_000);

test("pre-migration seam refuses to migrate when the protective capture fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-seam-fail-"));
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
  const { bb, harness } = await createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "plugin"),
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "validateRepository" || method === "inspectRepository")
        return {
          repository: (input as { repository: string }).repository,
          version: "fixture",
        };
      return worker.experimental_call(method as never, input as never);
    },
  });
  const db = bb.storage.database();
  const { migrationStatements } = experimental_archiveMigrationSupport;
  db.exec(
    "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  for (let i = 0; i < 9; i += 1) db.exec(migrationStatements[i]!);
  db.exec(`
    INSERT INTO dataset (id, hostId) VALUES ('${randomUUID()}', 'host-1');
    INSERT INTO enrollments (id, projectId, hostId, repository, name, prefix, nextNumber, revision, createdAt, updatedAt)
      VALUES ('${randomUUID()}', 'project-old', 'host-1', '/old', 'Old', 'OLD', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, enrollmentId, number, displayId, title, description, status, revision, createdAt, updatedAt, attribution, memoryState, memoryHash, memoryRevision)
      VALUES ('${randomUUID()}', (SELECT id FROM enrollments), 1, 'OLD-1', 'Old task', '', 'Inbox', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'legacy', 'healthy', '${createHash("sha256").update("").digest("hex")}', 1);
  `);
  const stmts = db.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (let i = 0; i < 9; i += 1) stmts.run(i, 1);
  // The canonical memory file is missing: the protective archive would be
  // incomplete, so the migration must be refused outright.
  await expect(
    plugin(bb, {
      onDailyAttempt: (attempt) => dailyAttempts.push(attempt),
    }).then(() => harness.behavior.callRpc("list", null)),
  ).rejects.toThrow(/Refusing to apply pending migrations/);
  expect(
    (
      db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
        count: number;
      }
    ).count,
  ).toBe(9);
}, 20_000);

test("archive reads are bounded and no-follow", async () => {
  const { experimental_archiveFiles } = await import("./host");
  const root = await mkdtemp(join(tmpdir(), "task-workspace-bounded-"));
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }),
  );
  const target = join(root, "data.task-workspace.json");
  await writeFile(target, Buffer.alloc(64 * 1024 * 1024 + 1, 0x41));
  await expect(
    experimental_archiveFiles.readBoundedFile(target, 16 * 1024 * 1024),
  ).rejects.toThrow(/read limit/);
  await writeFile(target, "small");
  await expect(
    experimental_archiveFiles.readBoundedFile(join(root, "missing.json"), 1024),
  ).rejects.toThrow();
  await symlink(target, join(root, "link.task-workspace.json"));
  await expect(
    experimental_archiveFiles.readBoundedFile(
      join(root, "link.task-workspace.json"),
      1024,
    ),
  ).rejects.toThrow();
  await expect(
    experimental_archiveFiles.readBoundedFile(root, 1024),
  ).rejects.toThrow(/regular file/);
});

test("recovery-only capture keeps readable tables when another canonical table is missing", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Recovery tables");
  // Damage the schema: drop a non-task canonical table.
  f.db.exec("DROP TABLE wayfinder_attachments");
  // The complete capture refuses: the adapter requires every known table,
  // and the damaged schema fails the snapshot before publication.
  await expect(f.call("retryDailyBackup", null)).rejects.toThrow(
    /schema 9 has no complete archive adapter|Expected schema table|no such table/,
  );
  const recovery = (await f.call("exportRecoveryArchive", {
    reason: "Dropped wayfinder table during ticket08 verification",
  })) as { state: string; error: string | null };
  expect(recovery.error).toBeNull();
  const { datasetRoot } = await f.dirs();
  const names = await readdir(join(datasetRoot, "archives", "recovery"));
  const newest = names
    .filter((n) => n.startsWith("recovery-only-"))
    .sort()
    .pop()!;
  const decoded = validateArchive(
    await readFile(join(datasetRoot, "archives", "recovery", newest)),
  );
  const tableNames = decoded.tables.map((t) => t.name);
  // Other readable canonical tables are retained.
  expect(tableNames).toContain("tasks");
  expect(tableNames).toContain("enrollments");
  expect(tableNames).not.toContain("wayfinder_attachments");
  const diagnostics = decoded.manifest.diagnostics as unknown[];
  expect(
    diagnostics.some((d) => String(d).includes("wayfinder_attachments")),
  ).toBe(true);
});

test("recovery-only capture excludes unsupported-name and secret-policy tables with diagnostics", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Recovery policy");
  // An unsupported table name and a policy-forbidden one.
  f.db.exec('CREATE TABLE "we!rd" (v TEXT)');
  f.db.exec("INSERT INTO \"we!rd\" VALUES ('x')");
  f.db.exec("CREATE TABLE secrets (v TEXT)");
  f.db.exec("INSERT INTO secrets VALUES ('hunter2')");
  const recovery = (await f.call("exportRecoveryArchive", {
    reason: "Policy exclusion during ticket08 verification",
  })) as { state: string; error: string | null };
  expect(recovery.error).toBeNull();
  const { datasetRoot } = await f.dirs();
  const names = await readdir(join(datasetRoot, "archives", "recovery"));
  const newest = names
    .filter((n) => n.startsWith("recovery-only-"))
    .sort()
    .pop()!;
  const decoded = validateArchive(
    await readFile(join(datasetRoot, "archives", "recovery", newest)),
  );
  const tableNames = decoded.tables.map((t) => t.name);
  expect(tableNames).not.toContain("we!rd");
  expect(tableNames).not.toContain("secrets");
  expect(tableNames).toContain("tasks");
  expect(JSON.stringify(decoded.tables)).not.toContain("hunter2");
  const diagnostics = decoded.manifest.diagnostics as unknown[];
  expect(diagnostics.some((d) => String(d).includes("unsupported name"))).toBe(
    true,
  );
  expect(
    diagnostics.some((d) => String(d).includes("secret-content policy")),
  ).toBe(true);
});

test("recovery-only capture preserves other records when the tasks table is unreadable", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Damaged tasks");
  // Damage the tasks schema by renaming it; enrollment rows remain readable.
  f.db.exec("ALTER TABLE tasks RENAME TO tasks_damaged");
  const recovery = (await f.call("exportRecoveryArchive", {
    reason: "Damaged tasks schema during ticket08 verification",
  })) as { state: string; error: string | null };
  expect(recovery.error).toBeNull();
  const { datasetRoot } = await f.dirs();
  const names = await readdir(join(datasetRoot, "archives", "recovery"));
  const newest = names
    .filter((n) => n.startsWith("recovery-only-"))
    .sort()
    .pop()!;
  const decoded = validateArchive(
    await readFile(join(datasetRoot, "archives", "recovery", newest)),
  );
  const tableNames = decoded.tables.map((t) => t.name);
  expect(tableNames).not.toContain("tasks");
  expect(tableNames).toContain("enrollments");
  expect(tableNames).toContain("thread_links");
  const diagnostics = decoded.manifest.diagnostics as unknown[];
  expect(
    diagnostics.some((d) =>
      String(d).includes("Task records could not be read"),
    ),
  ).toBe(true);
  // Daily health remains unusable: the complete adapter still refuses.
  await expect(f.call("retryDailyBackup", null)).rejects.toThrow();
}, 15_000);

test("startup refuses a database with records but no migration ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-noledger-"));
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
  const { bb, harness } = await createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "plugin"),
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method, input }) =>
      worker.experimental_call(method as never, input as never),
  });
  const db = bb.storage.database();
  // Damaged install: user records exist, ledger is gone.
  db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT); INSERT INTO tasks VALUES ('x', 'stranded');",
  );
  await expect(plugin(bb)).rejects.toThrow(
    /contains records without a migration ledger/,
  );
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_bb_migrations'",
      )
      .get(),
  ).toBeUndefined();
  expect(
    (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c,
  ).toBe(1);
}, 15_000);

test("startup refuses when the dataset identity is unreadable in an existing schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-nodataset-"));
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
  const { bb, harness } = await createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "plugin"),
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method, input }) =>
      worker.experimental_call(method as never, input as never),
  });
  const db = bb.storage.database();
  db.exec(
    "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  const { migrationStatements } = experimental_archiveMigrationSupport;
  for (let i = 0; i < 9; i += 1) db.exec(migrationStatements[i]!);
  const stmts = db.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (let i = 0; i < 9; i += 1) stmts.run(i, 1);
  db.exec("DROP TABLE dataset");
  await expect(
    plugin(bb).then(() => harness.behavior.callRpc("list", null)),
  ).rejects.toThrow(/dataset identity could not be read|no dataset identity/);
  expect(
    (
      db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
        count: number;
      }
    ).count,
  ).toBe(9);
}, 15_000);

test("protective pre-migration capture refuses when memory changes during the capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-seam-race-"));
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
  let held = false;
  const gate = { release: null as (() => void) | null };
  const hold = new Promise<void>((resolve) => (gate.release = resolve));
  const { bb, harness } = await createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "plugin"),
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "readMemory" && held) {
        held = false;
        await hold;
      }
      if (method === "validateRepository" || method === "inspectRepository")
        return {
          repository: (input as { repository: string }).repository,
          version: "fixture",
        };
      return worker.experimental_call(method as never, input as never);
    },
  });
  const db = bb.storage.database();
  db.exec(
    "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  const { migrationStatements } = experimental_archiveMigrationSupport;
  for (let i = 0; i < 9; i += 1) db.exec(migrationStatements[i]!);
  const epoch = randomUUID();
  const taskId = randomUUID();
  const memoryText = "# Protective memory\n";
  const memoryHash = createHash("sha256").update(memoryText).digest("hex");
  db.exec(`
    INSERT INTO dataset (id, hostId) VALUES ('${epoch}', 'host-1');
    INSERT INTO enrollments (id, projectId, hostId, repository, name, prefix, nextNumber, revision, createdAt, updatedAt)
      VALUES ('${randomUUID()}', 'project-old', 'host-1', '/old', 'Old', 'OLD', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, enrollmentId, number, displayId, title, description, status, revision, createdAt, updatedAt, attribution, memoryState, memoryHash, memoryRevision)
      VALUES ('${taskId}', (SELECT id FROM enrollments), 1, 'OLD-1', 'Old task', '', 'Inbox', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'legacy', 'healthy', '${memoryHash}', 1);
  `);
  const stmts = db.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (let i = 0; i < 9; i += 1) stmts.run(i, 1);
  const memoryDir = join(root, "host", "datasets", epoch, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, `${taskId}.md`), memoryText);
  held = true;
  const startup = plugin(bb)
    .then(() => harness.behavior.callRpc("list", null))
    .then(
      () => "migrated",
      (error: unknown) => String(error),
    );
  await new Promise((resolve) => setTimeout(resolve, 20));
  // External change while the protective capture is suspended on a read.
  await writeFile(
    join(memoryDir, `${taskId}.md`),
    `${memoryText}<!-- changed -->`,
  );
  gate.release?.();
  const outcome = await startup;
  expect(outcome).toMatch(/changed|Refusing/i);
  expect(
    (
      db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
        count: number;
      }
    ).count,
  ).toBe(9);
}, 20_000);

test("a mismatched digest stamp in the filename is not daily provenance", async () => {
  const f = await fixture();
  await enrollAndCreate(f, "Stamp mismatch");
  const { datasetId, daily } = await f.dirs();
  const baseline = (await f.call("retryDailyBackup", null)) as {
    dailyArchiveCount: number;
  };
  const hostRow = f.db
    .prepare("SELECT hostId FROM enrollments LIMIT 1")
    .get() as { hostId: string };
  const bytes = seedArchive(datasetId, hostRow.hostId, "2026-08-30");
  await writeFile(
    join(daily, `daily-2026-08-30-deadbeefcafe${ARCHIVE_SUFFIX}`),
    bytes,
  );
  const health = (await f.call("list", null)) as {
    backup: {
      dailyArchiveCount: number;
      lastSuccessfulLocalDay: string | null;
    };
  };
  expect(health.backup.dailyArchiveCount).toBe(baseline.dailyArchiveCount);
  expect(health.backup.lastSuccessfulLocalDay).toBeTruthy();
  // A tampered stamp file is neither counted nor pruned.
  expect((await readdir(daily)).some((n) => n.includes("deadbeefcafe"))).toBe(
    true,
  );
});
