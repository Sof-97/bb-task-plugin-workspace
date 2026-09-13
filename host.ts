import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  open,
  realpath,
  lstat,
  rename,
  unlink,
  link,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostContract, hostSignals } from "./contract";
import { readWayfinderSource } from "./wayfinder-host";
import { validateArchive } from "./archive";
const exec = promisify(execFile);
const MEMORY_LIMIT = 1024 * 1024;
const ARCHIVE_SUFFIX = ".task-workspace.json";
const ARCHIVE_LIMIT_BYTES = 16 * 1024 * 1024;
const HEALTH_BYTES = 64 * 1024;

/**
 * Bounded no-follow descriptor read: opens with O_NOFOLLOW, refuses
 * non-regular files, and stops at limit+1 bytes so growth after stat cannot
 * bypass the declared resource bound.
 */
async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a regular file.`);
    if (stat.size > limit) throw new Error(`${path} exceeds the read limit.`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, limit + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.byteLength > limit)
      throw new Error(`${path} exceeds the read limit.`);
    return bytes;
  } finally {
    await file.close();
  }
}

type JsonObject = Record<string, unknown>;
type CommandError = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: string | number;
};

const bounded = (value: unknown) =>
  String(value ?? "")
    .trim()
    .slice(0, 4000);
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

type MemoryObservation =
  | {
      state: "present";
      content: string;
      bytesBase64: string;
      hash: string;
      size: number;
    }
  | { state: "missing" }
  | {
      state: "invalid";
      reason: "symlink" | "oversize" | "invalid-utf8" | "unsafe-path";
      message: string;
      observedHash: string | null;
    };

function digest(content: Uint8Array | string) {
  return createHash("sha256").update(content).digest("hex");
}

async function memoryDirectory(dataDir: string, dataset: string) {
  try {
    await realpath(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(dataDir));
    const parentHandle = await open(
      parent,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  }
  const root = await realpath(dataDir);
  let current = root;
  for (const component of ["datasets", dataset, "memory"]) {
    const parent = current;
    current = join(parent, component);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "Memory path contains a non-directory or symlink component.",
      );
    if ((await realpath(current)) !== current)
      throw new Error("Memory path escaped the plugin data directory.");
    if (created) {
      const parentHandle = await open(
        parent,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        await parentHandle.sync();
      } finally {
        await parentHandle.close();
      }
    }
  }
  return current;
}

const STAGING_MARKER_FILE = "restore-staging.json";

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Read the explicit restore-staging ownership marker for a dataset directory.
 * A directory without a well-formed marker that names this dataset is never a
 * staging artifact, so cleanup can never mistake an active or unrelated
 * memory-only root for its own staging directory.
 */
async function readStagingMarker(
  dataDir: string,
  dataset: string,
): Promise<{ target: string; token: string } | null> {
  let root: string;
  try {
    root = await realpath(dataDir);
  } catch {
    return null;
  }
  const target = join(root, "datasets", dataset);
  let stat;
  try {
    stat = await lstat(target);
  } catch {
    return null;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  if ((await realpath(target)) !== target) return null;
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(join(target, STAGING_MARKER_FILE), 8 * 1024);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      token?: unknown;
      dataset?: unknown;
    };
    if (
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      parsed.token.length > 200 ||
      parsed.dataset !== dataset
    )
      return null;
    return { target, token: parsed.token };
  } catch {
    return null;
  }
}

const MEMORY_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/;

/**
 * Confirm the staging directory still contains exactly the marker plus
 * canonical memory files, re-checking realpath so a swapped symlink cannot
 * redirect a later removal outside the plugin data directory.
 */
async function stagingInventory(
  target: string,
): Promise<{ memory: string[]; marker: string } | null> {
  if ((await realpath(target)) !== target) return null;
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    return null;
  }
  const marker = STAGING_MARKER_FILE;
  if (!entries.includes(marker)) return null;
  let memoryEntries: string[];
  const memory = join(target, "memory");
  try {
    const memoryStat = await lstat(memory);
    if (!memoryStat.isDirectory() || memoryStat.isSymbolicLink()) return null;
    if ((await realpath(memory)) !== memory) return null;
    memoryEntries = await readdir(memory);
  } catch {
    memoryEntries = [];
  }
  const allowedTop = new Set([marker, "memory"]);
  if (entries.some((name) => !allowedTop.has(name))) return null;
  for (const name of memoryEntries) {
    if (!MEMORY_FILE.test(name)) return null;
    const entryStat = await lstat(join(memory, name));
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) return null;
  }
  return { memory: memoryEntries, marker };
}

async function secureChildDirectory(parent: string, name: string) {
  const path = join(parent, name);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new Error(`Archive directory ${name} is unsafe.`);
  if (created) {
    const handle = await open(
      parent,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return path;
}

async function archiveDirectories(dataDir: string, dataset: string) {
  const memory = await memoryDirectory(dataDir, dataset);
  const datasetRoot = dirname(memory);
  const root = await secureChildDirectory(datasetRoot, "archives");
  const daily = await secureChildDirectory(root, "daily");
  const recovery = await secureChildDirectory(root, "recovery");
  return { root, daily, recovery };
}

const localDay = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

type StoredArchiveHealth = {
  lastAttemptAt: string | null;
  error: string | null;
  warning: string | null;
};

async function readStoredHealth(root: string): Promise<StoredArchiveHealth> {
  try {
    const parsed = JSON.parse(
      (await readBoundedFile(join(root, "health.json"), HEALTH_BYTES)).toString(
        "utf8",
      ),
    ) as unknown;
    const record = object(parsed);
    if (
      record &&
      (record.lastAttemptAt === null ||
        typeof record.lastAttemptAt === "string") &&
      (record.error === null || typeof record.error === "string") &&
      (record.warning === null || typeof record.warning === "string")
    )
      return {
        lastAttemptAt: record.lastAttemptAt as string | null,
        error: record.error as string | null,
        warning: record.warning as string | null,
      };
  } catch {
    // A missing or damaged advisory health file is reconstructed from archives.
  }
  return { lastAttemptAt: null, error: null, warning: null };
}

async function writeStoredHealth(root: string, health: StoredArchiveHealth) {
  const path = join(root, "health.json");
  const temporary = join(root, `.health.${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(health), "utf8");
  let staged = false;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    staged = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomic replacement of the advisory file; this directory is
    // plugin-managed and publication is serialized, so rename cannot clobber
    // a concurrent writer meaningfully and link's no-clobber would strand
    // the previous health state forever.
    await rename(temporary, path);
    staged = false;
    const directory = await open(
      root,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (staged) await unlink(temporary).catch(() => undefined);
  }
}

/** Managed daily archive filenames carry a validated publication stamp. */
const DAILY_NAME =
  /^daily-(\d{4}-\d{2}-\d{2})-([0-9a-f]{12})(?:\.\d{2})?\.task-workspace\.json$/;

type DailyArchiveEntry = {
  path: string;
  createdAt: string;
  localDay: string;
};

async function validDailyArchives(
  daily: string,
  expected: { datasetId: string; hostId: string | null } | null,
): Promise<DailyArchiveEntry[]> {
  const archives: DailyArchiveEntry[] = [];
  for (const name of await readdir(daily)) {
    if (!DAILY_NAME.test(name)) continue;
    const path = join(daily, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > ARCHIVE_LIMIT_BYTES) continue;
      const bytes = await readBoundedFile(path, ARCHIVE_LIMIT_BYTES);
      const validated = validateArchive(bytes);
      if (validated.manifest.archiveKind !== "complete") continue;
      const source = validated.manifest.source as {
        datasetId: string;
        hostId: string;
      };
      if (
        expected &&
        (source.datasetId !== expected.datasetId ||
          (expected.hostId !== null && source.hostId !== expected.hostId))
      )
        continue;
      // A file renamed into this directory from elsewhere is not daily
      // provenance: the filename stamp must match the manifest day exactly
      // and the embedded digest stamp must match the actual archive bytes.
      const stamp = DAILY_NAME.exec(name)!;
      if (String(validated.manifest.localDay) !== stamp[1]) continue;
      if (digest(bytes).slice(0, 12) !== stamp[2]) continue;
      archives.push({
        path,
        createdAt: String(validated.manifest.createdAt),
        localDay: String(validated.manifest.localDay),
      });
    } catch {
      // Invalid files are never counted as successes and never pruned automatically.
    }
  }
  return archives.sort(
    (left, right) =>
      right.localDay.localeCompare(left.localDay) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.path.localeCompare(left.path),
  );
}

async function archiveHealth(
  dataDir: string,
  dataset: string,
  expectedHostId: string | null = null,
) {
  const { root, daily } = await archiveDirectories(dataDir, dataset);
  const [stored, archives] = await Promise.all([
    readStoredHealth(root),
    validDailyArchives(daily, { datasetId: dataset, hostId: expectedHostId }),
  ]);
  const latest = archives[0] ?? null;
  return {
    state: stored.error
      ? ("degraded" as const)
      : latest
        ? ("healthy" as const)
        : ("not-yet-created" as const),
    localDay: localDay(new Date()),
    observedAt: new Date().toISOString(),
    lastAttemptAt: stored.lastAttemptAt,
    lastSuccessfulAt: latest?.createdAt ?? null,
    lastSuccessfulLocalDay: latest?.localDay ?? null,
    lastSuccessfulPath: latest?.path ?? null,
    dailyArchiveCount: archives.length,
    error: stored.error,
    // Publication after-effects stay visible until the next successful run
    // overwrites them, while a confirmed daily success keeps status healthy.
    warning: stored.warning,
  };
}

async function publishArchive(
  dataDir: string,
  input: {
    dataset: string;
    kind: "daily" | "manual" | "protective" | "recovery-only";
    archiveBase64: string;
    destination: string | null;
  },
) {
  const bytes = Buffer.from(input.archiveBase64, "base64");
  if (bytes.toString("base64") !== input.archiveBase64)
    throw new Error("Archive payload is not canonical base64.");
  const intendedDigest = digest(bytes);
  const validated = validateArchive(bytes);
  const expectedKind =
    input.kind === "recovery-only" ? "recovery-only" : "complete";
  if (validated.manifest.archiveKind !== expectedKind)
    throw new Error("Archive kind does not match its publication route.");
  if (
    (validated.manifest.source as { datasetId: string }).datasetId !==
    input.dataset
  )
    throw new Error("Archive dataset identity does not match its destination.");
  const directories = await archiveDirectories(dataDir, input.dataset);
  const created = String(validated.manifest.createdAt).replace(/[:.]/g, "-");
  let destination: string;
  if (input.kind === "manual") {
    if (!input.destination || !isAbsolute(input.destination))
      throw new Error("Manual export destination must be an absolute path.");
    if (!input.destination.endsWith(ARCHIVE_SUFFIX))
      throw new Error(`Manual export must end in ${ARCHIVE_SUFFIX}.`);
    const parent = await realpath(dirname(input.destination));
    destination = join(parent, basename(input.destination));
    // Manual exports must stay outside the managed archive inventory so
    // retention never prunes a human-chosen copy.
    for (const managed of [
      directories.root,
      directories.daily,
      directories.recovery,
    ]) {
      const fromManaged = relative(managed, destination);
      if (
        fromManaged === "" ||
        (!fromManaged.startsWith("..") && !isAbsolute(fromManaged))
      )
        throw new Error(
          "Manual export destination must be outside the managed archive directories.",
        );
    }
  } else {
    if (input.destination !== null)
      throw new Error("Managed archive destinations cannot be overridden.");
    const directory =
      input.kind === "daily" ? directories.daily : directories.recovery;
    const prefix =
      input.kind === "daily" ? String(validated.manifest.localDay) : created;
    const base = `${input.kind}-${prefix}-${intendedDigest.slice(0, 12)}`;
    destination = join(directory, `${base}${ARCHIVE_SUFFIX}`);
    let attempt = 1;
    for (;;) {
      try {
        await lstat(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      attempt += 1;
      destination = join(
        directory,
        `${base}.${String(attempt).padStart(2, "0")}${ARCHIVE_SUFFIX}`,
      );
      if (attempt > 99) throw new Error("No unique managed archive name.");
    }
  }
  if (input.kind === "manual") {
    try {
      await lstat(destination);
      throw new Error("Archive destination already exists; choose a new path.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Revalidate the resolved parent immediately before writing so a swap
  // between planning and publication cannot redirect the archive.
  const parent = await realpath(dirname(destination));
  if (input.kind === "manual") {
    const resolved = join(parent, basename(destination));
    if (resolved !== destination)
      throw new Error("Manual export destination changed during preparation.");
  }
  const temporary = join(
    parent,
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  let staged = false;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    staged = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Independent reopen must reproduce the exact intended bytes, not merely
    // any syntactically valid archive.
    const reopened = await readBoundedFile(temporary, ARCHIVE_LIMIT_BYTES);
    if (
      reopened.byteLength !== bytes.byteLength ||
      digest(reopened) !== intendedDigest
    )
      throw new Error(
        "Temporary archive verification failed; nothing was published.",
      );
    validateArchive(reopened);
    if (input.kind === "manual") {
      // No-clobber publication: an existing destination is never replaced.
      let existing = null as unknown;
      try {
        existing = await lstat(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing)
        throw new Error(
          "Archive destination already exists; choose a new path.",
        );
    }
    // No-clobber publication via link; the staging name is then removed so
    // only the published destination remains.
    await link(temporary, destination);
    staged = false;
    await unlink(temporary).catch(() => undefined);
    const directory = await open(
      parent,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (staged) await unlink(temporary).catch(() => undefined);
  }
  let warning: string | null = null;
  if (input.kind === "daily") {
    try {
      const daily = await validDailyArchives(directories.daily, {
        datasetId: input.dataset,
        hostId: null,
      });
      for (const old of daily.slice(7)) await unlink(old.path);
      if (daily.length > 7) {
        const directory = await open(
          directories.daily,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      warning = `Archive was published, but retention cleanup failed: ${bounded(error instanceof Error ? error.message : error)}`;
    }
  }
  let healthWriteError: string | null = null;
  try {
    await writeStoredHealth(directories.root, {
      lastAttemptAt: new Date().toISOString(),
      error: null,
      warning,
    });
  } catch (error) {
    // The archive is published and verified; the stale advisory health file
    // must not hide the publication, but the after-effect stays visible.
    healthWriteError = null;
    warning =
      warning ??
      `Archive was published, but recording health failed: ${bounded(error instanceof Error ? error.message : error)}`;
  }
  void healthWriteError;
  const health = await archiveHealth(dataDir, input.dataset);
  const withPath = { ...health, publishedPath: destination };
  // A manual export reports its own destination without being counted as the
  // day's automatic backup or participating in daily retention.
  if (input.kind === "manual")
    return { ...withPath, lastSuccessfulPath: destination };
  // Persisted after-effects must remain visible on subsequent reads.
  if (warning && !health.warning) return { ...withPath, warning };
  return withPath;
}

async function readCanonical(
  path: string,
  hooks: { afterStat?: () => Promise<void> | void } = {},
): Promise<MemoryObservation> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    if (code === "ELOOP")
      return {
        state: "invalid",
        reason: "symlink",
        message: "Canonical memory is a symlink and was not followed.",
        observedHash: null,
      };
    return {
      state: "invalid",
      reason: "unsafe-path",
      message: bounded(error instanceof Error ? error.message : error),
      observedHash: null,
    };
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      return {
        state: "invalid",
        reason: "unsafe-path",
        message: "Canonical memory is not a regular file.",
        observedHash: null,
      };
    if (stat.size > MEMORY_LIMIT)
      return {
        state: "invalid",
        reason: "oversize",
        message: `Canonical memory exceeds the ${MEMORY_LIMIT} byte limit.`,
        observedHash: null,
      };
    await hooks.afterStat?.();
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MEMORY_LIMIT) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MEMORY_LIMIT + 1 - total),
      );
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.byteLength > MEMORY_LIMIT)
      return {
        state: "invalid",
        reason: "oversize",
        message: `Canonical memory exceeds the ${MEMORY_LIMIT} byte limit.`,
        observedHash: null,
      };
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      return {
        state: "invalid",
        reason: "invalid-utf8",
        message:
          "Canonical memory is not valid UTF-8 and was preserved without decoding.",
        observedHash: digest(bytes),
      };
    }
    return {
      state: "present",
      content,
      bytesBase64: bytes.toString("base64"),
      hash: digest(bytes),
      size: bytes.byteLength,
    };
  } finally {
    await file.close();
  }
}

type ReplacementHooks = {
  afterExpectedHashCheck?: () => Promise<void> | void;
  beforeDirectorySync?: () => Promise<void> | void;
  afterRename?: () => Promise<void> | void;
};

async function initializeMemoryFile(
  dataDir: string,
  dataset: string,
  taskId: string,
) {
  const directory = await memoryDirectory(dataDir, dataset);
  const path = join(directory, `${taskId}.md`);
  try {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const dir = await open(directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const result = await readCanonical(path);
  if (result.state === "missing")
    throw new Error(
      "Memory initialization completed without a canonical file.",
    );
  return result;
}

async function replaceMemoryFile(
  dataDir: string,
  input: {
    dataset: string;
    taskId: string;
    operationId: string;
    expectedHash: string | null;
    content: string;
  },
  hooks: ReplacementHooks = {},
) {
  const directory = await memoryDirectory(dataDir, input.dataset);
  const directoryStat = await lstat(directory);
  const canonical = join(directory, `${input.taskId}.md`);
  const staging = join(
    directory,
    `.${input.taskId}.${input.operationId}.stage`,
  );
  const bytes = Buffer.from(input.content, "utf8");
  if (bytes.byteLength > MEMORY_LIMIT)
    throw new Error(`Memory exceeds the ${MEMORY_LIMIT} byte limit.`);
  let staged = false;
  try {
    const file = await open(
      staging,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    staged = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if ((await memoryDirectory(dataDir, input.dataset)) !== directory)
      throw new Error("Memory directory identity changed before replacement.");
    const beforeCheck = await lstat(directory);
    if (
      beforeCheck.dev !== directoryStat.dev ||
      beforeCheck.ino !== directoryStat.ino
    )
      throw new Error("Memory directory identity changed before replacement.");
    const current = await readCanonical(canonical);
    const matches =
      input.expectedHash === null
        ? current.state === "missing"
        : (current.state === "present" &&
            current.hash === input.expectedHash) ||
          (current.state === "invalid" &&
            current.observedHash === input.expectedHash);
    if (!matches)
      throw new Error(
        `Memory replacement precondition failed; canonical content was preserved (${current.state}).`,
      );
    await hooks.afterExpectedHashCheck?.();
    if ((await memoryDirectory(dataDir, input.dataset)) !== directory)
      throw new Error("Memory directory identity changed before rename.");
    const beforeRename = await lstat(directory);
    if (
      beforeRename.dev !== directoryStat.dev ||
      beforeRename.ino !== directoryStat.ino
    )
      throw new Error("Memory directory identity changed before rename.");
    await rename(staging, canonical);
    staged = false;
    await hooks.beforeDirectorySync?.();
    const dir = await open(directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    await hooks.afterRename?.();
    const verified = await readCanonical(canonical);
    const intendedHash = digest(bytes);
    if (verified.state !== "present" || verified.hash !== intendedHash)
      throw new Error(
        "Canonical memory did not match intended bytes after replacement.",
      );
    return { hash: verified.hash, size: verified.size };
  } finally {
    if (staged) {
      try {
        const confined = await memoryDirectory(dataDir, input.dataset);
        const confinedStat = await lstat(confined);
        const identityChanged =
          confined !== directory ||
          confinedStat.dev !== directoryStat.dev ||
          confinedStat.ino !== directoryStat.ino;
        if (!identityChanged) {
          const stat = await lstat(staging);
          if (stat.isFile() || stat.isSymbolicLink()) await unlink(staging);
        }
      } catch {
        // If confinement cannot be re-established, leave staging for recovery.
      }
    }
  }
}

async function confirmMemoryDurable(
  dataDir: string,
  dataset: string,
  taskId: string,
  expectedHash: string,
) {
  const directory = await memoryDirectory(dataDir, dataset);
  const canonical = join(directory, `${taskId}.md`);
  const file = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new Error("Canonical memory is not a regular file.");
    await file.sync();
  } finally {
    await file.close();
  }
  const dir = await open(directory, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  const verified = await readCanonical(canonical);
  if (verified.state !== "present" || verified.hash !== expectedHash)
    throw new Error(
      "Canonical memory changed while confirming its durability barrier.",
    );
  return { hash: verified.hash, size: verified.size };
}

function parseJson(stdout: string, command: string, allowEmpty = false) {
  if (!stdout.trim()) {
    if (allowEmpty) return null;
    throw new Error(`${command} returned no JSON output.`);
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${command} returned unrecognized JSON.`);
  }
}

function commandFailure(command: string, error: CommandError): Error {
  if (error.code === "ENOENT")
    return new Error(
      `${command} is unavailable on the selected host. Install the tool and retry; no setup or mutation was run.`,
    );
  if (error.code === "EACCES" || error.code === "EPERM")
    return new Error(
      `Permission denied while running ${command} on the selected host. Correct host permissions and retry.`,
    );
  const stdout = bounded(error.stdout);
  const stderr = bounded(error.stderr);
  let structured: JsonObject | null = null;
  try {
    structured = object(stdout ? JSON.parse(stdout) : null);
  } catch {
    // Plain stdout is retained below beside stderr.
  }
  if (structured?.error === "setup_required") {
    const message = bounded(structured.message);
    const hint = bounded(structured.hint);
    if (/unable to open database file/i.test(message))
      return new Error(
        `GitButler reported setup_required but could not open its database: ${message}.${stderr ? ` stderr: ${stderr}.` : ""}${hint ? ` ${hint}` : ""} This can be a permission or storage failure, so absent setup was not assumed and no setup was run.`,
      );
    return new Error(
      `GitButler reports that setup is required for this repository${message ? `: ${message}` : "."}${hint ? ` ${hint}` : ""} No setup was run.`,
    );
  }
  const details = [stderr, stdout].filter(Boolean).join(" | ");
  return new Error(
    `${command} failed${error.code !== undefined ? ` (exit ${String(error.code)})` : ""}${details ? `: ${details}` : "."}`,
  );
}

async function run(
  file: string,
  args: string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    timeout: number;
    maxBuffer: number;
  },
) {
  try {
    const result = await exec(file, args, options);
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    throw commandFailure(file, error as CommandError);
  }
}

async function mainRepository(repository: string, signal: AbortSignal) {
  const root = await realpath(repository).catch((error) => {
    throw new Error(
      `Selected repository cannot be resolved: ${bounded(
        error instanceof Error ? error.message : error,
      )}`,
    );
  });
  const options = {
    cwd: root,
    signal,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  };
  const git = await run(
    "git",
    ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
    options,
  );
  const [top, gitDir, commonDir] = git.stdout.trim().split("\n");
  if (!top || !gitDir || !commonDir)
    throw new Error("Git returned an incomplete repository identity.");
  const absolute = (value: string) =>
    isAbsolute(value) ? value : resolve(root, value);
  const [canonicalTop, canonicalGit, canonicalCommon] = await Promise.all([
    realpath(top),
    realpath(absolute(gitDir)),
    realpath(absolute(commonDir)),
  ]);
  if (canonicalTop !== root || canonicalGit !== canonicalCommon)
    throw new Error(
      "Select the main repository, not a subdirectory or linked worktree.",
    );
  return { root, options };
}

async function validateBranchName(
  branchName: string,
  options: Parameters<typeof run>[2],
) {
  await run("git", ["check-ref-format", "--branch", branchName], options);
}

function branchInventory(statusValue: unknown, listValue: unknown) {
  const status = object(statusValue);
  const list = object(listValue);
  if (!status || !Array.isArray(status.stacks))
    throw new Error("GitButler status returned an unrecognized shape.");
  if (
    !list ||
    !Array.isArray(list.appliedStacks) ||
    !Array.isArray(list.branches)
  )
    throw new Error("GitButler branch list returned an unrecognized shape.");
  const branchStatuses = new Map<string, string>();
  for (const stackValue of status.stacks) {
    const stack = object(stackValue);
    if (!stack || !Array.isArray(stack.branches)) continue;
    for (const branchValue of stack.branches) {
      const branch = object(branchValue);
      if (
        typeof branch?.name === "string" &&
        typeof branch.branchStatus === "string"
      )
        branchStatuses.set(branch.name, branch.branchStatus);
    }
  }
  const appliedStacks = list.appliedStacks.map((stackValue) => {
    const stack = object(stackValue);
    if (!stack || !Array.isArray(stack.heads))
      throw new Error("GitButler branch stack returned an unrecognized shape.");
    return stack.heads.map((headValue) => {
      const head = object(headValue);
      if (typeof head?.name !== "string")
        throw new Error(
          "GitButler branch head returned an unrecognized shape.",
        );
      return head.name;
    });
  });
  const branches = list.branches.map((branchValue) => {
    const branch = object(branchValue);
    if (typeof branch?.name !== "string")
      throw new Error("GitButler local branch returned an unrecognized shape.");
    return {
      name: branch.name,
      // GitButler 0.22.3 reports landed applied branches as `integrated` in status.
      merged: branchStatuses.get(branch.name) === "integrated",
    };
  });
  for (const names of appliedStacks)
    for (const name of names)
      if (!branches.some((branch) => branch.name === name))
        branches.push({
          name,
          merged: branchStatuses.get(name) === "integrated",
        });
  return { appliedStacks, branches };
}

function parsePorcelain(stdout: string) {
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  let changeCount = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    changeCount += 1;
    const path = entry.slice(3);
    if (path) paths.push(path);
    if (
      entry[0] === "R" ||
      entry[1] === "R" ||
      entry[0] === "C" ||
      entry[1] === "C"
    )
      index += 1;
  }
  return {
    hasChanges: changeCount > 0,
    changeCount,
    paths: paths.slice(0, 200),
  };
}

function mutationPreconditions(
  inventory: Awaited<ReturnType<typeof inspect>>,
  action: "create-independent" | "create-stacked" | "restack-existing",
  branchName: string,
  parentBranchName: string | null,
) {
  if (branchName === parentBranchName)
    throw new Error("A task branch cannot be stacked above itself.");
  const branch = inventory.branches.find((item) => item.name === branchName);
  const branchStack = inventory.appliedStacks.find((names) =>
    names.includes(branchName),
  );
  const parent = parentBranchName
    ? inventory.branches.find((item) => item.name === parentBranchName)
    : null;
  const parentStack = parentBranchName
    ? inventory.appliedStacks.find((names) => names.includes(parentBranchName))
    : null;
  if (action.startsWith("create-") && branch)
    throw new Error(
      `Branch ${branchName} already exists. Use explicit association instead of recreating it.`,
    );
  if (action === "create-independent" && parentBranchName)
    throw new Error("Independent branch creation cannot name a prerequisite.");
  if (action !== "create-independent") {
    if (!parentBranchName)
      throw new Error(
        "Stacked branch preparation requires an exact prerequisite branch name.",
      );
    if (!parent)
      throw new Error(`Prerequisite branch ${parentBranchName} is missing.`);
    if (parent.merged)
      throw new Error(
        `Prerequisite branch ${parentBranchName} is integrated upstream.`,
      );
    if (!parentStack)
      throw new Error(
        `Prerequisite branch ${parentBranchName} is unapplied. Apply it deliberately in GitButler first.`,
      );
  }
  if (action === "restack-existing") {
    if (!branch) throw new Error(`Branch ${branchName} is missing.`);
    if (branch.merged)
      throw new Error(`Branch ${branchName} is integrated upstream.`);
    if (!branchStack)
      throw new Error(
        `Branch ${branchName} is unapplied. Apply it deliberately in GitButler first.`,
      );
  }
}

function verifyMutationPlacement(
  inventory: Awaited<ReturnType<typeof inspect>>,
  action: "create-independent" | "create-stacked" | "restack-existing",
  branchName: string,
  parentBranchName: string | null,
) {
  const stack = inventory.appliedStacks.find((names) =>
    names.includes(branchName),
  );
  if (!stack)
    throw new Error(
      `GitButler mutation returned but ${branchName} is not applied. Preserve the branch and correct the resulting state explicitly.`,
    );
  const childIndex = stack.indexOf(branchName);
  const valid =
    action === "create-independent"
      ? childIndex === stack.length - 1
      : parentBranchName !== null &&
        stack.indexOf(parentBranchName) === childIndex + 1;
  if (!valid)
    throw new Error(
      `GitButler mutation completed but fresh state does not show the requested placement for ${branchName}. No branch identity was persisted; inspect and correct the recoverable repository state.`,
    );
}

async function inspect(repository: string, signal: AbortSignal) {
  const { root, options } = await mainRepository(repository, signal);
  const [status, list, version, dirty] = await Promise.all([
    run("but", ["-C", root, "status", "--json"], options),
    run(
      "but",
      [
        "-C",
        root,
        "branch",
        "list",
        "--all",
        "--empty",
        "--local",
        "--no-check",
        "--json",
      ],
      options,
    ),
    run("but", ["--version"], options),
    run(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
      options,
    ),
  ]);
  return {
    repository: root,
    version: version.stdout.trim(),
    ...branchInventory(
      parseJson(status.stdout, "but status"),
      parseJson(list.stdout, "but branch list"),
    ),
    combinedWorkingCopy: parsePorcelain(dirty.stdout),
  };
}

let mutationTail: Promise<void> = Promise.resolve();
const wayfinderWatches = new Map<string, { dispose(): Promise<void> }>();
function serialize<T>(operation: () => Promise<T>) {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export const experimental_hostParsing = {
  parseJson,
  commandFailure,
  branchInventory,
  parsePorcelain,
};
export const experimental_archiveFiles = { readBoundedFile };

export const experimental_memoryFiles = {
  memoryDirectory,
  readCanonical,
  initializeMemoryFile,
  replaceMemoryFile,
  confirmMemoryDurable,
  digest,
  limit: MEMORY_LIMIT,
};
export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async validateRepository({ repository }, ctx) {
      const result = await inspect(repository, ctx.signal);
      return { repository: result.repository, version: result.version };
    },
    async readMemory({ dataset, taskId }, ctx) {
      let directory: string;
      try {
        directory = await memoryDirectory(
          ctx.experimental_paths.dataDir,
          dataset,
        );
      } catch (error) {
        return {
          state: "invalid" as const,
          reason: "unsafe-path" as const,
          message: bounded(error instanceof Error ? error.message : error),
          observedHash: null,
        };
      }
      return readCanonical(join(directory, `${taskId}.md`));
    },
    initializeMemory: ({ dataset, taskId }, ctx) =>
      initializeMemoryFile(ctx.experimental_paths.dataDir, dataset, taskId),
    replaceMemory: (input, ctx) =>
      replaceMemoryFile(ctx.experimental_paths.dataDir, input),
    confirmMemoryDurable: ({ dataset, taskId, expectedHash }, ctx) =>
      confirmMemoryDurable(
        ctx.experimental_paths.dataDir,
        dataset,
        taskId,
        expectedHash,
      ),
    inspectRepository: ({ repository }, ctx) => inspect(repository, ctx.signal),
    mutateBranch: ({ repository, action, branchName, parentBranchName }, ctx) =>
      serialize(async () => {
        const before = await inspect(repository, ctx.signal);
        const options = {
          cwd: before.repository,
          signal: ctx.signal,
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
        };
        await validateBranchName(branchName, options);
        if (parentBranchName)
          await validateBranchName(parentBranchName, options);
        mutationPreconditions(before, action, branchName, parentBranchName);
        const args = ["-C", before.repository];
        if (action === "restack-existing") {
          args.push("move", branchName, "--above", parentBranchName!, "--json");
        } else {
          args.push("branch", "new", branchName);
          if (action === "create-stacked")
            args.push("--above", parentBranchName!);
          args.push("--json");
        }
        const mutation = await run("but", args, options);
        // 0.22.3 emits direct `{branch}`, wrapped `{result,status}`, and valid
        // empty output for different mutations. Syntax alone is never success:
        // the fresh inventory below is authoritative.
        parseJson(mutation.stdout, "GitButler mutation", true);
        const after = await inspect(before.repository, ctx.signal);
        verifyMutationPlacement(after, action, branchName, parentBranchName);
        return after;
      }),
    readWayfinderSource: (input) => readWayfinderSource(input),
    startWayfinderWatch: ({ watchId, repository, watchRoot }, ctx) =>
      serialize(async () => {
        const canonicalRepository = await realpath(repository);
        const canonicalRoot = await realpath(watchRoot);
        const fromRepository = relative(canonicalRepository, canonicalRoot);
        if (
          fromRepository === ".." ||
          fromRepository.startsWith("../") ||
          isAbsolute(fromRepository)
        )
          throw new Error(
            "Wayfinder watch root escapes the enrolled repository.",
          );
        await wayfinderWatches.get(watchId)?.dispose();
        const subscription = await ctx.experimental_watch(
          {
            rootPath: canonicalRoot,
            debounceMs: 100,
            maxWaitMs: 500,
          },
          async (event) => {
            await ctx.experimental_emitSignal("wayfinderChanged", {
              watchId,
              kind: event.kind,
              message: event.kind === "watch-error" ? event.message : null,
            });
          },
        );
        wayfinderWatches.set(watchId, subscription);
        return { watching: true as const };
      }),
    stopWayfinderWatch: ({ watchId }) =>
      serialize(async () => {
        const subscription = wayfinderWatches.get(watchId);
        wayfinderWatches.delete(watchId);
        await subscription?.dispose();
        return { stopped: true as const };
      }),
    archiveStatus: ({ dataset, hostId }, ctx) =>
      archiveHealth(ctx.experimental_paths.dataDir, dataset, hostId),
    readArchiveCandidate: async ({ path }) => {
      if (!isAbsolute(path)) throw new Error("Archive path must be absolute.");
      const bytes = await readBoundedFile(path, ARCHIVE_LIMIT_BYTES);
      return {
        bytesBase64: bytes.toString("base64"),
        size: bytes.byteLength,
        sha256: digest(bytes),
      };
    },
    beginStagedDataset: async ({ dataset, token }, ctx) => {
      const dataDir = ctx.experimental_paths.dataDir;
      const canonicalRoot = await realpath(dataDir);
      const datasetsRoot = await secureChildDirectory(
        canonicalRoot,
        "datasets",
      );
      const target = join(datasetsRoot, dataset);
      let exists = false;
      try {
        const stat = await lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Staging dataset path is not a safe directory.");
        if ((await realpath(target)) !== target)
          throw new Error(
            "Staging dataset path escaped the plugin data directory.",
          );
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (exists) {
        const entries = await readdir(target);
        if (entries.length > 0)
          throw new Error(
            "A dataset directory already exists for this restore epoch; refusing to reuse it.",
          );
      } else {
        await mkdir(target, { mode: 0o700 });
        await syncDirectory(datasetsRoot);
      }
      if ((await realpath(target)) !== target)
        throw new Error("Staging dataset path changed during creation.");
      const marker = Buffer.from(JSON.stringify({ token, dataset }), "utf8");
      let file;
      try {
        file = await open(
          join(target, STAGING_MARKER_FILE),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        throw new Error(
          "Staging marker could not be created exclusively; another restore may own this epoch.",
        );
      }
      try {
        await file.writeFile(marker);
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(target);
      return { created: true as const };
    },
    stageRestoredMemory: async (
      { dataset, token, taskId, bytesBase64, expectedHash },
      ctx,
    ) => {
      const bytes = Buffer.from(bytesBase64, "base64");
      if (bytes.toString("base64") !== bytesBase64)
        throw new Error("Staged memory is not canonical base64.");
      if (bytes.byteLength > MEMORY_LIMIT)
        throw new Error(`Memory exceeds the ${MEMORY_LIMIT} byte limit.`);
      if (digest(bytes) !== expectedHash)
        throw new Error(
          "Staged memory bytes do not match their archived hash; staging refused.",
        );
      const dataDir = ctx.experimental_paths.dataDir;
      const marker = await readStagingMarker(dataDir, dataset);
      if (!marker || marker.token !== token)
        throw new Error(
          "This restore no longer owns the staging directory; staging refused.",
        );
      const directory = await memoryDirectory(dataDir, dataset);
      if ((await realpath(dirname(directory))) !== marker.target)
        throw new Error(
          "Staging memory directory does not belong to the owned staging root.",
        );
      const canonical = join(directory, `${taskId}.md`);
      const file = await open(
        canonical,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(directory);
      // Independent verification: reopen through the canonical bounded reader
      // and compare the observed hash against the archived expectation.
      const verified = await readCanonical(canonical);
      if (verified.state !== "present" || verified.hash !== expectedHash)
        throw new Error(
          "Staged memory failed verification after writing; staging refused.",
        );
      return { hash: verified.hash, size: verified.size };
    },
    verifyStagedDataset: async ({ dataset, token, memories }, ctx) => {
      const dataDir = ctx.experimental_paths.dataDir;
      const marker = await readStagingMarker(dataDir, dataset);
      if (!marker || marker.token !== token)
        throw new Error(
          "This restore no longer owns the staging directory; verification refused.",
        );
      const inventory = await stagingInventory(marker.target);
      if (!inventory)
        throw new Error(
          "Staging directory is not a coherent owned staging dataset.",
        );
      const expected = [...memories].sort((left, right) =>
        left.taskId.localeCompare(right.taskId),
      );
      const actual = [...inventory.memory].sort();
      if (expected.length !== actual.length)
        throw new Error(
          `Staged memory inventory has ${actual.length} files but ${expected.length} were expected.`,
        );
      for (let index = 0; index < expected.length; index += 1) {
        const wanted = expected[index]!;
        if (actual[index] !== `${wanted.taskId}.md`)
          throw new Error(
            "Staged memory inventory does not match the archived task set.",
          );
        const observed = await readCanonical(
          join(marker.target, "memory", actual[index]!),
        );
        if (
          observed.state !== "present" ||
          observed.hash !== wanted.expectedHash
        )
          throw new Error(
            `Staged memory for ${wanted.taskId} failed its hash check.`,
          );
      }
      return { verified: true as const };
    },
    finalizeStagedDataset: async ({ dataset, token }, ctx) => {
      const marker = await readStagingMarker(
        ctx.experimental_paths.dataDir,
        dataset,
      );
      if (!marker || marker.token !== token) return { finalized: false };
      await unlink(join(marker.target, STAGING_MARKER_FILE));
      await syncDirectory(marker.target);
      return { finalized: true };
    },
    discardStagedDataset: async ({ dataset, token }, ctx) => {
      const dataDir = ctx.experimental_paths.dataDir;
      const marker = await readStagingMarker(dataDir, dataset);
      if (!marker || marker.token !== token) return { removed: false };
      const inventory = await stagingInventory(marker.target);
      if (!inventory) return { removed: false };
      const canonicalRoot = await realpath(dataDir);
      const datasetsRoot = join(canonicalRoot, "datasets");
      if (dirname(marker.target) !== datasetsRoot) return { removed: false };
      if ((await realpath(datasetsRoot)) !== datasetsRoot)
        return { removed: false };
      if ((await realpath(marker.target)) !== marker.target)
        return { removed: false };
      const stat = await lstat(marker.target);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        return { removed: false };
      await rm(marker.target, { recursive: true });
      await syncDirectory(datasetsRoot);
      return { removed: true as const };
    },
    reconcileStagedDatasets: async ({ activeDataset }, ctx) => {
      const dataDir = ctx.experimental_paths.dataDir;
      const canonicalRoot = await realpath(dataDir);
      const datasetsRoot = await secureChildDirectory(
        canonicalRoot,
        "datasets",
      );
      const discarded: string[] = [];
      const finalized: string[] = [];
      for (const name of await readdir(datasetsRoot)) {
        const stat = await lstat(join(datasetsRoot, name)).catch(() => null);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
        const marker = await readStagingMarker(dataDir, name);
        if (!marker) continue;
        if (name === activeDataset) {
          await unlink(join(marker.target, STAGING_MARKER_FILE)).catch(
            () => undefined,
          );
          await syncDirectory(marker.target).catch(() => undefined);
          finalized.push(name);
          continue;
        }
        const inventory = await stagingInventory(marker.target);
        if (!inventory) continue;
        await rm(marker.target, { recursive: true });
        discarded.push(name);
      }
      if (discarded.length) await syncDirectory(datasetsRoot);
      return { discarded, finalized };
    },
    publishArchive: (input, ctx) =>
      serialize(() => publishArchive(ctx.experimental_paths.dataDir, input)),
    recordArchiveFailure: async ({ dataset, message }, ctx) => {
      const { root } = await archiveDirectories(
        ctx.experimental_paths.dataDir,
        dataset,
      );
      await writeStoredHealth(root, {
        lastAttemptAt: new Date().toISOString(),
        error: bounded(message),
        warning: null,
      });
      return archiveHealth(ctx.experimental_paths.dataDir, dataset);
    },
  },
  dispose: async () => {
    const subscriptions = [...wayfinderWatches.values()];
    wayfinderWatches.clear();
    await Promise.allSettled(
      subscriptions.map((subscription) => subscription.dispose()),
    );
  },
});
