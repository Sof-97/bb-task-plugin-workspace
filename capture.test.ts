import { afterEach, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import hostEntry from "./host";
import plugin, { type TaskWorkspaceTestHooks } from "./server";
import { enrollment } from "./contract";
import {
  CAPTURE_BODY_LIMIT,
  CAPTURE_DESCRIPTION_LIMIT,
  CAPTURE_TITLE_LIMIT,
  canonicalCapturePayload,
  capturePayloadHash,
} from "./capture";
import { canonicalJson } from "./archive";
import {
  captureSubmissionBody,
  createCaptureSubmission,
  recordCaptureSuccess,
  retryCaptureExplicitly,
  selectCaptureProject,
  submitCaptureOnce,
  type CaptureClientContext,
} from "./capture-client";

const cleanups: Array<() => Promise<unknown>> = [];
const dailyAttempts: Array<Promise<unknown>> = [];
afterEach(async () => {
  await Promise.allSettled(
    dailyAttempts.splice(0).map((attempt) => attempt.catch(() => undefined)),
  );
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for deterministic test gate.");
}

type ArchiveEnvelope = {
  entries: Array<{ path: string; encoding: string; data: string }>;
  manifest: Record<string, unknown>;
};

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const rebuild = (parsed: ArchiveEnvelope): Uint8Array => {
  const payloadByPath = new Map(
    parsed.entries.map((entry) => [entry.path, entry]),
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
    const payload = payloadByPath.get(entry.path);
    if (!payload) throw new Error(`fixture payload ${entry.path} missing`);
    const bytes = Buffer.from(payload.data, "base64");
    payloadBytes += bytes.byteLength;
    if (entry.type === "records") {
      records += (JSON.parse(bytes.toString("utf8")) as { rows: unknown[] })
        .rows.length;
      tables += 1;
    } else {
      memories += 1;
      memoryBytes += bytes.byteLength;
    }
    return {
      ...entry,
      sha256: sha(bytes),
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

const withoutEntry = (bytes: Uint8Array, path: string): Uint8Array => {
  const parsed = JSON.parse(
    Buffer.from(bytes).toString("utf8"),
  ) as ArchiveEnvelope;
  parsed.entries = parsed.entries.filter((entry) => entry.path !== path);
  parsed.manifest.entries = (
    parsed.manifest.entries as Array<{ path: string }>
  ).filter((entry) => entry.path !== path);
  return rebuild(parsed);
};

async function fixture(extraHooks: TaskWorkspaceTestHooks = {}) {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-capture-"));
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
  let projectPresent = true;
  let discoveryFails = false;
  let hostConnected = true;
  let initFailures = 0;
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
  const connectedHost = {
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
        list: async () => {
          if (discoveryFails) throw Error("BB discovery unavailable");
          return projectPresent ? [project] : [];
        },
      },
      hosts: {
        list: async () => [
          {
            ...connectedHost,
            status: hostConnected ? "connected" : "disconnected",
          },
        ],
      },
      threads: {
        spawn: async () => {
          throw Error("capture must never spawn a thread");
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "validateRepository" || method === "inspectRepository")
        return {
          repository: (input as { repository: string }).repository,
          version: "fixture",
        };
      if (method === "initializeMemory" && initFailures > 0) {
        initFailures -= 1;
        throw Error("Injected memory initialization failure");
      }
      return worker.experimental_call(method as never, input as never);
    },
  });
  await plugin(bb, {
    onDailyAttempt: (attempt) => dailyAttempts.push(attempt),
    ...extraHooks,
  });
  const call = harness.behavior.callRpc;
  const enrolled = enrollment.parse(
    await call("enroll", {
      projectId: "project-1",
      sourceId: "source-1",
      prefix: "cap",
    }),
  );
  const db = bb.storage.database();
  const dirs = () => {
    const row = db.prepare("SELECT id FROM dataset").get() as { id: string };
    return {
      datasetId: row.id,
      datasetsRoot: join(root, "host", "datasets"),
    };
  };
  const auth = { "x-bb-plugin-token": "fixture-token" };
  const postCapture = (body: string, headers: Record<string, string> = auth) =>
    harness.behavior.fetchHttp("POST", "/capture/v1/tasks", {
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const getProjects = (
    headers?: Record<string, string>,
    path = "/capture/v1/projects",
  ) =>
    harness.behavior.fetchHttp("GET", path, {
      headers: headers ?? auth,
    });
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const submission = (overrides: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    datasetEpoch: dirs().datasetId,
    projectId: "project-1",
    title: "Captured task",
    description: "Some Markdown",
    ...overrides,
  });
  return {
    root,
    call,
    db,
    enrolled,
    dirs,
    auth,
    postCapture,
    getProjects,
    count,
    submission,
    setProjectPresent: (value: boolean) => (projectPresent = value),
    setDiscoveryFails: (value: boolean) => (discoveryFails = value),
    setHostConnected: (value: boolean) => (hostConnected = value),
    setInitFailures: (value: number) => (initFailures = value),
  };
}

type Envelope = {
  apiVersion: number;
  datasetEpoch: string;
  requestId: string;
  replayed: boolean;
  receipt: {
    taskUuid: string;
    displayId: string;
    projectId: string;
    status: string;
    createdAt: string;
  };
};

test("discovery returns enrolled project identity and never leaks memory or transcripts", async () => {
  const f = await fixture();
  const missingToken = await f.getProjects({});
  expect(missingToken.status).toBe(401);
  const queryToken = await f.getProjects(
    { "x-bb-plugin-token": "fixture-token" },
    "/capture/v1/projects?token=fixture-token",
  );
  expect(queryToken.status).toBe(401);
  const response = await f.getProjects();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    apiVersion: number;
    datasetEpoch: string;
    projects: Array<{
      enrollmentId: string;
      projectId: string;
      name: string;
      prefix: string;
      available: boolean;
      unavailableReason: string | null;
    }>;
  };
  expect(body.apiVersion).toBe(1);
  expect(body.datasetEpoch).toBe(f.dirs().datasetId);
  expect(body.projects).toHaveLength(1);
  expect(body.projects[0]).toMatchObject({
    enrollmentId: f.enrolled.id,
    projectId: "project-1",
    prefix: "CAP",
    available: true,
    unavailableReason: null,
  });
  expect(JSON.stringify(body)).not.toContain("fixture-token");
  expect(JSON.stringify(body)).not.toContain("memory");
});

test("discovery marks confirmed-missing, host-down and discovery-failure entries unavailable with reasons", async () => {
  const f = await fixture();
  f.setProjectPresent(false);
  let body = (await (await f.getProjects()).json()) as {
    projects: Array<{ available: boolean; unavailableReason: string }>;
  };
  expect(body.projects[0]!.available).toBe(false);
  expect(body.projects[0]!.unavailableReason).toMatch(/confirmed missing/i);

  f.setProjectPresent(true);
  f.setHostConnected(false);
  body = (await (await f.getProjects()).json()) as typeof body;
  expect(body.projects[0]!.available).toBe(false);
  expect(body.projects[0]!.unavailableReason).toMatch(/host is not connected/i);

  f.setHostConnected(true);
  f.setDiscoveryFails(true);
  body = (await (await f.getProjects()).json()) as typeof body;
  expect(body.projects[0]!.available).toBe(false);
  expect(body.projects[0]!.unavailableReason).toMatch(
    /discovery is temporarily unavailable/i,
  );
});

test("capture validation rejects malformed, unknown, oversized and non-JSON bodies before allocating", async () => {
  const f = await fixture();
  const cases: Array<{
    label: string;
    run: () => Promise<Response>;
    status: number;
    code: string;
    field?: string;
  }> = [
    {
      label: "wrong content type",
      run: () =>
        f.postCapture(JSON.stringify(f.submission()), {
          ...f.auth,
          "content-type": "text/plain",
        }),
      status: 400,
      code: "VALIDATION_ERROR",
      field: "content-type",
    },
    {
      label: "malformed JSON",
      run: () => f.postCapture("{not json"),
      status: 400,
      code: "VALIDATION_ERROR",
    },
    {
      label: "missing requestId",
      run: () =>
        f.postCapture(
          JSON.stringify({ ...f.submission(), requestId: undefined }),
        ),
      status: 400,
      code: "VALIDATION_ERROR",
      field: "requestId",
    },
    {
      label: "unknown field",
      run: () =>
        f.postCapture(
          JSON.stringify({ ...f.submission(), status: "Completed" }),
        ),
      status: 400,
      code: "VALIDATION_ERROR",
    },
    {
      label: "empty title",
      run: () => f.postCapture(JSON.stringify(f.submission({ title: "   " }))),
      status: 400,
      code: "VALIDATION_ERROR",
      field: "title",
    },
    {
      label: "multiline title",
      run: () =>
        f.postCapture(JSON.stringify(f.submission({ title: "one\ntwo" }))),
      status: 400,
      code: "VALIDATION_ERROR",
      field: "title",
    },
    {
      label: "title over 300 code points",
      run: () =>
        f.postCapture(
          JSON.stringify(
            f.submission({ title: "😀".repeat(CAPTURE_TITLE_LIMIT + 1) }),
          ),
        ),
      status: 400,
      code: "VALIDATION_ERROR",
      field: "title",
    },
    {
      label: "description over 64 KiB",
      run: () =>
        f.postCapture(
          JSON.stringify(
            f.submission({
              description: "é".repeat(CAPTURE_DESCRIPTION_LIMIT / 2 + 1),
            }),
          ),
        ),
      status: 400,
      code: "VALIDATION_ERROR",
      field: "description",
    },
    {
      label: "body over 80 KiB",
      run: () =>
        f.postCapture(
          JSON.stringify(
            f.submission({ description: "x".repeat(CAPTURE_BODY_LIMIT) }),
          ),
        ),
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    },
    {
      label: "invalid dataset epoch",
      run: () =>
        f.postCapture(JSON.stringify(f.submission({ datasetEpoch: "nope" }))),
      status: 400,
      code: "VALIDATION_ERROR",
      field: "datasetEpoch",
    },
  ];
  for (const item of cases) {
    const response = await item.run();
    expect(response.status, item.label).toBe(item.status);
    const body = (await response.json()) as {
      error: { code: string; field?: string; message: string };
    };
    expect(body.error.code, item.label).toBe(item.code);
    if (item.field) expect(body.error.field, item.label).toBe(item.field);
    expect(JSON.stringify(body)).not.toContain("Captured task");
  }
  expect(f.count("tasks")).toBe(0);
  expect(f.count("capture_requests")).toBe(0);
});

test("capture accepts atomically, replays identical duplicates and conflicts on changed content", async () => {
  const f = await fixture();
  const request = f.submission({
    requestId: randomUUID(),
    title: "First capture",
  });
  const created = await f.postCapture(JSON.stringify(request));
  expect(created.status).toBe(201);
  const envelope = (await created.json()) as Envelope;
  expect(envelope.apiVersion).toBe(1);
  expect(envelope.replayed).toBe(false);
  expect(envelope.receipt.status).toBe("Inbox");
  expect(envelope.receipt.displayId).toBe("CAP-1");
  expect(envelope.receipt.projectId).toBe("project-1");
  expect(f.count("tasks")).toBe(1);

  const replay = await f.postCapture(JSON.stringify(request));
  expect(replay.status).toBe(200);
  const replayed = (await replay.json()) as Envelope;
  expect(replayed.replayed).toBe(true);
  expect(replayed.receipt).toEqual(envelope.receipt);
  expect(f.count("tasks")).toBe(1);

  const conflict = await f.postCapture(
    JSON.stringify({ ...request, title: "Changed content" }),
  );
  expect(conflict.status).toBe(409);
  expect(
    ((await conflict.json()) as { error: { code: string } }).error.code,
  ).toBe("REQUEST_ID_CONFLICT");
  expect(f.count("tasks")).toBe(1);

  const simultaneous = f.submission({
    requestId: randomUUID(),
    title: "Concurrent",
  });
  const [left, right] = await Promise.all([
    f.postCapture(JSON.stringify(simultaneous)),
    f.postCapture(JSON.stringify(simultaneous)),
  ]);
  const statuses = [left.status, right.status].sort();
  expect(statuses).toEqual([200, 201]);
  const leftBody = (await left.json()) as Envelope;
  const rightBody = (await right.json()) as Envelope;
  expect(leftBody.receipt.taskUuid).toBe(rightBody.receipt.taskUuid);
  expect(f.count("tasks")).toBe(2);
  expect(f.count("capture_requests")).toBe(2);
  const enrollmentRow = f.db
    .prepare("SELECT nextNumber FROM enrollments WHERE id=?")
    .get(f.enrolled.id) as { nextNumber: number };
  expect(enrollmentRow.nextNumber).toBe(3);
});

test("interrupted initialization keeps the allocated task identity and is recovered by an explicit retry", async () => {
  const f = await fixture();
  f.setInitFailures(1);
  const request = f.submission({
    requestId: randomUUID(),
    title: "Interrupted",
  });
  const pending = await f.postCapture(JSON.stringify(request));
  expect(pending.status).toBe(503);
  const pendingBody = (await pending.json()) as {
    error: { code: string; retryable: boolean };
    requestId: string;
  };
  expect(pendingBody.error.code).toBe("CAPTURE_PENDING");
  expect(pendingBody.error.retryable).toBe(true);
  expect(pendingBody.requestId).toBe(request.requestId);
  expect(f.count("tasks")).toBe(1);
  const taskRow = f.db
    .prepare("SELECT id,memoryState,memoryRevision FROM tasks")
    .get() as { id: string; memoryState: string; memoryRevision: number };
  expect(taskRow.memoryState).not.toBe("healthy");
  expect(taskRow.memoryRevision).toBe(0);
  const requestRow = f.db
    .prepare("SELECT state FROM capture_requests")
    .get() as { state: string };
  expect(requestRow.state).toBe("allocated");

  const retried = await f.postCapture(JSON.stringify(request));
  expect(retried.status).toBe(201);
  const recovered = (await retried.json()) as Envelope;
  expect(recovered.receipt.taskUuid).toBe(taskRow.id);
  expect(recovered.receipt.displayId).toBe("CAP-1");
  const after = f.db
    .prepare("SELECT memoryState FROM tasks WHERE id=?")
    .get(taskRow.id) as { memoryState: string };
  expect(after.memoryState).toBe("healthy");
  expect(f.count("tasks")).toBe(1);
});

test("the accepted creation receipt is immutable and replay survives later edits and project disappearance", async () => {
  const f = await fixture();
  const request = f.submission({ requestId: randomUUID(), title: "Immutable" });
  const created = await f.postCapture(JSON.stringify(request));
  const envelope = (await created.json()) as Envelope;

  await f.call("setStatus", {
    id: envelope.receipt.taskUuid,
    datasetEpoch: f.dirs().datasetId,
    expectedRevision: 1,
    status: "Completed",
    blockerReason: null,
  });
  const replay = await f.postCapture(JSON.stringify(request));
  expect(replay.status).toBe(200);
  const replayed = (await replay.json()) as Envelope;
  expect(replayed.receipt).toEqual(envelope.receipt);
  expect(replayed.receipt.status).toBe("Inbox");

  f.setProjectPresent(false);
  const afterDisappear = await f.postCapture(JSON.stringify(request));
  expect(afterDisappear.status).toBe(200);
  expect(((await afterDisappear.json()) as Envelope).replayed).toBe(true);

  const freshMissing = await f.postCapture(
    JSON.stringify(f.submission({ title: "Missing project" })),
  );
  expect(freshMissing.status).toBe(409);
  const missingBody = (await freshMissing.json()) as {
    error: { code: string };
  };
  expect(missingBody.error.code).toBe("PROJECT_UNAVAILABLE");
});

test("a temporary discovery failure is retryable 503 while a confirmed missing project is 409", async () => {
  const f = await fixture();
  f.setDiscoveryFails(true);
  const lookup = await f.postCapture(
    JSON.stringify(f.submission({ title: "Lookup fails" })),
  );
  expect(lookup.status).toBe(503);
  const lookupBody = (await lookup.json()) as {
    error: { code: string; retryable: boolean };
  };
  expect(lookupBody.error.code).toBe("PROJECT_UNAVAILABLE");
  expect(lookupBody.error.retryable).toBe(true);

  f.setDiscoveryFails(false);
  f.setHostConnected(false);
  const hostDown = await f.postCapture(
    JSON.stringify(f.submission({ title: "Host down" })),
  );
  expect(hostDown.status).toBe(503);
  expect(
    ((await hostDown.json()) as { error: { code: string } }).error.code,
  ).toBe("PROJECT_UNAVAILABLE");
  expect(f.count("tasks")).toBe(0);
});

test("a stale epoch is rejected with DATASET_CHANGED even when the request was accepted", async () => {
  const f = await fixture();
  const request = f.submission({ requestId: randomUUID(), title: "Accepted" });
  await f.postCapture(JSON.stringify(request));
  const stale = await f.postCapture(
    JSON.stringify({ ...request, datasetEpoch: randomUUID() }),
  );
  expect(stale.status).toBe(409);
  const body = (await stale.json()) as {
    error: { code: string };
    requestId: string;
  };
  expect(body.error.code).toBe("DATASET_CHANGED");
  expect(body.requestId).toBe(request.requestId);
  expect(f.count("tasks")).toBe(1);
});

test("capture has no branch, thread or status side effects", async () => {
  const f = await fixture();
  const response = await f.postCapture(
    JSON.stringify(
      f.submission({ requestId: randomUUID(), title: "No side effects" }),
    ),
  );
  const envelope = (await response.json()) as Envelope;
  const row = f.db
    .prepare("SELECT status,workflowStatus,memoryState FROM tasks WHERE id=?")
    .get(envelope.receipt.taskUuid) as {
    status: string;
    workflowStatus: string;
    memoryState: string;
  };
  expect(row).toEqual({
    status: "Inbox",
    workflowStatus: "Inbox",
    memoryState: "healthy",
  });
  const prep = f.db
    .prepare(
      "SELECT branchName,parentBranchName,environmentId FROM repository_workspaces WHERE taskId=?",
    )
    .get(envelope.receipt.taskUuid) as {
    branchName: string | null;
    parentBranchName: string | null;
    environmentId: string | null;
  };
  expect(prep).toEqual({
    branchName: null,
    parentBranchName: null,
    environmentId: null,
  });
  expect(f.count("thread_links")).toBe(0);
  expect(f.count("thread_start_operations")).toBe(0);
  expect(f.count("task_relationships")).toBe(0);
});

test("canonical payload hashing ignores JSON property order and separates distinct content", () => {
  const base = { projectId: "project-1", title: "Title", description: "Body" };
  const reordered = {
    description: "Body",
    projectId: "project-1",
    title: "Title",
  };
  expect(canonicalCapturePayload(base)).toBe(
    canonicalCapturePayload(reordered),
  );
  expect(capturePayloadHash(base)).toBe(capturePayloadHash(reordered));
  expect(capturePayloadHash(base)).toMatch(/^[a-f0-9]{64}$/);
  expect(capturePayloadHash(base)).not.toBe(
    capturePayloadHash({ ...base, title: "Title " }),
  );
  expect(capturePayloadHash({ ...base, description: "" })).not.toBe(
    capturePayloadHash(base),
  );
});

test("schema-11 archives carry capture records and restore quarantines a restored pending request under a fresh epoch", async () => {
  const f = await fixture();
  const accepted = f.submission({
    requestId: randomUUID(),
    title: "Accepted task",
  });
  await f.postCapture(JSON.stringify(accepted));
  const archivePath = join(f.root, "snapshot.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const original = await readFile(archivePath);

  // Craft the archived request row into a pending allocated request that still
  // references its original restored task; the creation receipt is absent.
  const crafted = withTable(original, "capture_requests", (rows) => {
    expect(rows).toHaveLength(1);
    rows[0]!.state = "allocated";
    rows[0]!.receiptJson = null;
    rows[0]!.error = null;
  });
  const craftedPath = join(f.root, "pending.task-workspace.json");
  await writeFile(craftedPath, crafted);

  const before = f.dirs().datasetId;
  const preview = (await f.call("previewRestore", { path: craftedPath })) as {
    digest: string;
    schemaVersion: number;
    counts: { tasks: number };
  };
  expect(preview.schemaVersion).toBe(11);
  const result = (await f.call("restoreDataset", {
    path: craftedPath,
    expectedDigest: preview.digest,
    currentDatasetEpoch: before,
    confirmReplace: true,
  })) as { datasetEpoch: string; restoredCounts: { tasks: number } };
  expect(result.datasetEpoch).not.toBe(before);
  expect(result.restoredCounts.tasks).toBe(1);

  const restoredRequest = f.db
    .prepare(
      "SELECT datasetEpoch,state,taskId,receiptJson FROM capture_requests",
    )
    .get() as {
    datasetEpoch: string;
    state: string;
    taskId: string;
    receiptJson: string | null;
  };
  expect(restoredRequest.datasetEpoch).toBe(before);
  expect(restoredRequest.state).toBe("recovery-required");
  expect(restoredRequest.receiptJson).toBeNull();
  const restoredTask = f.db
    .prepare("SELECT id,memoryState FROM tasks")
    .get() as { id: string; memoryState: string };
  expect(restoredTask.id).toBe(restoredRequest.taskId);
  expect(restoredTask.memoryState).toBe("healthy");

  // The old epoch stays rejected even though its request and task were restored.
  const stale = await f.postCapture(
    JSON.stringify({ ...accepted, datasetEpoch: before }),
  );
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
    "DATASET_CHANGED",
  );
  expect(f.count("tasks")).toBe(1);
});

test("a schema-11 archive carrying a quarantined capture request stays restorable under a later fresh epoch without replay", async () => {
  const f = await fixture();
  const accepted = f.submission({
    requestId: randomUUID(),
    title: "Quarantine cycle",
  });
  await f.postCapture(JSON.stringify(accepted));
  const archivePath = join(f.root, "q1.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  // Craft a pending allocated request so the first restore quarantines it.
  const pending = withTable(
    await readFile(archivePath),
    "capture_requests",
    (rows) => {
      expect(rows).toHaveLength(1);
      rows[0]!.state = "allocated";
      rows[0]!.receiptJson = null;
      rows[0]!.error = null;
    },
  );
  const pendingPath = join(f.root, "q-pending.task-workspace.json");
  await writeFile(pendingPath, pending);
  const firstEpoch = f.dirs().datasetId;
  const firstPreview = (await f.call("previewRestore", {
    path: pendingPath,
  })) as { digest: string };
  const first = (await f.call("restoreDataset", {
    path: pendingPath,
    expectedDigest: firstPreview.digest,
    currentDatasetEpoch: firstEpoch,
    confirmReplace: true,
  })) as { datasetEpoch: string };
  expect(first.datasetEpoch).not.toBe(firstEpoch);
  expect(
    (
      f.db.prepare("SELECT state FROM capture_requests").get() as {
        state: string;
      }
    ).state,
  ).toBe("recovery-required");

  // A backup taken after that restore carries the quarantined row and must
  // itself remain a valid restore source under yet another fresh epoch.
  const secondPath = join(f.root, "q2.task-workspace.json");
  await f.call("exportBackup", { destination: secondPath });
  const secondPreview = (await f.call("previewRestore", {
    path: secondPath,
  })) as { digest: string; schemaVersion: number };
  expect(secondPreview.schemaVersion).toBe(11);
  const second = (await f.call("restoreDataset", {
    path: secondPath,
    expectedDigest: secondPreview.digest,
    currentDatasetEpoch: first.datasetEpoch,
    confirmReplace: true,
  })) as { datasetEpoch: string };
  expect(second.datasetEpoch).not.toBe(first.datasetEpoch);
  expect(
    (
      f.db.prepare("SELECT state FROM capture_requests").get() as {
        state: string;
      }
    ).state,
  ).toBe("recovery-required");
  expect(f.count("tasks")).toBe(1);
  // No forbidden replay: the quarantined request stays under its original
  // epoch and is rejected there rather than resurfacing as success.
  const stale = await f.postCapture(
    JSON.stringify({ ...accepted, datasetEpoch: firstEpoch }),
  );
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
    "DATASET_CHANGED",
  );
  expect(f.count("tasks")).toBe(1);
});

test("restore refuses an archive whose capture record references a missing task, allocating nothing", async () => {
  const f = await fixture();
  await f.postCapture(
    JSON.stringify(f.submission({ requestId: randomUUID(), title: "Keep" })),
  );
  const archivePath = join(f.root, "missing.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const crafted = withTable(
    await readFile(archivePath),
    "capture_requests",
    (rows) => {
      rows[0]!.taskId = randomUUID();
    },
  );
  const craftedPath = join(f.root, "missing-craft.task-workspace.json");
  await writeFile(craftedPath, crafted);
  await expect(f.call("previewRestore", { path: craftedPath })).rejects.toThrow(
    /capture request references an unknown task/i,
  );
  expect(f.count("tasks")).toBe(1);
});

test("archives include capture_requests records and exclude token material", async () => {
  const f = await fixture();
  const request = f.submission({
    requestId: randomUUID(),
    title: "Archive me",
  });
  await f.postCapture(JSON.stringify(request));
  const archivePath = join(f.root, "archived.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const parsed = JSON.parse(
    (await readFile(archivePath)).toString("utf8"),
  ) as ArchiveEnvelope;
  const captureEntry = parsed.entries.find(
    (entry) => entry.path === "records/capture_requests.json",
  );
  expect(captureEntry).toBeTruthy();
  const captureRows = JSON.parse(
    Buffer.from(captureEntry!.data, "base64").toString("utf8"),
  ) as { rows: Array<{ requestId: string; state: string }> };
  expect(captureRows.rows[0]!.requestId).toBe(request.requestId);
  expect(captureRows.rows[0]!.state).toBe("accepted");
  const text = JSON.stringify(parsed);
  expect(text).not.toContain("fixture-token");
});

const projectRow = (
  projectId: string,
  available = true,
): {
  enrollmentId: string;
  projectId: string;
  name: string;
  prefix: string;
  available: boolean;
  unavailableReason: string | null;
} => ({
  enrollmentId: `enr-${projectId}`,
  projectId,
  name: `Project ${projectId}`,
  prefix: projectId.toUpperCase(),
  available,
  unavailableReason: available ? null : "unavailable",
});

test("client preselection is explicit current, then last-successful, then required selection", () => {
  const rows = [projectRow("a"), projectRow("b", false)];
  expect(
    selectCaptureProject(rows, {
      currentProjectId: "b",
      lastSuccessfulProjectId: "a",
    }),
  ).toEqual({ kind: "preselected", projectId: "b", source: "current" });
  expect(
    selectCaptureProject(rows, {
      currentProjectId: null,
      lastSuccessfulProjectId: "b",
    }),
  ).toEqual({ kind: "preselected", projectId: "b", source: "last-successful" });
  expect(
    selectCaptureProject(rows, {
      currentProjectId: null,
      lastSuccessfulProjectId: "missing",
    }),
  ).toEqual({ kind: "requires-selection" });
  expect(
    selectCaptureProject([projectRow("only")], {
      currentProjectId: null,
      lastSuccessfulProjectId: null,
    }),
  ).toEqual({ kind: "requires-selection" });
  // A current context that is not enrolled falls through to last-successful,
  // but an unavailable last-successful is still selected without redirecting.
  expect(
    selectCaptureProject(rows, {
      currentProjectId: "gone",
      lastSuccessfulProjectId: "a",
    }),
  ).toEqual({ kind: "preselected", projectId: "a", source: "last-successful" });
});

test("client keeps one exact submission identity across explicit retries and never auto-replaces it", async () => {
  let sequence = 0;
  const submission = createCaptureSubmission(
    { projectId: "project-1", title: "  Trimmed  ", description: "" },
    "epoch-1",
    () => `id-${(sequence += 1)}`,
  );
  expect(submission.requestId).toBe("id-1");
  expect(submission.title).toBe("Trimmed");
  const firstBody = captureSubmissionBody(submission);
  expect(firstBody).toBe(captureSubmissionBody(submission));
  expect(firstBody).not.toContain("description");

  const failing = () => Promise.reject(new Error("connection refused"));
  const failure = await submitCaptureOnce(failing, submission);
  expect(failure.ok).toBe(false);
  if (failure.ok) throw new Error("unreachable");
  expect(failure.error.code).toBe("TRANSPORT_FAILURE");
  expect(failure.error.retryable).toBe(true);
  const retried = await retryCaptureExplicitly(failing, submission);
  expect(retried.ok).toBe(false);
  expect(submission.requestId).toBe("id-1");
  expect(submission.datasetEpoch).toBe("epoch-1");

  const shown: Array<{ method: string; path: string; body: string | null }> =
    [];
  const transport = async (
    method: "GET" | "POST",
    path: string,
    body: string | null,
  ) => {
    shown.push({ method, path, body });
    return {
      status: 200,
      json: {
        apiVersion: 1,
        datasetEpoch: "epoch-1",
        requestId: "id-1",
        replayed: true,
        receipt: {
          taskUuid: randomUUID(),
          displayId: "CAP-1",
          projectId: "project-1",
          status: "Inbox",
          createdAt: "2026-09-12T00:00:00.000Z",
        },
      },
    };
  };
  const accepted = await retryCaptureExplicitly(transport, submission);
  expect(accepted.ok).toBe(true);
  expect(shown[0]!.method).toBe("POST");
  expect(shown[0]!.path).toBe("/capture/v1/tasks");
  expect(shown[0]!.body).toBe(firstBody);

  const context: CaptureClientContext = {
    currentProjectId: null,
    lastSuccessfulProjectId: null,
  };
  expect(
    recordCaptureSuccess(context, submission).lastSuccessfulProjectId,
  ).toBe("project-1");
  expect(context.lastSuccessfulProjectId).toBeNull();
});

test("a schema-10 archive is still restored and clears capture_requests under the fresh epoch", async () => {
  const f = await fixture();
  await f.postCapture(
    JSON.stringify(
      f.submission({ requestId: randomUUID(), title: "Old schema" }),
    ),
  );
  const archivePath = join(f.root, "eleven.task-workspace.json");
  await f.call("exportBackup", { destination: archivePath });
  const original = await readFile(archivePath);
  const baseline = withoutEntry(
    withTable(original, "bb_migrations", (rows) => {
      rows.splice(10);
    }),
    "records/capture_requests.json",
  );
  const downgradedParsed = JSON.parse(
    Buffer.from(baseline).toString("utf8"),
  ) as ArchiveEnvelope;
  downgradedParsed.manifest.schemaVersion = 10;
  const downgraded = rebuild(downgradedParsed);
  const downgradedPath = join(f.root, "ten.task-workspace.json");
  await writeFile(downgradedPath, downgraded);
  const preview = (await f.call("previewRestore", {
    path: downgradedPath,
  })) as {
    digest: string;
    schemaVersion: number;
    warnings: string[];
  };
  expect(preview.schemaVersion).toBe(10);
  expect(preview.warnings.some((w) => /migrated to schema 11/.test(w))).toBe(
    true,
  );
  const before = f.dirs().datasetId;
  const result = (await f.call("restoreDataset", {
    path: downgradedPath,
    expectedDigest: preview.digest,
    currentDatasetEpoch: before,
    confirmReplace: true,
  })) as { datasetEpoch: string; restoredCounts: { tasks: number } };
  expect(result.datasetEpoch).not.toBe(before);
  expect(result.restoredCounts.tasks).toBe(1);
  expect(f.count("capture_requests")).toBe(0);
  expect(f.count("tasks")).toBe(1);
});

const memoryPathFor = (
  f: Awaited<ReturnType<typeof fixture>>,
  taskId: string,
) => join(f.dirs().datasetsRoot, f.dirs().datasetId, "memory", `${taskId}.md`);

test("accepted replay returns RECOVERY_REQUIRED when the referenced task is missing", async () => {
  const f = await fixture();
  const request = f.submission({
    requestId: randomUUID(),
    title: "Missing task",
  });
  const created = await f.postCapture(JSON.stringify(request));
  const envelope = (await created.json()) as Envelope;
  f.db.pragma("foreign_keys = OFF");
  try {
    f.db.prepare("DELETE FROM tasks WHERE id=?").run(envelope.receipt.taskUuid);
  } finally {
    f.db.pragma("foreign_keys = ON");
  }
  const replay = await f.postCapture(JSON.stringify(request));
  expect(replay.status).toBe(409);
  expect(
    ((await replay.json()) as { error: { code: string } }).error.code,
  ).toBe("RECOVERY_REQUIRED");
});

test("accepted replay returns RECOVERY_REQUIRED when canonical memory is missing, never a replacement task", async () => {
  const f = await fixture();
  const request = f.submission({
    requestId: randomUUID(),
    title: "Missing memory",
  });
  const created = await f.postCapture(JSON.stringify(request));
  const envelope = (await created.json()) as Envelope;
  await rm(memoryPathFor(f, envelope.receipt.taskUuid), { force: true });
  const replay = await f.postCapture(JSON.stringify(request));
  expect(replay.status).toBe(409);
  expect(
    ((await replay.json()) as { error: { code: string } }).error.code,
  ).toBe("RECOVERY_REQUIRED");
  expect(f.count("tasks")).toBe(1);
});

test("accepted replay refuses externally changed memory instead of silently accepting the bytes", async () => {
  const f = await fixture();
  const request = f.submission({
    requestId: randomUUID(),
    title: "External bytes",
  });
  const created = await f.postCapture(JSON.stringify(request));
  const envelope = (await created.json()) as Envelope;
  await writeFile(
    memoryPathFor(f, envelope.receipt.taskUuid),
    "external bytes\n",
  );
  const replay = await f.postCapture(JSON.stringify(request));
  expect(replay.status).toBe(409);
  const body = (await replay.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("RECOVERY_REQUIRED");
  expect(body.error.message).toMatch(/memory/i);
  expect(f.count("tasks")).toBe(1);
});

test("accepted replay after a legitimate memory save returns the original immutable receipt", async () => {
  const f = await fixture();
  const request = f.submission({
    requestId: randomUUID(),
    title: "Legit edit",
  });
  const created = await f.postCapture(JSON.stringify(request));
  const envelope = (await created.json()) as Envelope;
  const before = (await f.call("readMemory", {
    id: envelope.receipt.taskUuid,
  })) as {
    state: string;
    token: { datasetEpoch: string; memoryRevision: number; memoryHash: string };
  };
  expect(before.state).toBe("healthy");
  const save = (await f.call("saveMemory", {
    id: envelope.receipt.taskUuid,
    operationId: randomUUID(),
    token: before.token,
    content: "# Legitimately edited\n",
  })) as { outcome: string };
  expect(save.outcome).toBe("saved");

  const replay = await f.postCapture(JSON.stringify(request));
  expect(replay.status).toBe(200);
  const replayed = (await replay.json()) as Envelope;
  expect(replayed.replayed).toBe(true);
  expect(replayed.receipt).toEqual(envelope.receipt);
  expect(replayed.receipt.status).toBe("Inbox");
  const taskRow = f.db
    .prepare("SELECT memoryRevision,memoryState FROM tasks WHERE id=?")
    .get(envelope.receipt.taskUuid) as {
    memoryRevision: number;
    memoryState: string;
  };
  expect(taskRow.memoryState).toBe("healthy");
  expect(taskRow.memoryRevision).toBeGreaterThan(before.token.memoryRevision);
  expect(f.count("tasks")).toBe(1);
});

test("discovery reads the dataset epoch inside the admitted mutation so restored rows cannot pair with a stale epoch", async () => {
  let reached = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    captureDiscoveryGate: () => {
      reached = true;
      return gate;
    },
  });
  const pending = f.getProjects();
  await waitUntil(() => reached);
  const nextEpoch = randomUUID();
  const nextEnrollment = randomUUID();
  const at = new Date().toISOString();
  f.db.prepare("DELETE FROM enrollments").run();
  f.db.prepare("UPDATE dataset SET id=?").run(nextEpoch);
  f.db
    .prepare(
      "INSERT INTO enrollments(id,projectId,hostId,repository,name,prefix,nextNumber,revision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      nextEnrollment,
      "project-1",
      "host-1",
      "/fixture",
      "Restored",
      "RST",
      1,
      1,
      at,
      at,
    );
  release();
  const response = await pending;
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    datasetEpoch: string;
    projects: Array<{ enrollmentId: string }>;
  };
  expect(body.datasetEpoch).toBe(nextEpoch);
  expect(body.projects).toHaveLength(1);
  expect(body.projects[0]!.enrollmentId).toBe(nextEnrollment);
});
