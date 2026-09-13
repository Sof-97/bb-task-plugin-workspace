import { afterEach, expect, test } from "vitest";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWayfinderSource } from "./wayfinder-host";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wayfinder-host-"));
  roots.push(root);
  await mkdir(join(root, "planning", "tickets"), { recursive: true });
  await writeFile(join(root, "planning", "map.md"), "# Map");
  await writeFile(join(root, "planning", "tickets", "01-one.md"), "Type: task");
  return root;
}

test("reads one nonrecursive sibling candidate with bounded source identity", async () => {
  const root = await fixture();
  await mkdir(join(root, "planning", "tickets", "nested"));
  await writeFile(
    join(root, "planning", "tickets", "nested", "02-no.md"),
    "Type: task",
  );
  await writeFile(join(root, "planning", "tickets", "note.md"), "ignored");
  const source = await readWayfinderSource({
    repository: root,
    mapPath: "planning/map.md",
    selectedDirectory: null,
  });
  expect(source).toMatchObject({
    status: "ready",
    selectedDirectory: "planning/tickets",
    discoveryComplete: true,
  });
  expect(source.tickets.map((ticket) => ticket.path)).toEqual([
    "planning/tickets/01-one.md",
  ]);
  expect(source.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
});

test("both issues and tickets require persisted human selection", async () => {
  const root = await fixture();
  await mkdir(join(root, "planning", "issues"));
  const source = await readWayfinderSource({
    repository: root,
    mapPath: "planning/map.md",
    selectedDirectory: null,
  });
  expect(source).toMatchObject({
    status: "selection-required",
    selectedDirectory: null,
    discoveryComplete: false,
  });
  expect(source.candidates).toEqual(["planning/issues", "planning/tickets"]);
});

test("missing persisted directory remains selected and incomplete", async () => {
  const root = await fixture();
  const source = await readWayfinderSource({
    repository: root,
    mapPath: "planning/map.md",
    selectedDirectory: "planning/issues",
  });
  expect(source).toMatchObject({
    status: "incomplete",
    selectedDirectory: "planning/issues",
    discoveryComplete: false,
  });
  expect(source.diagnostics.map((item) => item.code)).toContain(
    "selected-ticket-directory-missing",
  );
});

test("rejects traversal, absolute paths, sibling mismatch and symlink escapes", async () => {
  const root = await fixture();
  await expect(
    readWayfinderSource({
      repository: root,
      mapPath: "../map.md",
      selectedDirectory: null,
    }),
  ).rejects.toThrow("escapes");
  await expect(
    readWayfinderSource({
      repository: root,
      mapPath: "/planning/map.md",
      selectedDirectory: null,
    }),
  ).rejects.toThrow("repository-relative");
  await expect(
    readWayfinderSource({
      repository: root,
      mapPath: "planning/map.md",
      selectedDirectory: "other/tickets",
    }),
  ).rejects.toThrow("sibling");
  const outside = await mkdtemp(join(tmpdir(), "wayfinder-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "map.md"), "# Outside");
  await rm(join(root, "planning", "map.md"));
  await symlink(join(outside, "map.md"), join(root, "planning", "map.md"));
  const source = await readWayfinderSource({
    repository: root,
    mapPath: "planning/map.md",
    selectedDirectory: "planning/tickets",
  });
  expect(source.map.state).toBe("unreadable");
  expect(source.discoveryComplete).toBe(false);
});

test("rejects an ancestor replacement between validation and open without reading outside", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "wayfinder-outside-parent-"));
  roots.push(outside);
  await writeFile(join(outside, "map.md"), "# Secret outside");
  let replaced = false;
  let openedReplacement = false;
  const reading = readWayfinderSource(
    {
      repository: root,
      mapPath: "planning/map.md",
      selectedDirectory: "planning/tickets",
    },
    {
      afterParentValidated: async ({ path, phase }) => {
        if (replaced || path !== "planning/map.md" || phase !== "read") return;
        replaced = true;
        await rename(join(root, "planning"), join(root, "planning-original"));
        await symlink(outside, join(root, "planning"));
      },
      afterFileStat: ({ path }) => {
        if (replaced && path === "planning/map.md") openedReplacement = true;
      },
    },
  );
  await expect(reading).rejects.toThrow(
    /not a real directory|symlinked|aliased/,
  );
  expect(openedReplacement).toBe(false);
});

test("bounds a file that grows after stat using actual descriptor bytes", async () => {
  const root = await fixture();
  const ticket = join(root, "planning", "tickets", "01-one.md");
  let grown = false;
  const source = await readWayfinderSource(
    {
      repository: root,
      mapPath: "planning/map.md",
      selectedDirectory: "planning/tickets",
    },
    {
      afterFileStat: async ({ path, phase }) => {
        if (grown || path !== "planning/tickets/01-one.md" || phase !== "read")
          return;
        grown = true;
        await appendFile(ticket, Buffer.alloc(512 * 1024 + 1));
      },
    },
  );
  expect(source.discoveryComplete).toBe(false);
  expect(source.tickets[0]?.state).toBe("unreadable");
  expect(source.diagnostics.map((item) => item.code)).toContain(
    "file-byte-limit-exceeded",
  );
});

test("content digest catches same-size rewrites with restored mtime", async () => {
  const root = await fixture();
  const ticket = join(root, "planning", "tickets", "01-one.md");
  const original = await stat(ticket);
  const source = await readWayfinderSource(
    {
      repository: root,
      mapPath: "planning/map.md",
      selectedDirectory: "planning/tickets",
    },
    {
      beforePublication: async ({ attempt }) => {
        const replacement = attempt % 2 === 0 ? "Type: TASK" : "Type: task";
        await writeFile(ticket, replacement);
        await utimes(ticket, original.atime, original.mtime);
      },
    },
  );
  expect(source.status).toBe("source-changing");
  expect(source.diagnostics.map((item) => item.code)).toContain(
    "source-changing",
  );
});

test("listing churn exhausts bounded retries with an explicit diagnostic", async () => {
  const root = await fixture();
  const source = await readWayfinderSource(
    {
      repository: root,
      mapPath: "planning/map.md",
      selectedDirectory: "planning/tickets",
    },
    {
      beforePublication: async ({ attempt }) => {
        await writeFile(
          join(root, "planning", "tickets", `0${attempt + 2}-churn.md`),
          "Type: task",
        );
      },
    },
  );
  expect(source).toMatchObject({
    status: "source-changing",
    discoveryComplete: false,
  });
  expect(source.diagnostics[0]?.message).toMatch(/retries were exhausted/i);
});
