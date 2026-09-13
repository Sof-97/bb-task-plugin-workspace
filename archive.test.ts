import { describe, expect, it } from "vitest";
import {
  ArchiveValidationError,
  canonicalJson,
  encodeArchive,
  validateArchive,
  type ArchiveCapture,
} from "./archive";

const id = "123e4567-e89b-42d3-a456-426614174000";
const capture = (): ArchiveCapture => ({
  archiveKind: "complete",
  schemaVersion: 10,
  createdAt: "2026-09-12T10:00:00.000Z",
  localDay: "2026-09-12",
  source: { datasetId: id, hostId: "host-local" },
  diagnostics: [],
  extensions: { adapter: "task-workspace/v1" },
  tables: [
    {
      name: "tasks",
      classification: "canonical",
      rows: [{ id, description: "Markdown" }],
    },
  ],
  memories: [
    { taskId: id, bytes: new TextEncoder().encode("\ufeff# Memory\n") },
  ],
});

describe("archive codec", () => {
  it("round trips structured records and exact memory bytes", () => {
    const encoded = encodeArchive(capture());
    const decoded = validateArchive(encoded);
    expect(decoded.tables[0]?.rows[0]?.description).toBe("Markdown");
    expect(decoded.memories[0]?.bytes).toEqual(capture().memories[0]?.bytes);
  });

  it("rejects corruption, a leading archive BOM, and unsupported versions", () => {
    const encoded = encodeArchive(capture());
    const corrupt = Uint8Array.from(encoded);
    corrupt[corrupt.length - 2] ^= 1;
    expect(() => validateArchive(corrupt)).toThrow(ArchiveValidationError);
    expect(() =>
      validateArchive(Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded])),
    ).toThrow(/must not begin with a BOM/);
    expect(() => validateArchive(encoded, 9)).toThrow(/newer/);
  });

  it("rejects impossible dates, forbidden content, sparse arrays, cycles, and deep input", () => {
    expect(() =>
      encodeArchive({ ...capture(), createdAt: "2026-13-12T00:00:00.000Z" }),
    ).toThrow(ArchiveValidationError);
    expect(() =>
      encodeArchive({
        ...capture(),
        tables: [
          {
            name: "tasks",
            classification: "canonical",
            rows: [{ password: "no" }],
          },
        ],
      }),
    ).toThrow(/forbidden/);
    expect(() => canonicalJson(new Array(2))).toThrow(/sparse/);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
    let deep: unknown = null;
    for (let index = 0; index < 12_000; index += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/depth/);
  });

  it("rejects unsafe and duplicate paths on attacker-supplied archives", () => {
    const root = JSON.parse(new TextDecoder().decode(encodeArchive(capture())));
    root.entries[0].path = "../tasks.json";
    const unsafe = new TextEncoder().encode(canonicalJson(root));
    expect(() => validateArchive(unsafe)).toThrow(/Unsafe archive path/);

    const duplicate = JSON.parse(
      new TextDecoder().decode(encodeArchive(capture())),
    );
    duplicate.entries.push(duplicate.entries[0]);
    duplicate.manifest.entries.push(duplicate.manifest.entries[0]);
    duplicate.manifest.counts.entries += 1;
    const duplicateBytes = new TextEncoder().encode(canonicalJson(duplicate));
    expect(() => validateArchive(duplicateBytes)).toThrow(/Duplicate payload/);
  });
});
