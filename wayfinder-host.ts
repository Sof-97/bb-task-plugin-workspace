import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import type { WayfinderSourceRead } from "./contract";

const MAX_TICKETS = 256;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_MS = 5_000;
const MAX_ATTEMPTS = 3;
const TICKET_NAME = /^\d+-[^/]+\.md$/i;

class SourceChanging extends Error {}

type Diagnostic = WayfinderSourceRead["diagnostics"][number];
type SourceFile = WayfinderSourceRead["map"];

export type WayfinderReadHooks = {
  afterParentValidated?: (context: {
    path: string;
    attempt: number;
    phase: "read" | "verify";
  }) => void | Promise<void>;
  afterFileStat?: (context: {
    path: string;
    attempt: number;
    phase: "read" | "verify";
  }) => void | Promise<void>;
  beforePublication?: (context: { attempt: number }) => void | Promise<void>;
};

type ReadContext = {
  deadline: number;
  attempt: number;
  phase: "read" | "verify";
  hooks?: WayfinderReadHooks;
  expectedParent?: Awaited<ReturnType<typeof canonicalDirectory>>;
};

type ReadResult = {
  source: SourceFile;
  bytes: number;
  diagnostic?: Diagnostic;
};

const diagnostic = (
  code: string,
  message: string,
  path?: string,
): Diagnostic => ({
  code,
  message,
  ...(path ? { path } : {}),
  severity: "error",
});

function repositoryRelative(value: string) {
  if (
    !value ||
    value.includes("\0") ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.includes("\\")
  )
    throw new Error("Wayfinder paths must be repository-relative POSIX paths.");
  const normalized = posix.normalize(value).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../"))
    throw new Error("Wayfinder path escapes the enrolled repository.");
  return normalized;
}

function confined(root: string, relativePath: string) {
  const absolute = resolve(
    root,
    ...repositoryRelative(relativePath).split("/"),
  );
  const fromRoot = relative(root, absolute);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  )
    throw new Error("Wayfinder path escapes the enrolled repository.");
  return absolute;
}

function sameStat(
  left: { dev: number; ino: number; size: number; mtimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number },
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function revisionOf(
  stat: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  },
  digest = "",
) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${digest}`;
}

async function canonicalDirectory(
  root: string,
  absolute: string,
  label: string,
) {
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${label} is not a real directory.`);
  const canonical = await realpath(absolute);
  if (canonical !== absolute)
    throw new Error(`${label} contains a symlinked or aliased path component.`);
  const fromRoot = relative(root, canonical);
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot))
    throw new Error(`${label} escapes the enrolled repository.`);
  return { canonical, info };
}

async function readSourceFile(
  repository: string,
  allowedRoot: string,
  repositoryPath: string,
  context: ReadContext,
): Promise<ReadResult> {
  const absolute = confined(repository, repositoryPath);
  let parentBefore: Awaited<ReturnType<typeof canonicalDirectory>>;
  try {
    parentBefore = await canonicalDirectory(
      repository,
      dirname(absolute),
      `Parent of ${repositoryPath}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        source: { path: repositoryPath, state: "missing" },
        bytes: 0,
      };
    return {
      source: { path: repositoryPath, state: "unreadable" },
      bytes: 0,
    };
  }
  const fromAllowed = relative(allowedRoot, parentBefore.canonical);
  if (
    fromAllowed === ".." ||
    fromAllowed.startsWith("../") ||
    isAbsolute(fromAllowed)
  )
    return {
      source: { path: repositoryPath, state: "unreadable" },
      bytes: 0,
    };
  if (
    context.expectedParent &&
    (parentBefore.canonical !== context.expectedParent.canonical ||
      parentBefore.info.dev !== context.expectedParent.info.dev ||
      parentBefore.info.ino !== context.expectedParent.info.ino)
  )
    throw new SourceChanging(
      `The confined parent of ${repositoryPath} changed before reading.`,
    );
  await context.hooks?.afterParentValidated?.({
    path: repositoryPath,
    attempt: context.attempt,
    phase: context.phase,
  });
  let handle;
  try {
    handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return {
        source: { path: repositoryPath, state: "missing" },
        bytes: 0,
      };
    return {
      source: { path: repositoryPath, state: "unreadable" },
      bytes: 0,
    };
  }
  try {
    const before = await handle.stat();
    const parentAfterOpen = await canonicalDirectory(
      repository,
      dirname(absolute),
      `Parent of ${repositoryPath}`,
    );
    const pathAfterOpen = await lstat(absolute).catch(() => null);
    if (
      parentAfterOpen.canonical !== parentBefore.canonical ||
      parentAfterOpen.info.dev !== parentBefore.info.dev ||
      parentAfterOpen.info.ino !== parentBefore.info.ino ||
      !pathAfterOpen ||
      pathAfterOpen.isSymbolicLink() ||
      pathAfterOpen.dev !== before.dev ||
      pathAfterOpen.ino !== before.ino
    )
      throw new SourceChanging(
        `${repositoryPath} or its parent changed before reading.`,
      );
    if (!before.isFile())
      return {
        source: {
          path: repositoryPath,
          state: "unreadable",
          revision: revisionOf(before),
        },
        bytes: 0,
      };
    await context.hooks?.afterFileStat?.({
      path: repositoryPath,
      attempt: context.attempt,
      phase: context.phase,
    });
    const chunks: Buffer[] = [];
    let byteCount = 0;
    while (byteCount <= MAX_FILE_BYTES) {
      if (Date.now() > context.deadline)
        return {
          source: {
            path: repositoryPath,
            state: "unreadable",
            revision: revisionOf(before),
          },
          bytes: byteCount,
          diagnostic: diagnostic(
            "scan-time-limit",
            `Wayfinder scan exceeded ${MAX_SCAN_MS}ms while reading a file.`,
            repositoryPath,
          ),
        };
      const buffer = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_FILE_BYTES + 1 - byteCount),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      byteCount += bytesRead;
    }
    if (byteCount > MAX_FILE_BYTES)
      return {
        source: {
          path: repositoryPath,
          state: "unreadable",
          revision: revisionOf(before),
        },
        bytes: byteCount,
        diagnostic: diagnostic(
          "file-byte-limit-exceeded",
          `File exceeded the ${MAX_FILE_BYTES}-byte bound while it was read.`,
          repositoryPath,
        ),
      };
    const bytes = Buffer.concat(chunks, byteCount);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      return {
        source: {
          path: repositoryPath,
          state: "unreadable",
          revision: revisionOf(before),
        },
        bytes: byteCount,
      };
    }
    const after = await handle.stat();
    const current = await lstat(absolute).catch(() => null);
    if (
      !sameStat(before, after) ||
      !current ||
      current.isSymbolicLink() ||
      !sameStat(before, current) ||
      (await realpath(dirname(absolute))) !== parentBefore.canonical
    )
      throw new SourceChanging(`${repositoryPath} changed while it was read.`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      source: {
        path: repositoryPath,
        state: "available",
        text,
        revision: revisionOf(before, digest),
      },
      bytes: byteCount,
    };
  } finally {
    await handle.close();
  }
}

async function candidateDirectories(
  repository: string,
  mapPath: string,
  diagnostics: Diagnostic[],
) {
  const result: string[] = [];
  for (const name of ["issues", "tickets"]) {
    const repositoryPath = posix.join(posix.dirname(mapPath), name);
    const absolute = confined(repository, repositoryPath);
    try {
      await canonicalDirectory(repository, absolute, `${name}/`);
      result.push(repositoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        diagnostics.push(
          diagnostic(
            "ticket-directory-unreadable",
            String(error instanceof Error ? error.message : error),
            repositoryPath,
          ),
        );
    }
  }
  return result;
}

async function readGeneration(
  args: {
    repository: string;
    mapPath: string;
    selectedDirectory: string | null;
  },
  attempt: number,
  deadline: number,
  hooks?: WayfinderReadHooks,
): Promise<WayfinderSourceRead> {
  const started = Date.now();
  const repository = await realpath(args.repository);
  const mapPath = repositoryRelative(args.mapPath);
  const mapAbsolute = confined(repository, mapPath);
  const mapParent = await canonicalDirectory(
    repository,
    dirname(mapAbsolute),
    "Wayfinder effort directory",
  );
  const diagnostics: Diagnostic[] = [];
  const candidates = await candidateDirectories(
    repository,
    mapPath,
    diagnostics,
  );
  let selectedDirectory = args.selectedDirectory
    ? repositoryRelative(args.selectedDirectory)
    : candidates.length === 1
      ? candidates[0]!
      : null;
  if (
    selectedDirectory &&
    (posix.dirname(selectedDirectory) !== posix.dirname(mapPath) ||
      !["issues", "tickets"].includes(posix.basename(selectedDirectory)))
  )
    throw new Error(
      "Selected ticket directory must be an issues/ or tickets/ sibling of the map.",
    );
  const mapRead = await readSourceFile(repository, repository, mapPath, {
    deadline,
    attempt,
    phase: "read",
    hooks,
    expectedParent: mapParent,
  });
  const map = mapRead.source;
  if (mapRead.diagnostic) diagnostics.push(mapRead.diagnostic);
  if (map.state !== "available")
    diagnostics.push(
      diagnostic(
        map.state === "missing" ? "map-missing" : "map-unreadable",
        `Wayfinder map is ${map.state}; the attachment identity remains available for recovery.`,
        mapPath,
      ),
    );
  if (!selectedDirectory && candidates.length > 1) {
    return {
      repository,
      mapPath,
      selectedDirectory: null,
      candidates,
      status: "selection-required",
      discoveryComplete: false,
      diagnostics: [
        ...diagnostics,
        diagnostic(
          "ticket-directory-selection-required",
          "Both sibling issues/ and tickets/ exist. Persist an explicit human selection; they were not merged.",
        ),
      ],
      scanTime: new Date().toISOString(),
      sourceRevision: createHash("sha256")
        .update(map.revision ?? map.state)
        .digest("hex"),
      watchRoot: mapParent.canonical,
      map,
      tickets: [],
    };
  }
  if (!selectedDirectory) {
    const missingDirectory = posix.join(posix.dirname(mapPath), "tickets");
    diagnostics.push(
      diagnostic(
        "ticket-directory-missing",
        "No sibling issues/ or tickets/ directory exists. Discovery is incomplete.",
        missingDirectory,
      ),
    );
    return {
      repository,
      mapPath,
      selectedDirectory: null,
      candidates,
      status: "incomplete",
      discoveryComplete: false,
      diagnostics,
      scanTime: new Date().toISOString(),
      sourceRevision: createHash("sha256")
        .update(map.revision ?? map.state)
        .digest("hex"),
      watchRoot: mapParent.canonical,
      map,
      tickets: [],
    };
  }
  if (!candidates.includes(selectedDirectory)) {
    diagnostics.push(
      diagnostic(
        "selected-ticket-directory-missing",
        "The persisted selected ticket directory is missing or unreadable. It was not replaced by another candidate.",
        selectedDirectory,
      ),
    );
    return {
      repository,
      mapPath,
      selectedDirectory,
      candidates,
      status: "incomplete",
      discoveryComplete: false,
      diagnostics,
      scanTime: new Date().toISOString(),
      sourceRevision: createHash("sha256")
        .update(map.revision ?? map.state)
        .digest("hex"),
      watchRoot: mapParent.canonical,
      map,
      tickets: [],
    };
  }
  const ticketAbsolute = confined(repository, selectedDirectory);
  const directoryBefore = await canonicalDirectory(
    repository,
    ticketAbsolute,
    "Selected ticket directory",
  );
  const entriesBefore = await readdir(ticketAbsolute, { withFileTypes: true });
  const names = entriesBefore
    .filter((entry) => TICKET_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  let discoveryComplete = map.state === "available";
  if (names.length > MAX_TICKETS) {
    diagnostics.push(
      diagnostic(
        "ticket-limit-exceeded",
        `Selected directory has ${names.length} matching tickets; the ${MAX_TICKETS}-file bound was exceeded.`,
        selectedDirectory,
      ),
    );
    discoveryComplete = false;
  }
  const tickets: SourceFile[] = [];
  let totalBytes = mapRead.bytes;
  for (const name of names.slice(0, MAX_TICKETS)) {
    if (Date.now() > deadline) {
      diagnostics.push(
        diagnostic(
          "scan-time-limit",
          `Wayfinder scan exceeded ${MAX_SCAN_MS}ms.`,
          selectedDirectory,
        ),
      );
      discoveryComplete = false;
      break;
    }
    const repositoryPath = posix.join(selectedDirectory, name);
    const fileRead = await readSourceFile(
      repository,
      ticketAbsolute,
      repositoryPath,
      {
        deadline,
        attempt,
        phase: "read",
        hooks,
        expectedParent: directoryBefore,
      },
    );
    const file = fileRead.source;
    tickets.push(file);
    if (fileRead.diagnostic) diagnostics.push(fileRead.diagnostic);
    if (file.state !== "available") {
      diagnostics.push(
        diagnostic(
          file.state === "missing" ? "ticket-missing" : "ticket-unreadable",
          `Ticket is ${file.state} and remains inspectable as an incomplete source.`,
          repositoryPath,
        ),
      );
      discoveryComplete = false;
    }
    totalBytes += fileRead.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      diagnostics.push(
        diagnostic(
          "total-byte-limit-exceeded",
          `Wayfinder content exceeded the ${MAX_TOTAL_BYTES}-byte generation bound.`,
          selectedDirectory,
        ),
      );
      discoveryComplete = false;
      break;
    }
  }
  const entriesAfter = (await readdir(ticketAbsolute, { withFileTypes: true }))
    .filter((entry) => TICKET_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const directoryAfter = await lstat(ticketAbsolute);
  if (
    JSON.stringify(names) !== JSON.stringify(entriesAfter) ||
    directoryAfter.isSymbolicLink() ||
    directoryAfter.dev !== directoryBefore.info.dev ||
    directoryAfter.ino !== directoryBefore.info.ino ||
    (await realpath(ticketAbsolute)) !== directoryBefore.canonical ||
    (await realpath(dirname(mapAbsolute))) !== mapParent.canonical
  )
    throw new SourceChanging(
      "Wayfinder directory changed during the generation.",
    );
  await hooks?.beforePublication?.({ attempt });
  const publicationEntries = (
    await readdir(ticketAbsolute, { withFileTypes: true })
  )
    .filter((entry) => TICKET_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const publicationDirectory = await canonicalDirectory(
    repository,
    ticketAbsolute,
    "Selected ticket directory",
  );
  if (
    JSON.stringify(names) !== JSON.stringify(publicationEntries) ||
    publicationDirectory.canonical !== directoryBefore.canonical ||
    publicationDirectory.info.dev !== directoryBefore.info.dev ||
    publicationDirectory.info.ino !== directoryBefore.info.ino
  )
    throw new SourceChanging(
      "Wayfinder ticket listing changed before the generation was published.",
    );
  for (const source of [map, ...tickets]) {
    if (!source.revision) continue;
    const isMap = source.path === mapPath;
    const allowedRoot = isMap ? repository : ticketAbsolute;
    const verified = await readSourceFile(
      repository,
      allowedRoot,
      source.path,
      {
        deadline,
        attempt,
        phase: "verify",
        hooks,
        expectedParent: isMap ? mapParent : directoryBefore,
      },
    );
    if (verified.diagnostic?.code === "scan-time-limit") {
      diagnostics.push(verified.diagnostic);
      discoveryComplete = false;
      break;
    }
    if (verified.source.revision !== source.revision)
      throw new SourceChanging(
        `${source.path} changed before the generation was published.`,
      );
  }
  const sourceRevision = createHash("sha256")
    .update(
      JSON.stringify([
        mapPath,
        map.revision ?? map.state,
        selectedDirectory,
        names,
        tickets.map((ticket) => [ticket.path, ticket.revision ?? ticket.state]),
      ]),
    )
    .digest("hex");
  return {
    repository,
    mapPath,
    selectedDirectory,
    candidates,
    status: discoveryComplete ? "ready" : "incomplete",
    discoveryComplete,
    diagnostics,
    scanTime: new Date().toISOString(),
    sourceRevision,
    watchRoot: mapParent.canonical,
    map,
    tickets,
  };
}

export async function readWayfinderSource(
  args: {
    repository: string;
    mapPath: string;
    selectedDirectory: string | null;
  },
  hooks?: WayfinderReadHooks,
): Promise<WayfinderSourceRead> {
  let last: SourceChanging | null = null;
  const deadline = Date.now() + MAX_SCAN_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await readGeneration(args, attempt, deadline, hooks);
    } catch (error) {
      if (!(error instanceof SourceChanging)) throw error;
      last = error;
    }
  }
  const repository = await realpath(args.repository);
  const mapPath = repositoryRelative(args.mapPath);
  return {
    repository,
    mapPath,
    selectedDirectory: args.selectedDirectory
      ? repositoryRelative(args.selectedDirectory)
      : null,
    candidates: [],
    status: "source-changing",
    discoveryComplete: false,
    diagnostics: [
      diagnostic(
        "source-changing",
        `${last?.message ?? "Wayfinder source kept changing."} Bounded retries were exhausted.`,
      ),
    ],
    scanTime: new Date().toISOString(),
    sourceRevision: createHash("sha256")
      .update(`changing:${Date.now()}`)
      .digest("hex"),
    watchRoot: dirname(confined(repository, mapPath)),
    map: { path: mapPath, state: "unreadable" },
    tickets: [],
  };
}

export const experimental_wayfinderHost = {
  limits: {
    maxTickets: MAX_TICKETS,
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxScanMs: MAX_SCAN_MS,
    maxAttempts: MAX_ATTEMPTS,
  },
  readWayfinderSource,
};
