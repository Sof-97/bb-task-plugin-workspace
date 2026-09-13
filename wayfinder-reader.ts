import path from "node:path";
import type {
  Definition,
  Heading,
  Link,
  LinkReference,
  Paragraph,
  Root,
  RootContent,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const posix = path.posix;
const parser = unified().use(remarkParse).use(remarkGfm);
const KNOWN_TYPES = new Set(["research", "prototype", "grilling", "task"]);
const KNOWN_STATUSES = new Set(["open", "claimed", "resolved"]);
const METADATA_FIELDS = [
  "Type",
  "Status",
  "Claimed by",
  "Blocked by",
  "Parent",
] as const;
type MetadataField = (typeof METADATA_FIELDS)[number];

export type SourceState = "available" | "missing" | "unreadable";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface SourceFileSnapshot {
  /** Normalized repository-relative POSIX path supplied by the host layer. */
  path: string;
  state: SourceState;
  text?: string;
  revision?: string;
}

export interface DiscoveryDiagnostic {
  code: string;
  message: string;
  path?: string;
  severity?: DiagnosticSeverity;
}

export interface WayfinderSourceSnapshot {
  map: SourceFileSnapshot;
  /** Caller-selected, repository-relative directory identity. */
  selectedDirectory: string;
  /** Caller supplies only non-recursive NN-slug.md candidates. */
  tickets: readonly SourceFileSnapshot[];
  discoveryComplete: boolean;
  discoveryDiagnostics?: readonly DiscoveryDiagnostic[];
  effortDirectoryName?: string;
}

export interface Diagnostic extends DiscoveryDiagnostic {
  severity: DiagnosticSeverity;
}

export interface MarkdownReference {
  sourcePath: string;
  label: string;
  destination: string;
  fragment?: string;
  identity?: string;
  kind: "inline" | "reference";
  classification: "local" | "remote" | "unsafe" | "invalid";
}

export interface MarkdownSection {
  heading: string;
  depth: number;
  markdown: string;
}

export interface BlockerEdge {
  sourcePath: string;
  raw: string;
  navigationTarget?: string;
  targetPath?: string;
  targetId?: string;
  resolution: "resolved" | "missing" | "ambiguous" | "outside" | "unsupported";
  diagnostic?: string;
}

export interface NormalizedTicket {
  path: string;
  id: string;
  numericId: number;
  title: string;
  titleSource: "h1" | "map-link" | "filename";
  type: string | null;
  status: "open" | "claimed" | "resolved" | "unknown";
  rawMetadata: Readonly<Record<string, readonly string[]>>;
  claimedBy: string | null;
  questionMarkdown: string | null;
  answerMarkdown: string | null;
  references: readonly MarkdownReference[];
  blockers: readonly BlockerEdge[];
  scope: "in-scope" | "out-of-scope" | "ambiguous";
  consistent: boolean;
  diagnostics: readonly Diagnostic[];
}

export interface StronglyConnectedComponent {
  paths: readonly string[];
  cyclic: boolean;
}

export interface WayfinderGraphResult {
  adapter: "wayfinder-explicit-status/v1";
  source: {
    mapPath: string;
    selectedDirectory: string;
    mapState: SourceState;
    discoveryComplete: boolean;
  };
  map: {
    title: string;
    titleSource: "h1" | "effort-directory";
    sections: readonly MarkdownSection[];
    references: readonly MarkdownReference[];
  };
  tickets: readonly NormalizedTicket[];
  outOfScope: readonly string[];
  edges: readonly BlockerEdge[];
  sccs: readonly StronglyConnectedComponent[];
  frontier: {
    complete: boolean;
    knownReadyPaths: readonly string[];
    label: "complete-frontier" | "known-component-readiness";
  };
  diagnostics: readonly Diagnostic[];
}

interface ParsedMarkdown {
  root: Root;
  definitions: Map<string, Definition>;
  references: MarkdownReference[];
  sections: MarkdownSection[];
  h1: string | null;
}

interface MetadataValue {
  raw: string;
  start: number;
  end: number;
}

interface BlockerToken {
  raw: string;
  destination?: string;
}

interface DraftTicket {
  file: SourceFileSnapshot;
  parsed: ParsedMarkdown;
  id: string;
  numericId: number;
  metadata: Map<MetadataField, MetadataValue[]>;
  diagnostics: Diagnostic[];
  status: NormalizedTicket["status"];
  type: string | null;
  claimedBy: string | null;
  questionMarkdown: string | null;
  answerMarkdown: string | null;
  scope: NormalizedTicket["scope"];
  title: string;
  titleSource: NormalizedTicket["titleSource"];
  parentConsistent: boolean;
  blockers: BlockerEdge[];
}

export function readWayfinderSnapshot(
  snapshot: WayfinderSourceSnapshot,
): WayfinderGraphResult {
  const selectedDirectory = normalizeIdentity(snapshot.selectedDirectory);
  const diagnostics: Diagnostic[] = (snapshot.discoveryDiagnostics ?? []).map(
    (item) => ({
      ...item,
      severity: item.severity ?? "error",
    }),
  );
  const mapParsed = parseAvailable(snapshot.map, diagnostics);
  const mapTitle =
    mapParsed?.h1 ??
    snapshot.effortDirectoryName ??
    posix.basename(posix.dirname(snapshot.map.path));
  const mapSections = mapParsed?.sections ?? [];
  const mapReferences = mapParsed?.references ?? [];
  const membership = new Map<string, SourceFileSnapshot>();
  let membershipRejected = false;

  for (const file of snapshot.tickets) {
    const normalized = normalizeIdentity(file.path);
    const parent = posix.dirname(normalized);
    if (
      parent !== selectedDirectory ||
      !/^\d+-[^/]+\.md$/i.test(posix.basename(normalized))
    ) {
      diagnostics.push(
        diag(
          "invalid-membership",
          `Caller supplied a non-member ticket path: ${file.path}`,
          file.path,
        ),
      );
      membershipRejected = true;
      continue;
    }
    if (membership.has(normalized)) {
      diagnostics.push(
        diag(
          "duplicate-membership",
          `Caller supplied the ticket path more than once: ${file.path}`,
          file.path,
        ),
      );
      membershipRejected = true;
      continue;
    }
    membership.set(normalized, { ...file, path: normalized });
  }

  const mapLinkInfo = classifyMapLinks(
    mapParsed,
    snapshot.map.path,
    membership,
  );
  diagnostics.push(...mapLinkInfo.diagnostics);
  const drafts: DraftTicket[] = [];
  for (const file of membership.values()) {
    const localDiagnostics: Diagnostic[] = [];
    const parsed = parseAvailable(file, localDiagnostics);
    if (!parsed) {
      drafts.push(unavailableDraft(file, localDiagnostics));
      continue;
    }
    const filename = posix.basename(file.path);
    const idMatch = /^(\d+)-/.exec(filename);
    const id = idMatch?.[1] ?? filename;
    const metadata = extractMetadata(
      parsed,
      file.text ?? "",
      localDiagnostics,
      file.path,
    );
    const type = normalizeType(metadata, localDiagnostics, file.path);
    const status = normalizeStatus(metadata, localDiagnostics, file.path);
    const claimedBy = singleRaw(metadata, "Claimed by");
    const questionMarkdown = findSection(parsed, "question");
    const answerMarkdown = findSection(parsed, "answer");
    diagnoseAnswerStatus(status, answerMarkdown, localDiagnostics, file.path);
    const scopeMembership = mapLinkInfo.byPath.get(file.path);
    const scope =
      scopeMembership === "both"
        ? "ambiguous"
        : scopeMembership === "out"
          ? "out-of-scope"
          : "in-scope";
    if (scope === "ambiguous") {
      localDiagnostics.push(
        diag(
          "ambiguous-scope",
          "Ticket is linked as both a decision and out of scope.",
          file.path,
        ),
      );
    }
    const titleChoice = chooseTitle(
      parsed.h1,
      mapLinkInfo.titlesByPath.get(file.path),
      filename,
      localDiagnostics,
      file.path,
    );
    const parentConsistent = validateParent(
      metadata,
      file.path,
      snapshot.map.path,
      localDiagnostics,
      parsed,
    );
    drafts.push({
      file,
      parsed,
      id,
      numericId: Number.parseInt(id, 10),
      metadata,
      diagnostics: localDiagnostics,
      status,
      type,
      claimedBy,
      questionMarkdown,
      answerMarkdown,
      scope,
      ...titleChoice,
      parentConsistent,
      blockers: [],
    });
  }

  const pathsById = new Map<string, string[]>();
  for (const draft of drafts) {
    const canonicalId = String(draft.numericId);
    const existing = pathsById.get(canonicalId) ?? [];
    existing.push(draft.file.path);
    pathsById.set(canonicalId, existing);
  }
  for (const [id, paths] of pathsById) {
    if (paths.length <= 1) continue;
    diagnostics.push(
      diag(
        "duplicate-id",
        `Numeric ID ${id} is shared by ${paths.join(", ")}.`,
      ),
    );
    for (const draft of drafts.filter(
      (item) => String(item.numericId) === id,
    )) {
      draft.diagnostics.push(
        diag(
          "duplicate-id",
          `Numeric ID ${id} is not unique.`,
          draft.file.path,
        ),
      );
    }
  }

  const byPath = new Map(drafts.map((draft) => [draft.file.path, draft]));
  for (const draft of drafts) {
    draft.blockers = resolveBlockers(
      draft,
      selectedDirectory,
      byPath,
      pathsById,
    );
    for (const edge of draft.blockers) {
      if (edge.resolution !== "resolved") {
        draft.diagnostics.push(
          diag(
            `blocker-${edge.resolution}`,
            edge.diagnostic ?? `Unresolved blocker: ${edge.raw}`,
            draft.file.path,
          ),
        );
      }
    }
  }

  const sccs = stronglyConnectedComponents(drafts);
  const cyclicPaths = new Set(
    sccs.filter((scc) => scc.cyclic).flatMap((scc) => scc.paths),
  );
  for (const scc of sccs.filter((item) => item.cyclic)) {
    diagnostics.push(
      diag("dependency-cycle", `Dependency cycle: ${scc.paths.join(" -> ")}`),
    );
  }

  const normalized = drafts.map((draft): NormalizedTicket => {
    const metadataInvalid = draft.diagnostics.some((item) =>
      [
        "malformed-metadata",
        "conflicting-metadata",
        "unknown-status",
        "unknown-type",
        "status-answer-inconsistency",
        "parent-contradiction",
        "duplicate-id",
        "ambiguous-scope",
        "source-unavailable",
        "unsupported-format",
      ].includes(item.code),
    );
    const graphInvalid = draft.blockers.some(
      (edge) => edge.resolution !== "resolved",
    );
    const consistent =
      !metadataInvalid &&
      !graphInvalid &&
      draft.parentConsistent &&
      draft.scope === "in-scope" &&
      !cyclicPaths.has(draft.file.path);
    return {
      path: draft.file.path,
      id: draft.id,
      numericId: draft.numericId,
      title: draft.title,
      titleSource: draft.titleSource,
      type: draft.type,
      status: draft.status,
      rawMetadata: Object.fromEntries(
        [...draft.metadata].map(([key, values]) => [
          key,
          values.map((value) => value.raw),
        ]),
      ),
      claimedBy: draft.claimedBy,
      questionMarkdown: draft.questionMarkdown,
      answerMarkdown: draft.answerMarkdown,
      references: draft.parsed.references,
      blockers: draft.blockers,
      scope: draft.scope,
      consistent,
      diagnostics: draft.diagnostics,
    };
  });
  normalized.sort(compareTickets);
  const normalizedByPath = new Map(
    normalized.map((ticket) => [ticket.path, ticket]),
  );
  const knownReadyPaths = normalized
    .filter((ticket) => {
      if (
        ticket.status !== "open" ||
        !ticket.consistent ||
        cyclicPaths.has(ticket.path)
      )
        return false;
      return ticket.blockers.every((edge) => {
        if (edge.resolution !== "resolved" || !edge.targetPath) return false;
        const target = normalizedByPath.get(edge.targetPath);
        return Boolean(
          target &&
          target.status === "resolved" &&
          target.consistent &&
          !cyclicPaths.has(target.path),
        );
      });
    })
    .map((ticket) => ticket.path);
  const complete =
    snapshot.discoveryComplete &&
    mapParsed !== null &&
    !membershipRejected &&
    drafts.length === membership.size &&
    drafts.every(
      (draft) =>
        draft.file.state === "available" &&
        draft.file.text !== undefined &&
        !draft.diagnostics.some(
          (item) =>
            item.code === "source-unavailable" ||
            item.code === "unsupported-format",
        ),
    ) &&
    !diagnostics.some((item) => item.code === "unsupported-format");

  return {
    adapter: "wayfinder-explicit-status/v1",
    source: {
      mapPath: normalizeIdentity(snapshot.map.path),
      selectedDirectory,
      mapState: snapshot.map.state,
      discoveryComplete: complete,
    },
    map: {
      title: mapTitle,
      titleSource: mapParsed?.h1 ? "h1" : "effort-directory",
      sections: mapSections,
      references: mapReferences,
    },
    tickets: normalized,
    outOfScope: normalized
      .filter((ticket) => ticket.scope === "out-of-scope")
      .map((ticket) => ticket.path),
    edges: normalized.flatMap((ticket) => ticket.blockers),
    sccs,
    frontier: {
      complete,
      knownReadyPaths,
      label: complete ? "complete-frontier" : "known-component-readiness",
    },
    diagnostics,
  };
}

function parseAvailable(
  file: SourceFileSnapshot,
  diagnostics: Diagnostic[],
): ParsedMarkdown | null {
  if (file.state !== "available" || file.text === undefined) {
    diagnostics.push(
      diag("source-unavailable", `Source is ${file.state}.`, file.path),
    );
    return null;
  }
  if (/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(file.text))
    diagnostics.push(
      diag(
        "unsupported-format",
        "YAML-frontmatter-derived Wayfinder semantics are unsupported by the explicit-status adapter; Markdown remains inspectable but its graph is not complete.",
        file.path,
      ),
    );
  let root: Root;
  try {
    root = parser.parse(file.text) as Root;
  } catch (error) {
    diagnostics.push(
      diag(
        "source-parse-failed",
        `Markdown parse failed: ${error instanceof Error ? error.message : String(error)}`,
        file.path,
      ),
    );
    return null;
  }
  const definitions = new Map<string, Definition>();
  for (const node of root.children)
    if (node.type === "definition")
      definitions.set(normalizeReferenceIdentifier(node.identifier), node);
  const references = collectReferences(root, definitions, file.path);
  const sections = extractSections(root, file.text);
  const h1Node = root.children.find(
    (node): node is Heading => node.type === "heading" && node.depth === 1,
  );
  return {
    root,
    definitions,
    references,
    sections,
    h1: h1Node ? plainText(h1Node).trim() || null : null,
  };
}

function extractMetadata(
  parsed: ParsedMarkdown,
  source: string,
  diagnostics: Diagnostic[],
  sourcePath: string,
): Map<MetadataField, MetadataValue[]> {
  const result = new Map<MetadataField, MetadataValue[]>();
  for (const node of parsed.root.children) {
    if (node.type === "heading" && node.depth === 2) break;
    if (node.type !== "paragraph") continue;
    const nodeStart = node.position?.start.offset ?? 0;
    const nodeSource = sliceNode(source, node);
    let lineOffset = 0;
    for (const rawLineWithEnding of nodeSource.match(/.*(?:\r?\n|$)/g) ?? []) {
      if (rawLineWithEnding === "") continue;
      const rawLine = rawLineWithEnding.replace(/\r?\n$/, "");
      const line = rawLine.trim();
      const valid =
        /^\s*(Type|Status|Claimed by|Blocked by|Parent)\s*:\s*(.*)$/i.exec(
          rawLine,
        );
      if (valid) {
        const field = canonicalField(valid[1] ?? "");
        if (!field) continue;
        const values = result.get(field) ?? [];
        const raw = valid[2] ?? "";
        const valueStart = nodeStart + lineOffset + rawLine.length - raw.length;
        values.push({
          raw,
          start: valueStart,
          end: nodeStart + lineOffset + rawLine.length,
        });
        result.set(field, values);
      } else {
        const looksMalformed =
          /^(Type|Status|Claimed by|Blocked by|Parent)\b/i.test(line);
        if (looksMalformed)
          diagnostics.push(
            diag(
              "malformed-metadata",
              `Malformed metadata line: ${line}`,
              sourcePath,
            ),
          );
      }
      lineOffset += rawLineWithEnding.length;
    }
  }
  for (const [field, values] of result) {
    const distinct = new Set(
      values.map((value) => value.raw.trim().toLowerCase()),
    );
    if (distinct.size > 1)
      diagnostics.push(
        diag(
          "conflicting-metadata",
          `Conflicting ${field} values are preserved.`,
          sourcePath,
        ),
      );
  }
  return result;
}

function canonicalField(value: string): MetadataField | null {
  return (
    METADATA_FIELDS.find(
      (field) => field.toLowerCase() === value.toLowerCase(),
    ) ?? null
  );
}

function normalizeType(
  metadata: Map<MetadataField, MetadataValue[]>,
  diagnostics: Diagnostic[],
  sourcePath: string,
): string | null {
  const raw = singleRaw(metadata, "Type");
  if (raw === null) {
    diagnostics.push(
      diag("unknown-type", "Type is missing or conflicting.", sourcePath),
    );
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (!KNOWN_TYPES.has(normalized))
    diagnostics.push(
      diag("unknown-type", `Unknown Type value: ${raw}`, sourcePath),
    );
  return normalized;
}

function normalizeStatus(
  metadata: Map<MetadataField, MetadataValue[]>,
  diagnostics: Diagnostic[],
  sourcePath: string,
): NormalizedTicket["status"] {
  const values = metadata.get("Status");
  if (!values) return "open";
  if (new Set(values.map((value) => value.raw.trim().toLowerCase())).size > 1)
    return "unknown";
  const raw = values[0]?.raw.trim().toLowerCase() ?? "";
  if (!KNOWN_STATUSES.has(raw)) {
    diagnostics.push(
      diag(
        "unknown-status",
        `Unknown Status value: ${values[0]?.raw ?? ""}`,
        sourcePath,
      ),
    );
    return "unknown";
  }
  return raw as NormalizedTicket["status"];
}

function diagnoseAnswerStatus(
  status: NormalizedTicket["status"],
  answer: string | null,
  diagnostics: Diagnostic[],
  sourcePath: string,
): void {
  const hasAnswer = Boolean(answer?.trim());
  if (
    (status === "resolved" && !hasAnswer) ||
    ((status === "open" || status === "claimed") && hasAnswer)
  ) {
    diagnostics.push(
      diag(
        "status-answer-inconsistency",
        `Declared status ${status} conflicts with Answer presence.`,
        sourcePath,
      ),
    );
  }
}

function validateParent(
  metadata: Map<MetadataField, MetadataValue[]>,
  sourcePath: string,
  mapPath: string,
  diagnostics: Diagnostic[],
  parsed?: ParsedMarkdown,
): boolean {
  const value = singleValue(metadata, "Parent");
  if (value === null || value.raw.trim() === "") return true;
  const reference = parsed ? linksInRange(parsed, value)[0] : undefined;
  const target =
    (reference ? linkDestination(reference, parsed!.definitions) : null) ??
    value.raw.trim();
  const resolved = resolveLocalIdentity(sourcePath, target);
  if (!resolved || resolved.identity !== normalizeIdentity(mapPath)) {
    diagnostics.push(
      diag(
        "parent-contradiction",
        `Parent does not identify attached map: ${value.raw}`,
        sourcePath,
      ),
    );
    return false;
  }
  return true;
}

function resolveBlockers(
  draft: DraftTicket,
  selectedDirectory: string,
  byPath: Map<string, DraftTicket>,
  pathsById: Map<string, string[]>,
): BlockerEdge[] {
  const raws = draft.metadata.get("Blocked by") ?? [];
  if (
    raws.length === 0 ||
    raws.every(
      (value) =>
        value.raw.trim() === "" || value.raw.trim().toLowerCase() === "none",
    )
  )
    return [];
  const tokens = raws.flatMap((value) =>
    splitBlockerTokens(value, draft.parsed, draft.file.text ?? ""),
  );
  return tokens.map((token) => {
    const destination = token.destination ?? token.raw.trim();
    const navigationTarget = destination;
    if (/^\d+$/.test(destination)) {
      const canonicalId = String(Number.parseInt(destination, 10));
      const candidates = pathsById.get(canonicalId) ?? [];
      if (candidates.length === 1) {
        const target = byPath.get(candidates[0]!);
        return {
          sourcePath: draft.file.path,
          raw: token.raw,
          navigationTarget,
          targetPath: candidates[0]!,
          targetId: target?.id ?? destination,
          resolution: "resolved",
        };
      }
      return {
        sourcePath: draft.file.path,
        raw: token.raw,
        navigationTarget,
        targetId: destination,
        resolution: candidates.length ? "ambiguous" : "missing",
        diagnostic: candidates.length
          ? `Numeric blocker ${destination} is ambiguous.`
          : `Numeric blocker ${destination} is missing.`,
      };
    }
    const resolved = resolveLocalIdentity(draft.file.path, destination);
    if (!resolved)
      return {
        sourcePath: draft.file.path,
        raw: token.raw,
        navigationTarget,
        resolution: "unsupported",
        diagnostic: `Unsupported blocker target: ${destination}`,
      };
    if (posix.dirname(resolved.identity) !== selectedDirectory) {
      return {
        sourcePath: draft.file.path,
        raw: token.raw,
        navigationTarget,
        resolution: "outside",
        diagnostic: `Blocker target is outside selected directory: ${destination}`,
      };
    }
    const target = byPath.get(resolved.identity);
    if (!target)
      return {
        sourcePath: draft.file.path,
        raw: token.raw,
        navigationTarget,
        targetPath: resolved.identity,
        resolution: "missing",
        diagnostic: `Blocker target is not present: ${destination}`,
      };
    return {
      sourcePath: draft.file.path,
      raw: token.raw,
      navigationTarget,
      targetPath: target.file.path,
      targetId: target.id,
      resolution: "resolved",
    };
  });
}

function splitBlockerTokens(
  value: MetadataValue,
  parsed: ParsedMarkdown,
  source: string,
): BlockerToken[] {
  const positioned: Array<{ start: number; token: BlockerToken }> = [];
  const spans: Array<[number, number]> = [];
  for (const node of linksInRange(parsed, value)) {
    const start = node.position!.start.offset! - value.start;
    const end = node.position!.end.offset! - value.start;
    const destination = linkDestination(node, parsed.definitions);
    positioned.push({
      start,
      token: {
        raw: source.slice(
          node.position!.start.offset!,
          node.position!.end.offset!,
        ),
        ...(destination ? { destination } : {}),
      },
    });
    spans.push([start, end]);
  }
  const covered = Array.from(value.raw, () => false);
  for (const [start, end] of spans)
    for (let index = start; index < end; index += 1) covered[index] = true;
  const plainPattern = /[^,;\s]+/g;
  for (const match of value.raw.matchAll(plainPattern)) {
    const start = match.index;
    if (covered[start]) continue;
    const raw = match[0];
    if (raw.toLowerCase() === "none" || raw.toLowerCase() === "and") continue;
    positioned.push({ start, token: { raw } });
  }
  return positioned.sort((a, b) => a.start - b.start).map((item) => item.token);
}

function linksInRange(
  parsed: ParsedMarkdown,
  value: MetadataValue,
): Array<Link | LinkReference> {
  const result: Array<Link | LinkReference> = [];
  walk(parsed.root, (node) => {
    if (node.type !== "link" && node.type !== "linkReference") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      start !== undefined &&
      end !== undefined &&
      start >= value.start &&
      end <= value.end
    )
      result.push(node);
  });
  return result;
}

function classifyMapLinks(
  parsed: ParsedMarkdown | null,
  mapPath: string,
  membership: Map<string, SourceFileSnapshot>,
): {
  byPath: Map<string, "decision" | "out" | "both">;
  titlesByPath: Map<string, string[]>;
  diagnostics: Diagnostic[];
} {
  const byPath = new Map<string, "decision" | "out" | "both">();
  const titlesByPath = new Map<string, string[]>();
  const diagnostics: Diagnostic[] = [];
  if (!parsed) return { byPath, titlesByPath, diagnostics };
  let context: { kind: "decision" | "out"; depth: number } | null = null;
  for (const node of parsed.root.children) {
    if (node.type === "heading") {
      if (node.depth === 1) {
        context = null;
        continue;
      }
      if (context && node.depth > context.depth) continue;
      const heading = plainText(node).toLowerCase();
      context = /out[ -]?of[ -]?scope/.test(heading)
        ? { kind: "out", depth: node.depth }
        : /(decision|scope)/.test(heading)
          ? { kind: "decision", depth: node.depth }
          : null;
      continue;
    }
    if (!context) continue;
    const linkContext = context.kind;
    walk(node, (child) => {
      const destination = linkDestination(child, parsed.definitions);
      if (!destination) return;
      const resolved = resolveLocalIdentity(mapPath, destination);
      if (!resolved || !membership.has(resolved.identity)) return;
      const prior = byPath.get(resolved.identity);
      byPath.set(
        resolved.identity,
        prior && prior !== linkContext ? "both" : linkContext,
      );
      const labels = titlesByPath.get(resolved.identity) ?? [];
      const label = plainText(child).trim();
      if (label) labels.push(label);
      titlesByPath.set(resolved.identity, labels);
    });
  }
  for (const [ticketPath, scope] of byPath) {
    if (scope === "both")
      diagnostics.push(
        diag(
          "ambiguous-scope",
          `Map classifies ${ticketPath} as both decision and out of scope.`,
          ticketPath,
        ),
      );
  }
  return { byPath, titlesByPath, diagnostics };
}

function chooseTitle(
  h1: string | null,
  mapTitles: string[] | undefined,
  filename: string,
  diagnostics: Diagnostic[],
  sourcePath: string,
): Pick<DraftTicket, "title" | "titleSource"> {
  if (h1) return { title: h1, titleSource: "h1" };
  const unique = [
    ...new Set((mapTitles ?? []).map((title) => title.trim()).filter(Boolean)),
  ];
  if (unique.length === 1)
    return { title: unique[0]!, titleSource: "map-link" };
  if (unique.length > 1)
    diagnostics.push(
      diag(
        "ambiguous-map-title",
        "Map provides multiple titles; using filename fallback.",
        sourcePath,
      ),
    );
  return { title: filename, titleSource: "filename" };
}

function collectReferences(
  root: Root,
  definitions: Map<string, Definition>,
  sourcePath: string,
): MarkdownReference[] {
  const result: MarkdownReference[] = [];
  walk(root, (node) => {
    if (node.type !== "link" && node.type !== "linkReference") return;
    const destination = linkDestination(node, definitions);
    if (!destination) {
      result.push({
        sourcePath,
        label: plainText(node),
        destination: "",
        kind: "reference",
        classification: "invalid",
      });
      return;
    }
    const scheme = /^([a-z][a-z\d+.-]*):/i
      .exec(destination)?.[1]
      ?.toLowerCase();
    if (scheme && !["http", "https", "mailto"].includes(scheme)) {
      result.push({
        sourcePath,
        label: plainText(node),
        destination,
        kind: node.type === "link" ? "inline" : "reference",
        classification: "unsafe",
      });
      return;
    }
    if (scheme) {
      result.push({
        sourcePath,
        label: plainText(node),
        destination,
        kind: node.type === "link" ? "inline" : "reference",
        classification: "remote",
      });
      return;
    }
    const resolved = resolveLocalIdentity(sourcePath, destination);
    result.push({
      sourcePath,
      label: plainText(node),
      destination,
      ...(resolved?.fragment ? { fragment: resolved.fragment } : {}),
      ...(resolved?.identity ? { identity: resolved.identity } : {}),
      kind: node.type === "link" ? "inline" : "reference",
      classification: resolved ? "local" : "invalid",
    });
  });
  return result;
}

function extractSections(root: Root, source: string): MarkdownSection[] {
  const headings = root.children.flatMap((node, index) =>
    node.type === "heading" ? [{ node, index }] : [],
  );
  return headings.map(({ node, index }, headingIndex) => {
    const nextHeading = headings
      .slice(headingIndex + 1)
      .find((candidate) => candidate.node.depth <= node.depth)?.node;
    const start = node.position?.end.offset ?? 0;
    const end = nextHeading?.position?.start.offset ?? source.length;
    return {
      heading: plainText(node),
      depth: node.depth,
      markdown: source
        .slice(start, end)
        .replace(/^\r?\n/, "")
        .trimEnd(),
    };
  });
}

function findSection(parsed: ParsedMarkdown, name: string): string | null {
  return (
    parsed.sections.find(
      (section) =>
        section.depth === 2 && section.heading.trim().toLowerCase() === name,
    )?.markdown ?? null
  );
}

function linkDestination(
  node: RootContent | Link | LinkReference,
  definitions: Map<string, Definition>,
): string | null {
  if (node.type === "link") return node.url;
  if (node.type === "linkReference")
    return (
      definitions.get(normalizeReferenceIdentifier(node.identifier))?.url ??
      null
    );
  return null;
}

function normalizeReferenceIdentifier(identifier: string): string {
  return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

function resolveLocalIdentity(
  containingPath: string,
  destination: string,
): { identity: string; fragment?: string } | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith("//"))
    return null;
  const hash = destination.indexOf("#");
  const filePart = decodePath(
    hash >= 0 ? destination.slice(0, hash) : destination,
  );
  if (filePart === null || filePart === "") return null;
  if (posix.isAbsolute(filePart) || filePart.startsWith("\\")) return null;
  const identity = normalizeIdentity(
    posix.join(posix.dirname(normalizeIdentity(containingPath)), filePart),
  );
  const fragment = hash >= 0 ? destination.slice(hash + 1) : undefined;
  return { identity, ...(fragment ? { fragment } : {}) };
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeIdentity(value: string): string {
  return posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function stronglyConnectedComponents(
  drafts: readonly DraftTicket[],
): StronglyConnectedComponent[] {
  const paths = new Set(drafts.map((draft) => draft.file.path));
  const adjacency = new Map(
    drafts.map((draft) => [
      draft.file.path,
      draft.blockers
        .filter(
          (edge) =>
            edge.resolution === "resolved" &&
            edge.targetPath &&
            paths.has(edge.targetPath),
        )
        .map((edge) => edge.targetPath!),
    ]),
  );
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: StronglyConnectedComponent[] = [];
  const visit = (vertex: string): void => {
    indices.set(vertex, nextIndex);
    lowLinks.set(vertex, nextIndex++);
    stack.push(vertex);
    onStack.add(vertex);
    for (const neighbor of adjacency.get(vertex) ?? []) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(
          vertex,
          Math.min(lowLinks.get(vertex)!, lowLinks.get(neighbor)!),
        );
      } else if (onStack.has(neighbor)) {
        lowLinks.set(
          vertex,
          Math.min(lowLinks.get(vertex)!, indices.get(neighbor)!),
        );
      }
    }
    if (lowLinks.get(vertex) !== indices.get(vertex)) return;
    const component: string[] = [];
    let popped: string;
    do {
      popped = stack.pop()!;
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== vertex);
    component.sort();
    const cyclic =
      component.length > 1 ||
      (adjacency.get(component[0]!) ?? []).includes(component[0]!);
    components.push({ paths: component, cyclic });
  };
  for (const draft of drafts)
    if (!indices.has(draft.file.path)) visit(draft.file.path);
  return components.sort((a, b) => a.paths[0]!.localeCompare(b.paths[0]!));
}

function unavailableDraft(
  file: SourceFileSnapshot,
  diagnostics: Diagnostic[],
): DraftTicket {
  const filename = posix.basename(file.path);
  const id = /^(\d+)-/.exec(filename)?.[1] ?? filename;
  return {
    file,
    parsed: {
      root: { type: "root", children: [] },
      definitions: new Map(),
      references: [],
      sections: [],
      h1: null,
    },
    id,
    numericId: Number.parseInt(id, 10),
    metadata: new Map(),
    diagnostics,
    status: "unknown",
    type: null,
    claimedBy: null,
    questionMarkdown: null,
    answerMarkdown: null,
    scope: "in-scope",
    title: filename,
    titleSource: "filename",
    parentConsistent: true,
    blockers: [],
  };
}

function singleValue(
  metadata: Map<MetadataField, MetadataValue[]>,
  field: MetadataField,
): MetadataValue | null {
  const values = metadata.get(field);
  return values?.length === 1 ? values[0]! : null;
}

function singleRaw(
  metadata: Map<MetadataField, MetadataValue[]>,
  field: MetadataField,
): string | null {
  return singleValue(metadata, field)?.raw ?? null;
}

function compareTickets(a: NormalizedTicket, b: NormalizedTicket): number {
  return a.numericId - b.numericId || a.path.localeCompare(b.path);
}

function sliceNode(source: string, node: Paragraph): string {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? start;
  return source.slice(start, end);
}

function plainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as {
    value?: unknown;
    alt?: unknown;
    children?: unknown[];
  };
  if (typeof record.value === "string") return record.value;
  if (Array.isArray(record.children))
    return record.children.map(plainText).join("");
  return typeof record.alt === "string" ? record.alt : "";
}

function walk(
  node: unknown,
  visitor: (node: RootContent | Link | LinkReference) => void,
): void {
  if (!node || typeof node !== "object") return;
  visitor(node as RootContent);
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children))
    for (const child of children) walk(child, visitor);
}

function diag(code: string, message: string, sourcePath?: string): Diagnostic {
  return {
    code,
    message,
    ...(sourcePath ? { path: sourcePath } : {}),
    severity: "error",
  };
}
