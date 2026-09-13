import { expect, test } from "vitest";
import {
  readWayfinderSnapshot,
  type SourceFileSnapshot,
} from "./wayfinder-reader";

const directory = "planning/tickets";
const file = (name: string, text: string): SourceFileSnapshot => ({
  path: `${directory}/${name}`,
  state: "available",
  text,
});
const read = (
  tickets: SourceFileSnapshot[],
  map = "# Map\n\n## Decisions\n",
  complete = true,
) =>
  readWayfinderSnapshot({
    map: { path: "planning/map.md", state: "available", text: map },
    selectedDirectory: directory,
    tickets,
    discoveryComplete: complete,
  });

test("top-level metadata ignores fenced, quoted and indented examples", () => {
  const result = read([
    file(
      "01-one.md",
      [
        "# One",
        "Type: task",
        "Status: claimed",
        "Claimed by: thr_a",
        "```md",
        "Status: resolved",
        "```",
        "> Status: resolved",
        "    Status: resolved",
        "",
        "## Question",
        "Keep **Markdown**.",
      ].join("\n"),
    ),
  ]);
  expect(result.tickets[0]).toMatchObject({
    status: "claimed",
    claimedBy: "thr_a",
    questionMarkdown: "Keep **Markdown**.",
  });
});

test("document definitions resolve full, collapsed and shortcut blocker and Parent references", () => {
  const result = read([
    file("01-one.md", "Type: task\nStatus: resolved\n\n## Answer\nDone"),
    file("02-two.md", "Type: task\nStatus: resolved\n\n## Answer\nDone"),
    file("03-three.md", "Type: task\nStatus: resolved\n\n## Answer\nDone"),
    file(
      "04-next.md",
      [
        "Parent: [Road map][ Parent Ref ]",
        "Type: task",
        "Blocked by: [Label with spaces][ DEP ONE ], [Two][], [three]",
        "",
        "[parent   ref]: ../map.md",
        "[dep one]: ./01-one.md#answer",
        "[two]: 02-two.md",
        "[three]: ./03-three.md",
      ].join("\n"),
    ),
  ]);
  expect(
    result.tickets[3]?.blockers.map((edge) => [edge.raw, edge.targetPath]),
  ).toEqual([
    ["[Label with spaces][ DEP ONE ]", `${directory}/01-one.md`],
    ["[Two][]", `${directory}/02-two.md`],
    ["[three]", `${directory}/03-three.md`],
  ]);
  expect(result.frontier.knownReadyPaths).toEqual([`${directory}/04-next.md`]);
});

test("status is authoritative but Answer contradictions never unlock", () => {
  const result = read([
    file("01-open.md", "Type: task\nStatus: open\n\n## Answer\nPremature"),
    file("02-resolved.md", "Type: task\nStatus: resolved\n\n## Answer\n"),
    file("03-next.md", "Type: task\nBlocked by: 02"),
  ]);
  expect(
    result.tickets.map((ticket) => [ticket.status, ticket.consistent]),
  ).toEqual([
    ["open", false],
    ["resolved", false],
    ["open", true],
  ]);
  expect(result.frontier.knownReadyPaths).toEqual([]);
});

test("nested section headings preserve Answer content and map scope hierarchy", () => {
  const result = read(
    [
      file("01-later.md", "Type: task"),
      file(
        "02-now.md",
        "Type: task\nStatus: resolved\n\n## Answer\n### Proof\nReal content",
      ),
    ],
    "# Map\n\n## Out of scope\n### Later\n- [Deferred title](tickets/01-later.md)\n\n## Decisions\n### Now\n- [Current title](tickets/02-now.md)",
  );
  expect(result.tickets[0]).toMatchObject({
    scope: "out-of-scope",
    title: "Deferred title",
    titleSource: "map-link",
  });
  expect(result.tickets[1]).toMatchObject({
    answerMarkdown: "### Proof\nReal content",
    consistent: true,
  });
});

test("numeric duplicates, absolute paths, dangling and outside blockers remain unresolved", () => {
  const result = read([
    file("01-a.md", "Type: task\nStatus: resolved\n\n## Answer\nA"),
    file("1-b.md", "Type: task\nStatus: resolved\n\n## Answer\nB"),
    file(
      "02-next.md",
      "Type: task\nBlocked by: 1, /planning/tickets/01-a.md, %2Fplanning%2Ftickets%2F01-a.md, ./99-missing.md, ../outside.md",
    ),
  ]);
  expect(result.tickets[2]?.blockers.map((edge) => edge.resolution)).toEqual([
    "ambiguous",
    "unsupported",
    "unsupported",
    "missing",
    "outside",
  ]);
  expect(result.frontier.knownReadyPaths).toEqual([]);
});

test("cycles terminate while an unaffected component remains locally ready", () => {
  const result = read(
    [
      file("01-a.md", "Type: task\nBlocked by: 02"),
      file("02-b.md", "Type: task\nBlocked by: 01"),
      file("03-self.md", "Type: task\nBlocked by: 03"),
      file("04-done.md", "Type: task\nStatus: resolved\n\n## Answer\nDone"),
      file("05-ready.md", "Type: task\nBlocked by: 04"),
    ],
    "# Map",
    false,
  );
  expect(result.sccs.filter((component) => component.cyclic)).toHaveLength(2);
  expect(result.frontier).toMatchObject({
    complete: false,
    label: "known-component-readiness",
    knownReadyPaths: [`${directory}/05-ready.md`],
  });
});

test("missing text, rejected membership and contradictory Parent withhold complete claims", () => {
  const result = read([
    { path: `${directory}/01-no-text.md`, state: "available" },
    file("02-parent.md", "Type: task\nParent: ../other.md"),
    {
      path: `${directory}/not-a-ticket.md`,
      state: "available",
      text: "Type: task",
    },
  ]);
  expect(result.frontier.complete).toBe(false);
  expect(result.tickets[0]?.diagnostics.map((item) => item.code)).toContain(
    "source-unavailable",
  );
  expect(result.tickets[1]?.diagnostics.map((item) => item.code)).toContain(
    "parent-contradiction",
  );
  expect(result.diagnostics.map((item) => item.code)).toContain(
    "invalid-membership",
  );
});

test("stable ordering is numeric then path and omitted status is open", () => {
  const result = read([
    file("10-z.md", "Type: research"),
    file("02-z.md", "Type: prototype"),
    file("02-a.md", "Type: grilling"),
  ]);
  expect(result.tickets.map((ticket) => [ticket.path, ticket.status])).toEqual([
    [`${directory}/02-a.md`, "open"],
    [`${directory}/02-z.md`, "open"],
    [`${directory}/10-z.md`, "open"],
  ]);
});

test("YAML-frontmatter profile remains inspectable but never claims a complete graph", () => {
  const result = read([
    file(
      "01-yaml.md",
      "---\nstatus: resolved\ntype: task\n---\n# YAML ticket\n\nMarkdown body",
    ),
  ]);
  expect(result.tickets[0]?.title).toBe("YAML ticket");
  expect(result.tickets[0]?.diagnostics.map((item) => item.code)).toContain(
    "unsupported-format",
  );
  expect(result.frontier.complete).toBe(false);
  expect(result.frontier.knownReadyPaths).toEqual([]);
});
