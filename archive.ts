import { createHash } from "node:crypto";

export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_SCHEMA_VERSION = 11;
export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 16 * 1024 * 1024,
  entries: 4096,
  entryBytes: 2 * 1024 * 1024,
  payloadBytes: 12 * 1024 * 1024,
  tables: 256,
  rows: 200_000,
  memories: 20_000,
  memoryBytes: 1024 * 1024,
  depth: 128,
  nodes: 250_000,
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ArchiveTable = {
  name: string;
  classification: "canonical" | "unknown-recovery-only";
  rows: Record<string, Json>[];
};
export type ArchiveMemory = { taskId: string; bytes: Uint8Array };
export type ArchiveCapture = {
  archiveKind: "complete" | "recovery-only";
  schemaVersion: number;
  createdAt: string;
  localDay: string;
  source: { datasetId: string; hostId: string };
  diagnostics: string[];
  extensions: Record<string, Json>;
  tables: ArchiveTable[];
  memories: ArchiveMemory[];
};

export class ArchiveValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveValidationError";
  }
}

const fail = (code: string, message: string): never => {
  throw new ArchiveValidationError(code, message);
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TABLE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
export const ARCHIVE_TABLE_NAME_PATTERN = TABLE;
export const ARCHIVE_FORBIDDEN_TABLE_PATTERN =
  /^(?:credentials?|secrets?|transcripts?|conversation_messages?|repository_(?:bytes|files?)|wayfinder_(?:bytes|files?))$/i;
const FORBIDDEN_TABLE = ARCHIVE_FORBIDDEN_TABLE_PATTERN;
const FORBIDDEN_KEY =
  /^(?:credential|password|secret|accessToken|refreshToken|authToken|transcript|memoryBody|memoryMarkdown|memoryContent)$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function exact(value: unknown, keys: string[], label: string) {
  if (!object(value)) fail("MALFORMED", `${label} must be an object.`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...keys].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    fail("MALFORMED", `${label} has missing or unknown fields.`);
}

export function canonicalJson(
  value: unknown,
  limits = { depth: ARCHIVE_LIMITS.depth, nodes: ARCHIVE_LIMITS.nodes },
) {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, path: string, depth: number): string => {
    nodes += 1;
    if (nodes > limits.nodes)
      fail("LIMIT_EXCEEDED", `Canonical JSON exceeds ${limits.nodes} nodes.`);
    if (depth > limits.depth)
      fail("LIMIT_EXCEEDED", `Canonical JSON exceeds depth ${limits.depth}.`);
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "string"
    )
      return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        fail("NON_CANONICAL_VALUE", `${path} contains a non-finite number.`);
      return JSON.stringify(current);
    }
    if (typeof current !== "object")
      fail("NON_CANONICAL_VALUE", `${path} is not JSON data.`);
    const currentObject = current as object;
    if (active.has(currentObject))
      fail("NON_CANONICAL_VALUE", `${path} contains a cycle.`);
    active.add(currentObject);
    let result: string;
    if (Array.isArray(current)) {
      const items: string[] = [];
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index))
          fail("NON_CANONICAL_VALUE", `${path} is a sparse array.`);
        items.push(visit(current[index], `${path}[${index}]`, depth + 1));
      }
      result = `[${items.join(",")}]`;
    } else {
      if (!object(current))
        fail("NON_CANONICAL_VALUE", `${path} is not a plain JSON object.`);
      const record = current as Record<string, unknown>;
      result = `{${Object.keys(record)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${visit(record[key], `${path}.${key}`, depth + 1)}`,
        )
        .join(",")}}`;
    }
    active.delete(currentObject);
    return result;
  };
  return visit(value, "$", 0);
}

function safePath(path: unknown) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 240 ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("UNSAFE_PATH", `Unsafe archive path ${JSON.stringify(path)}.`);
}

function validateJson(
  value: unknown,
  path: string,
  state: { active: Set<object>; nodes: number },
  depth = 0,
) {
  state.nodes += 1;
  if (state.nodes > ARCHIVE_LIMITS.nodes)
    fail("LIMIT_EXCEEDED", "Structured records exceed the node limit.");
  if (depth > ARCHIVE_LIMITS.depth)
    fail("LIMIT_EXCEEDED", "Structured records exceed the depth limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("INVALID_RECORD", `${path} is non-finite.`);
    return;
  }
  if (typeof value !== "object") fail("INVALID_RECORD", `${path} is not JSON.`);
  const valueObject = value as object;
  if (state.active.has(valueObject))
    fail("INVALID_RECORD", `${path} contains a cycle.`);
  state.active.add(valueObject);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index))
        fail("INVALID_RECORD", `${path} is a sparse array.`);
      validateJson(value[index], `${path}[${index}]`, state, depth + 1);
    }
  } else {
    if (!object(value)) fail("INVALID_RECORD", `${path} is not plain JSON.`);
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_KEY.test(key))
        fail(
          "FORBIDDEN_CONTENT",
          `${path}.${key} is forbidden archive content.`,
        );
      validateJson(child, `${path}.${key}`, state, depth + 1);
    }
  }
  state.active.delete(valueObject);
}

function validateTable(value: unknown, kind: "complete" | "recovery-only") {
  exact(value, ["classification", "name", "rows"], "table");
  const table = value as ArchiveTable;
  if (!TABLE.test(table.name) || FORBIDDEN_TABLE.test(table.name))
    fail(
      "FORBIDDEN_CONTENT",
      `Table ${JSON.stringify(table.name)} is ineligible.`,
    );
  if (
    table.classification !== "canonical" &&
    table.classification !== "unknown-recovery-only"
  )
    fail("MALFORMED", `Table ${table.name} classification is invalid.`);
  if (
    table.classification === "unknown-recovery-only" &&
    kind !== "recovery-only"
  )
    fail("ARCHIVE_KIND", `Unknown table ${table.name} requires recovery-only.`);
  if (!Array.isArray(table.rows))
    fail("MALFORMED", `${table.name} rows are invalid.`);
  const state = { active: new Set<object>(), nodes: 0 };
  table.rows.forEach((row, index) => {
    if (!object(row))
      fail("INVALID_RECORD", `${table.name}[${index}] is invalid.`);
    validateJson(row, `${table.name}[${index}]`, state);
  });
}

function validInstant(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
function validDay(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

function metadata(value: ArchiveCapture) {
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1)
    fail("MALFORMED", "schemaVersion must be positive.");
  if (!validInstant(value.createdAt))
    fail("MALFORMED", "createdAt must be a real canonical UTC instant.");
  if (!validDay(value.localDay))
    fail("MALFORMED", "localDay must be a real date.");
  exact(value.source, ["datasetId", "hostId"], "source");
  if (
    !UUID.test(value.source.datasetId) ||
    !value.source.hostId ||
    value.source.hostId.length > 200
  )
    fail("MALFORMED", "source identity is invalid.");
  if (value.archiveKind !== "complete" && value.archiveKind !== "recovery-only")
    fail("ARCHIVE_KIND", "archiveKind is unsupported.");
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 512)
    fail("MALFORMED", "diagnostics are invalid.");
  if (value.archiveKind === "recovery-only" && value.diagnostics.length === 0)
    fail("ARCHIVE_KIND", "Recovery-only archives require diagnostics.");
  if (!object(value.extensions))
    fail("MALFORMED", "extensions must be an object.");
  canonicalJson(value.extensions);
}

export function encodeArchive(input: ArchiveCapture) {
  exact(
    input,
    [
      "archiveKind",
      "createdAt",
      "diagnostics",
      "extensions",
      "localDay",
      "memories",
      "schemaVersion",
      "source",
      "tables",
    ],
    "capture",
  );
  metadata(input);
  if (
    !Array.isArray(input.tables) ||
    input.tables.length > ARCHIVE_LIMITS.tables
  )
    fail("LIMIT_EXCEEDED", "Table count exceeds the limit.");
  if (
    !Array.isArray(input.memories) ||
    input.memories.length > ARCHIVE_LIMITS.memories
  )
    fail("LIMIT_EXCEEDED", "Memory count exceeds the limit.");
  const manifests: Record<string, Json>[] = [];
  const payloads: Record<string, Json>[] = [];
  const paths = new Set<string>();
  let rows = 0;
  let memoryBytes = 0;
  let payloadBytes = 0;
  const add = (path: string, type: "records" | "memory", bytes: Uint8Array) => {
    safePath(path);
    const key = path.toLocaleLowerCase("en-US");
    if (paths.has(key))
      fail("DUPLICATE_PATH", `Duplicate archive path ${path}.`);
    paths.add(key);
    if (
      manifests.length >= ARCHIVE_LIMITS.entries ||
      bytes.byteLength > ARCHIVE_LIMITS.entryBytes
    )
      fail("LIMIT_EXCEEDED", `Entry ${path} exceeds limits.`);
    payloadBytes += bytes.byteLength;
    if (payloadBytes > ARCHIVE_LIMITS.payloadBytes)
      fail("LIMIT_EXCEEDED", "Archive payload exceeds the limit.");
    manifests.push({ path, type, size: bytes.byteLength, sha256: hash(bytes) });
    payloads.push({
      path,
      encoding: "base64",
      data: Buffer.from(bytes).toString("base64"),
    });
  };
  for (const table of [...input.tables].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    validateTable(table, input.archiveKind);
    rows += table.rows.length;
    if (rows > ARCHIVE_LIMITS.rows)
      fail("LIMIT_EXCEEDED", "Row count exceeds the limit.");
    add(
      `records/${table.name}.json`,
      "records",
      encoder.encode(canonicalJson(table)),
    );
  }
  for (const memory of [...input.memories].sort((a, b) =>
    a.taskId.localeCompare(b.taskId),
  )) {
    exact(memory, ["bytes", "taskId"], "memory");
    if (!UUID.test(memory.taskId) || !(memory.bytes instanceof Uint8Array))
      fail("MALFORMED", "Memory entry is invalid.");
    try {
      decoder.decode(memory.bytes);
    } catch {
      fail("INVALID_MEMORY", `Memory ${memory.taskId} is not UTF-8.`);
    }
    if (memory.bytes.byteLength > ARCHIVE_LIMITS.memoryBytes)
      fail("LIMIT_EXCEEDED", `Memory ${memory.taskId} exceeds the limit.`);
    memoryBytes += memory.bytes.byteLength;
    add(`memory/${memory.taskId}.md`, "memory", memory.bytes);
  }
  const manifest = {
    archiveKind: input.archiveKind,
    counts: {
      entries: manifests.length,
      memories: input.memories.length,
      memoryBytes,
      records: rows,
      tables: input.tables.length,
      totalPayloadBytes: payloadBytes,
    },
    createdAt: input.createdAt,
    diagnostics: input.diagnostics,
    entries: manifests,
    extensions: input.extensions,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    localDay: input.localDay,
    schemaVersion: input.schemaVersion,
    source: input.source,
  };
  const result = encoder.encode(canonicalJson({ entries: payloads, manifest }));
  if (result.byteLength > ARCHIVE_LIMITS.archiveBytes)
    fail("LIMIT_EXCEEDED", "Encoded archive exceeds the limit.");
  return result;
}

function base64(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail("MALFORMED", `${label} is not canonical base64.`);
  const text = value as string;
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text)
    fail("MALFORMED", `${label} base64 is invalid.`);
  return bytes;
}

export function validateArchive(
  bytes: Uint8Array,
  maxSchemaVersion = ARCHIVE_SCHEMA_VERSION,
) {
  if (!(bytes instanceof Uint8Array))
    fail("MALFORMED", "Archive must be bytes.");
  if (bytes.byteLength > ARCHIVE_LIMITS.archiveBytes)
    fail("LIMIT_EXCEEDED", "Archive exceeds the limit.");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    fail("NON_CANONICAL_ARCHIVE", "Archive must not begin with a BOM.");
  let text: string;
  let root: unknown;
  try {
    text = decoder.decode(bytes);
    root = JSON.parse(text);
  } catch {
    fail("MALFORMED", "Archive is not canonical UTF-8 JSON.");
  }
  if (!Buffer.from(encoder.encode(text!)).equals(Buffer.from(bytes)))
    fail("NON_CANONICAL_ARCHIVE", "Archive bytes are not canonical UTF-8.");
  if (canonicalJson(root) !== text!)
    fail("NON_CANONICAL_ARCHIVE", "Archive is not canonical JSON.");
  exact(root, ["entries", "manifest"], "archive");
  const envelope = root as {
    entries: unknown[];
    manifest: Record<string, unknown>;
  };
  exact(
    envelope.manifest,
    [
      "archiveKind",
      "counts",
      "createdAt",
      "diagnostics",
      "entries",
      "extensions",
      "formatVersion",
      "localDay",
      "schemaVersion",
      "source",
    ],
    "manifest",
  );
  if (envelope.manifest.formatVersion !== ARCHIVE_FORMAT_VERSION)
    fail("UNSUPPORTED_FORMAT", "Archive format is unsupported.");
  metadata(envelope.manifest as unknown as ArchiveCapture);
  if ((envelope.manifest.schemaVersion as number) > maxSchemaVersion)
    fail("UNSUPPORTED_SCHEMA", "Archive schema is newer than this plugin.");
  if (
    !Array.isArray(envelope.entries) ||
    !Array.isArray(envelope.manifest.entries)
  )
    fail("MALFORMED", "Archive entries are invalid.");
  const manifestEntries = envelope.manifest.entries as unknown[];
  if (envelope.entries.length !== manifestEntries.length)
    fail("COUNT_MISMATCH", "Manifest and payload counts differ.");
  const payloads = new Map<string, Uint8Array>();
  for (const raw of envelope.entries) {
    exact(raw, ["data", "encoding", "path"], "payload");
    const payload = raw as Record<string, unknown>;
    safePath(payload.path);
    if (payload.encoding !== "base64")
      fail("MALFORMED", "Payload encoding is unsupported.");
    const path = payload.path as string;
    const key = path.toLocaleLowerCase("en-US");
    if (
      [...payloads.keys()].some(
        (item) => item.toLocaleLowerCase("en-US") === key,
      )
    )
      fail("DUPLICATE_PATH", `Duplicate payload ${path}.`);
    payloads.set(path, base64(payload.data, path));
  }
  const tables: ArchiveTable[] = [];
  const memories: ArchiveMemory[] = [];
  const seen = new Set<string>();
  let rows = 0;
  let memoryBytes = 0;
  let payloadBytes = 0;
  for (const raw of manifestEntries) {
    exact(raw, ["path", "sha256", "size", "type"], "manifest entry");
    const entry = raw as Record<string, unknown>;
    safePath(entry.path);
    const path = entry.path as string;
    const key = path.toLocaleLowerCase("en-US");
    if (seen.has(key))
      fail("DUPLICATE_PATH", `Duplicate manifest path ${path}.`);
    seen.add(key);
    if (
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      !HASH.test(String(entry.sha256))
    )
      fail("MALFORMED", `Entry metadata for ${path} is invalid.`);
    const payload = payloads.get(path);
    if (!payload) fail("MISSING_ENTRY", `Payload ${path} is missing.`);
    const presentPayload = payload as Uint8Array;
    if (presentPayload.byteLength !== entry.size)
      fail("SIZE_MISMATCH", `Size mismatch for ${path}.`);
    if (hash(presentPayload) !== entry.sha256)
      fail("HASH_MISMATCH", `Hash mismatch for ${path}.`);
    payloadBytes += presentPayload.byteLength;
    if (
      entry.type === "records" &&
      /^records\/[A-Za-z][A-Za-z0-9_]{0,127}\.json$/.test(path)
    ) {
      let table: unknown;
      let recordText: string;
      try {
        recordText = decoder.decode(presentPayload);
        table = JSON.parse(recordText);
      } catch {
        fail("INVALID_RECORD", `${path} is not UTF-8 JSON.`);
      }
      if (canonicalJson(table) !== recordText!)
        fail("INVALID_RECORD", `${path} is not canonical.`);
      validateTable(
        table,
        envelope.manifest.archiveKind as "complete" | "recovery-only",
      );
      const typed = table as ArchiveTable;
      if (path !== `records/${typed.name}.json`)
        fail("PATH_MISMATCH", `${path} mismatches its table.`);
      rows += typed.rows.length;
      tables.push(typed);
    } else if (
      entry.type === "memory" &&
      /^memory\/[0-9a-f-]{36}\.md$/.test(path)
    ) {
      const taskId = path.slice(7, -3);
      if (!UUID.test(taskId))
        fail("UNSAFE_PATH", `Memory path ${path} is invalid.`);
      try {
        decoder.decode(presentPayload);
      } catch {
        fail("INVALID_MEMORY", `${path} is not UTF-8.`);
      }
      memoryBytes += presentPayload.byteLength;
      memories.push({ taskId, bytes: new Uint8Array(presentPayload) });
    } else fail("UNSUPPORTED_ENTRY", `Entry ${path} is unsupported.`);
  }
  if (payloads.size !== seen.size)
    fail("UNDECLARED_ENTRY", "Archive has undeclared payloads.");
  const counts = {
    entries: seen.size,
    memories: memories.length,
    memoryBytes,
    records: rows,
    tables: tables.length,
    totalPayloadBytes: payloadBytes,
  };
  if (canonicalJson(counts) !== canonicalJson(envelope.manifest.counts))
    fail("COUNT_MISMATCH", "Manifest counts do not match payloads.");
  return { manifest: envelope.manifest, tables, memories };
}
