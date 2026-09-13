// @vitest-environment jsdom
import { expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import server from "./server";
import type {
  NewThreadRequestPayload,
  StartOperation,
  Task,
  ThreadCandidate,
  WayfinderSourceRead,
  WayfinderView,
} from "./contract";

type UiStartSubmission = {
  id: string;
  operationId: string;
  datasetEpoch: string;
  expectedTaskRevision: number;
  expectedLinkContext: Array<{ threadId: string; linkRevision: number }>;
  request: NewThreadRequestPayload;
};

function uiTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    enrollmentId: randomUUID(),
    number: 1,
    displayId: "ONE-1",
    title: "Active task",
    description: "# Details",
    status: "Inbox",
    blockerReason: null,
    dependencyIds: [],
    blockerTaskIds: [],
    dependencyCycle: false,
    paths: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    attribution: "rpc:create",
    attributionAt: now,
    memoryState: "healthy",
    memoryError: null,
    memoryHash: "hash",
    memoryRevision: 1,
    memoryAttribution: {
      kind: "initialization",
      route: "rpc:create",
      threadId: null,
      sessionId: null,
      at: now,
    },
    linkedThreads: [],
    repositoryPreparation: {
      taskId: "00000000-0000-4000-8000-000000000001",
      projectId: "project-ui",
      hostId: "host-ui",
      repository: "/fixture-ui",
      environmentId: null,
      branchName: null,
      parentBranchName: null,
      preparedAt: null,
      revision: 1,
      updatedAt: now,
      observation: {
        state: "unselected",
        message: "Select an environment.",
        toolVersion: null,
        combinedWorkingCopy: null,
      },
    },
    ...overrides,
  };
}
test("board captures Markdown, opens drawer and preserves drafts on failure", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const id = randomUUID();
  let reject = true;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        list: () => ({
          datasetEpoch: randomUUID(),
          enrollments: [
            { id, name: "Fixture", prefix: "FX", availability: "available" },
          ],
          tasks: [],
          candidates: [],
          discoveryError: null,
        }),
        create: () => {
          if (reject) throw Error("Storage unavailable");
          return { id };
        },
      },
    },
  );
  try {
    await slot.findByText("Fixture (FX) — available");
    fireEvent.change(slot.getByLabelText("Capture project"), {
      target: { value: id },
    });
    fireEvent.change(slot.getByLabelText("Task title"), {
      target: { value: "Retain draft" },
    });
    fireEvent.change(slot.getByLabelText("Markdown description"), {
      target: { value: "# Heading\n- [ ] Check" },
    });
    fireEvent.click(slot.getByText("Create Inbox task"));
    await slot.findByText("Storage unavailable");
    expect((slot.getByLabelText("Task title") as HTMLInputElement).value).toBe(
      "Retain draft",
    );
    reject = false;
    fireEvent.click(slot.getByText("Create Inbox task"));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "board",
        options: { subPath: id },
      }),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("board shows backup health with last success and explicit daily retry", async () => {
  const app = await loadPluginApp(() => import("./app"));
  let degraded = true;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        list: () => ({
          datasetEpoch: randomUUID(),
          enrollments: [
            {
              id: "e1",
              name: "Fixture",
              prefix: "FX",
              availability: "available",
            },
          ],
          tasks: [],
          candidates: [],
          discoveryError: null,
          backup: degraded
            ? {
                state: "degraded",
                localDay: "2026-09-12",
                observedAt: "2026-09-12T00:00:00.000Z",
                lastAttemptAt: "2026-09-12T00:00:00.000Z",
                lastSuccessfulAt: null,
                lastSuccessfulLocalDay: null,
                lastSuccessfulPath: null,
                dailyArchiveCount: 0,
                error: "Injected capture failure",
                warning: null,
              }
            : {
                state: "healthy",
                localDay: "2026-09-12",
                observedAt: "2026-09-12T00:00:00.000Z",
                lastAttemptAt: "2026-09-12T00:00:00.000Z",
                lastSuccessfulAt: "2026-09-12T00:00:00.000Z",
                lastSuccessfulLocalDay: "2026-09-12",
                lastSuccessfulPath: "/archives/daily/today",
                dailyArchiveCount: 3,
                error: null,
                warning: null,
              },
        }),
        retryDailyBackup: () => {
          degraded = false;
          return {};
        },
      },
    },
  );
  try {
    await slot.findByText(/Backup failed · Injected capture failure/);
    fireEvent.click(slot.getByText("Retry daily backup"));
    await waitFor(() => {
      const calls =
        (slot.inspection as { rpcCalls?: Array<{ method: string }> })
          .rpcCalls ?? [];
      if (!calls.some((c) => c.method === "retryDailyBackup"))
        throw new Error("retry not invoked");
    });
    await slot.findByText(/Backup healthy · last success/);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("restore flow previews the archive and restores only through explicit confirmation", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const preview = {
    digest: "a".repeat(64),
    archiveKind: "complete" as const,
    schemaVersion: 10,
    createdAt: "2026-09-11T22:00:00.000Z",
    localDay: "2026-09-11",
    source: { datasetId: randomUUID(), hostId: "host-ui" },
    counts: {
      enrollments: 1,
      tasks: 3,
      records: 9,
      tables: 12,
      memories: 3,
      memoryBytes: 45,
    },
    warnings: ["This archive is an older snapshot of the current dataset."],
    current: { datasetId: epoch, hostId: "host-ui", tasks: 5 },
  };
  let resolvePreview!: (value: typeof preview) => void;
  let delayPreview = true;
  const delayedPreview = new Promise<typeof preview>((resolve) => {
    resolvePreview = resolve;
  });
  let previewCalls = 0;
  let restored: {
    path: string;
    expectedDigest: string;
    confirmReplace: boolean;
  } | null = null;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        list: () => ({
          datasetEpoch: epoch,
          enrollments: [],
          tasks: [],
          startOperations: [],
          candidates: [],
          discoveryError: null,
          backup: {
            state: "healthy",
            localDay: "2026-09-12",
            observedAt: "2026-09-12T00:00:00.000Z",
            lastAttemptAt: null,
            lastSuccessfulAt: "2026-09-12T00:00:00.000Z",
            lastSuccessfulLocalDay: "2026-09-12",
            lastSuccessfulPath: "/archives/daily/today",
            dailyArchiveCount: 2,
            error: null,
            warning: null,
          },
        }),
        previewRestore: (input: unknown) => {
          expect((input as { path: string }).path).toBe(
            "/tmp/archive.task-workspace.json",
          );
          previewCalls += 1;
          return delayPreview ? delayedPreview : preview;
        },
        restoreDataset: (rawInput: unknown) => {
          const input = rawInput as {
            path: string;
            expectedDigest: string;
            confirmReplace: boolean;
          };
          restored = input;
          return {
            datasetEpoch: randomUUID(),
            restoredCounts: preview.counts,
            protective: { kind: "complete", path: "/archives/recovery/x" },
            warnings: [],
          };
        },
      },
    },
  );
  try {
    fireEvent.click(await slot.findByText("Restore a dataset archive"));
    fireEvent.change(slot.getByLabelText("Archive path"), {
      target: { value: "/tmp/archive.task-workspace.json" },
    });
    fireEvent.click(slot.getByText("Preview archive"));
    await waitFor(() => expect(previewCalls).toBe(1));
    fireEvent.change(slot.getByLabelText("Archive path"), {
      target: { value: "/tmp/replacement.task-workspace.json" },
    });
    resolvePreview(preview);
    await waitFor(() =>
      expect(slot.getByText("Preview archive").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(slot.queryByLabelText("Restore preview")).toBeNull();
    delayPreview = false;
    fireEvent.change(slot.getByLabelText("Archive path"), {
      target: { value: "/tmp/archive.task-workspace.json" },
    });
    fireEvent.click(slot.getByText("Preview archive"));
    await slot.findByText(/Archive captured 2026-09-11T22:00:00.000Z/);
    await slot.findByText(
      /Restoring replaces all 5 current tasks with the 3 archived tasks/,
    );
    expect(slot.getByRole("alert").textContent).toMatch(
      /older snapshot of the current dataset/,
    );
    fireEvent.click(slot.getByText("Restore dataset"));
    await waitFor(() => expect(restored).not.toBeNull());
    expect(restored!.confirmReplace).toBe(true);
    expect(restored!.expectedDigest).toBe("a".repeat(64));
    await slot.findByText(/Restored 3 tasks/);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("Wayfinder view keeps per-drawer selection, coalesces invalidation and retains a labeled stale preview", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const active = uiTask({
    wayfinderAttachment: {
      taskId: "00000000-0000-4000-8000-000000000001",
      projectId: "project-ui",
      hostId: "host-ui",
      repository: "/fixture-ui",
      mapPath: "planning/map.md",
      selectedDirectory: "planning/tickets",
      revision: 1,
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
  });
  const tickets: WayfinderView["graph"]["tickets"] = [
    {
      path: "planning/tickets/01-first.md",
      id: "01",
      numericId: 1,
      title: "First",
      titleSource: "h1",
      type: "task",
      status: "resolved",
      rawMetadata: { Type: ["task"], Status: ["resolved"] },
      claimedBy: null,
      questionMarkdown: null,
      answerMarkdown: "Done",
      references: [],
      blockers: [],
      scope: "in-scope",
      consistent: true,
      diagnostics: [],
    },
    {
      path: "planning/tickets/02-second.md",
      id: "02",
      numericId: 2,
      title: "Second",
      titleSource: "map-link",
      type: "task",
      status: "open",
      rawMetadata: { Type: ["task"] },
      claimedBy: null,
      questionMarkdown: "What next?",
      answerMarkdown: null,
      references: [],
      blockers: [],
      scope: "in-scope",
      consistent: true,
      diagnostics: [],
    },
  ];
  let activeTask = active;
  const makeView = (): WayfinderView => ({
    attachment: activeTask.wayfinderAttachment!,
    graph: {
      adapter: "wayfinder-explicit-status/v1",
      source: {
        mapPath: "planning/map.md",
        selectedDirectory: "planning/tickets",
        mapState: "available",
        discoveryComplete: true,
      },
      map: { title: "Map", titleSource: "h1", sections: [], references: [] },
      tickets,
      outOfScope: [],
      edges: [],
      sccs: tickets.map((ticket) => ({ paths: [ticket.path], cyclic: false })),
      frontier: {
        complete: true,
        knownReadyPaths: [tickets[1]!.path],
        label: "complete-frontier",
      },
      diagnostics: [
        {
          code: "selected-ticket-directory-missing",
          message: "Selected directory is missing.",
          path: "planning/tickets",
          severity: "error",
        },
        {
          code: "file-byte-limit-exceeded",
          message: "File limit reached.",
          severity: "error",
        },
        {
          code: "source-changing",
          message: "Bounded retries were exhausted.",
          severity: "error",
        },
      ],
    },
    scanTime: "2026-09-12T00:00:00.000Z",
    sourceRevision: "a".repeat(64),
    workspaceLabel: "Combined working-copy view",
    environmentId: "env-ui",
    branchName: "task/wayfinder",
    refreshState: "current",
  });
  const makeViewSource = (): WayfinderSourceRead => ({
    repository: "/fixture-ui",
    mapPath: "planning/map.md",
    selectedDirectory: "planning/tickets",
    candidates: ["planning/tickets"],
    status: "ready",
    discoveryComplete: true,
    diagnostics: [],
    scanTime: "2026-09-12T00:00:00.000Z",
    sourceRevision: "b".repeat(64),
    watchRoot: "/fixture-ui/planning",
    map: {
      path: "planning/map.md",
      state: "available",
      text: "# Map",
      revision: "map:1",
    },
    tickets: [],
  });
  const viewIds: string[] = [];
  let reads = 0;
  let rejectRead = false;
  let closes = 0;
  const saves: Array<{ expectedAttachmentRevision: number }> = [];
  let inspectGate: Promise<WayfinderSourceRead> | null = null;
  let saveGate: Promise<void> | null = null;
  const rpc = {
    list: () => ({
      datasetEpoch: epoch,
      enrollments: [],
      tasks: [
        {
          ...activeTask,
          wayfinderAttachment: activeTask.wayfinderAttachment
            ? { ...activeTask.wayfinderAttachment }
            : null,
        },
      ],
      candidates: [],
      discoveryError: null,
    }),
    readMemory: () => ({
      state: "healthy" as const,
      content: "",
      token: {
        datasetEpoch: epoch,
        memoryRevision: 1,
        memoryHash: createHash("sha256").update("").digest("hex"),
      },
      attribution: active.memoryAttribution,
    }),
    readWayfinderView: (input: unknown) => {
      reads += 1;
      const viewId = (input as { viewId: string }).viewId;
      if (!viewIds.includes(viewId)) viewIds.push(viewId);
      if (rejectRead) throw Error("source changed during scan");
      return makeView();
    },
    closeWayfinderView: () => {
      closes += 1;
      return { closed: true as const };
    },
    inspectWayfinderSource: () => inspectGate ?? makeViewSource(),
    saveWayfinderAttachment: async (input: unknown) => {
      const request = input as {
        expectedAttachmentRevision: number;
        mapPath: string;
        selectedDirectory: string | null;
      };
      saves.push(request);
      if (saveGate) await saveGate;
      const current = activeTask.wayfinderAttachment!;
      return {
        ...current,
        mapPath: request.mapPath,
        selectedDirectory: request.selectedDirectory!,
        revision: current.revision + 1,
      };
    },
  };
  const first = renderSlot(app.navPanels[0]!, { subPath: active.id }, { rpc });
  const second = renderSlot(app.navPanels[0]!, { subPath: active.id }, { rpc });
  try {
    await waitFor(() =>
      expect(
        document.querySelectorAll('[aria-label="Selected Wayfinder ticket"]'),
      ).toHaveLength(2),
    );
    expect(
      first.getAllByLabelText("Wayfinder source diagnostics")[0]?.textContent,
    ).toMatch(
      /selected-ticket-directory-missing.*file-byte-limit-exceeded.*source-changing/s,
    );
    const lists = document.querySelectorAll('[aria-label="Wayfinder tickets"]');
    const articles = document.querySelectorAll(
      '[aria-label="Selected Wayfinder ticket"]',
    );
    fireEvent.click(within(lists[0] as HTMLElement).getByText(/01\. First/));
    expect(within(articles[0] as HTMLElement).getByText("First")).toBeTruthy();
    expect(within(articles[1] as HTMLElement).getByText("Second")).toBeTruthy();

    const beforeWrong = reads;
    await first.behavior.emitRealtime("wayfinderChanged", {
      viewId: randomUUID(),
      kind: "changed",
      message: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reads).toBe(beforeWrong);
    rejectRead = true;
    const firstViewId = (
      first.inspection.rpcCalls.find(
        (call) => call.method === "readWayfinderView",
      )?.input as { viewId: string }
    ).viewId;
    await first.behavior.emitRealtime("wayfinderChanged", {
      viewId: firstViewId,
      kind: "watch-error",
      message: "overflow",
    });
    await first.findByText(
      /Stale preview retained from .*source changed during scan/,
    );
    expect(first.getAllByText("Second").length).toBeGreaterThan(0);

    rejectRead = false;
    const beforeUnrelatedReads = reads;
    const beforeUnrelatedCloses = closes;
    await first.behavior.emitRealtime("changed", {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reads).toBe(beforeUnrelatedReads);
    expect(closes).toBe(beforeUnrelatedCloses);

    let resolveInspection!: (value: WayfinderSourceRead) => void;
    inspectGate = new Promise<WayfinderSourceRead>((resolve) => {
      resolveInspection = resolve;
    });
    fireEvent.click(first.getAllByText("Inspect source")[0]!);
    fireEvent.change(first.getAllByLabelText("Wayfinder map path")[0]!, {
      target: { value: "planning/edited-map.md" },
    });
    resolveInspection(makeViewSource());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.queryByText(/ready: 0 ticket source/)).toBeNull();
    inspectGate = null;

    activeTask = {
      ...activeTask,
      wayfinderAttachment: {
        ...activeTask.wayfinderAttachment!,
        mapPath: "planning/peer-map.md",
        revision: 2,
      },
    };
    await first.behavior.emitRealtime("changed", {});
    await first.findByText(/saved Wayfinder attachment changed/i);
    expect(
      (first.getAllByText("Attach source")[0] as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(first.getByText("Rebase draft"));
    await waitFor(() =>
      expect(
        (first.getAllByText("Attach source")[0] as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    let resolveSave!: () => void;
    saveGate = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    fireEvent.click(first.getAllByText("Attach source")[0]!);
    await waitFor(() =>
      expect(saves.at(-1)?.expectedAttachmentRevision).toBe(2),
    );
    fireEvent.change(first.getAllByLabelText("Wayfinder map path")[0]!, {
      target: { value: "planning/after-save-started.md" },
    });
    resolveSave();
    await waitFor(() =>
      expect(
        (first.getAllByLabelText("Wayfinder map path")[0] as HTMLInputElement)
          .value,
      ).toBe("planning/after-save-started.md"),
    );
    saveGate = null;

    const beforeFocus = reads;
    window.dispatchEvent(new Event("focus"));
    await first.behavior.emitRealtime("changed", {});
    await waitFor(() => expect(reads).toBeGreaterThan(beforeFocus));
    await first.behavior.setRealtimeConnectionState("reconnecting");
    await first.behavior.setRealtimeConnectionState("connected");
    const afterReconnect = reads;
    await waitFor(() => expect(reads).toBeGreaterThan(afterReconnect));
  } finally {
    first.lifecycle.unmount();
    second.lifecycle.unmount();
  }
});

test("two clients preserve stale drafts and require explicit reread or rebase", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-app-test-"));
  const emptyHash = createHash("sha256").update("").digest("hex");
  const project = {
    id: "project-ui",
    kind: "standard" as const,
    name: "UI fixture",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "source-ui",
        projectId: "project-ui",
        type: "local_path" as const,
        hostId: "host-ui",
        path: "/fixture-ui",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "db"),
    experimental_hostEntry: true,
    sdk: {
      projects: { list: async () => [project] },
      hosts: {
        list: async () => [
          {
            id: "host-ui",
            name: "Local",
            type: "persistent",
            status: "connected",
            maxPermissionMode: "full",
            lastSeenAt: 1,
            lastRejectedProtocolVersion: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method === "validateRepository")
        return { repository: "/fixture-ui", version: "fixture" };
      if (method === "readMemory")
        return {
          state: "present",
          content: "",
          bytesBase64: "",
          hash: emptyHash,
          size: 0,
        };
      if (method === "initializeMemory")
        return {
          state: "present",
          content: "",
          bytesBase64: "",
          hash: emptyHash,
          size: 0,
        };
      if (method === "replaceMemory") return { hash: emptyHash, size: 0 };
      if (method === "confirmMemoryDurable")
        return { hash: emptyHash, size: 0 };
      if (method === "archiveStatus" || method === "publishArchive")
        return {
          state: method === "publishArchive" ? "healthy" : "not-yet-created",
          localDay: "2026-09-12",
          observedAt: "2026-09-12T00:00:00.000Z",
          lastAttemptAt: null,
          lastSuccessfulAt:
            method === "publishArchive" ? "2026-09-12T00:00:00.000Z" : null,
          lastSuccessfulLocalDay:
            method === "publishArchive" ? "2026-09-12" : null,
          lastSuccessfulPath: null,
          dailyArchiveCount: method === "publishArchive" ? 1 : 0,
          error: null,
          warning: null,
        };
      if (method === "recordArchiveFailure")
        return {
          state: "degraded",
          localDay: "2026-09-12",
          observedAt: "2026-09-12T00:00:00.000Z",
          lastAttemptAt: "2026-09-12T00:00:00.000Z",
          lastSuccessfulAt: null,
          lastSuccessfulLocalDay: null,
          lastSuccessfulPath: null,
          dailyArchiveCount: 0,
          error: "failure",
          warning: null,
        };
      throw Error(`Unexpected host method ${method}`);
    },
  });
  try {
    await server(bb);
    const call = harness.behavior.callRpc;
    const enrollment = (await call("enroll", {
      projectId: project.id,
      sourceId: "source-ui",
      prefix: "UI",
    })) as { id: string };
    const created = (await call("create", {
      enrollmentId: enrollment.id,
      title: "Original",
      description: "# Original",
    })) as { id: string };
    const app = await loadPluginApp(() => import("./app"));
    const rpc = {
      list: (input: unknown) => call("list", input),
      updateDetails: (input: unknown) => call("updateDetails", input),
      setStatus: (input: unknown) => call("setStatus", input),
      replaceRelationships: (input: unknown) =>
        call("replaceRelationships", input),
      replacePaths: (input: unknown) => call("replacePaths", input),
      retryMemory: (input: unknown) => call("retryMemory", input),
      create: (input: unknown) => call("create", input),
      enroll: (input: unknown) => call("enroll", input),
    };
    const clientA = renderSlot(
      app.navPanels[0]!,
      { subPath: created.id },
      { rpc },
    );
    const clientB = renderSlot(
      app.navPanels[0]!,
      { subPath: created.id },
      { rpc },
    );
    const a = within(clientA.container);
    const b = within(clientB.container);
    try {
      await a.findByDisplayValue("Original");
      await b.findByDisplayValue("Original");
      fireEvent.change(b.getByLabelText("Edit title"), {
        target: { value: "Client B preserved draft" },
      });
      fireEvent.change(a.getByLabelText("Edit title"), {
        target: { value: "Client A accepted" },
      });
      fireEvent.click(a.getByText("Save details"));
      await waitFor(async () => {
        const current = (await call("list", null)) as {
          tasks: Array<{ title: string }>;
        };
        expect(current.tasks[0]?.title).toBe("Client A accepted");
      });
      await clientB.behavior.emitRealtime("changed", {});
      await b.findByText(
        "This task changed elsewhere. Your draft is preserved.",
      );
      expect((b.getByLabelText("Edit title") as HTMLInputElement).value).toBe(
        "Client B preserved draft",
      );
      fireEvent.click(b.getByText("Save details"));
      await b.findByText("Task changed; reload and reapply your edit.");
      fireEvent.click(b.getByText("Rebase draft on latest revision"));
      fireEvent.click(b.getByText("Save details"));
      await waitFor(async () => {
        const current = (await call("list", null)) as {
          tasks: Array<{ title: string }>;
        };
        expect(current.tasks[0]?.title).toBe("Client B preserved draft");
      });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(clientB.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "board",
      });
    } finally {
      clientA.lifecycle.unmount();
      clientB.lifecycle.unmount();
    }
  } finally {
    await harness.lifecycle.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("filters, Completed visibility, deep links and narrow keyboard drawer remain accessible", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const firstEnrollment = randomUUID();
  const secondEnrollment = randomUUID();
  const active = uiTask({
    enrollmentId: firstEnrollment,
    description:
      "# Safe\n<img src=https://remote.test/x> ![remote](https://remote.test/x.png) [bad](javascript:alert(1))",
  });
  const completed = uiTask({
    id: randomUUID(),
    enrollmentId: secondEnrollment,
    displayId: "TWO-1",
    title: "Completed task",
    status: "Completed",
  });
  const data = {
    datasetEpoch: randomUUID(),
    enrollments: [
      {
        id: firstEnrollment,
        name: "One",
        prefix: "ONE",
        availability: "available",
      },
      {
        id: secondEnrollment,
        name: "Two",
        prefix: "TWO",
        availability: "available",
      },
    ],
    tasks: [active, completed],
    candidates: [],
    discoveryError: null,
  };
  const board = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    { rpc: { list: () => data } },
  );
  try {
    await board.findByText("Active task");
    expect(board.queryByText("Completed task")).toBeNull();
    fireEvent.click(board.getByLabelText("Show Completed"));
    await board.findByText("Completed task");
    fireEvent.change(board.getByLabelText("Search tasks"), {
      target: { value: "TWO-1" },
    });
    expect(board.queryByText("Active task")).toBeNull();
    fireEvent.change(board.getByLabelText("Project filter"), {
      target: { value: firstEnrollment },
    });
    expect(board.queryByText("Completed task")).toBeNull();
  } finally {
    board.lifecycle.unmount();
  }
  const deepLink = renderSlot(
    app.navPanels[0]!,
    { subPath: `/${active.id}` },
    { rpc: { list: () => data } },
  );
  try {
    const drawer = await deepLink.findByRole("dialog", {
      name: "Task details",
    });
    await waitFor(() => expect(document.activeElement).toBe(drawer));
    expect(drawer.className).toContain("w-full");
    expect(drawer.querySelector("img")).toBeNull();
    expect(drawer.querySelector("script")).toBeNull();
    expect(drawer.querySelector('a[href^="javascript:"]')).toBeNull();
    fireEvent.click(deepLink.getByText("Back to board"));
    expect(deepLink.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "board",
    });
  } finally {
    deepLink.lifecycle.unmount();
  }
});

test("a delayed refresh cannot replace a newer realtime snapshot", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  let listCalls = 0;
  let resolveOld!: (value: typeof newer) => void;
  const newer = {
    datasetEpoch: epoch,
    enrollments: [],
    tasks: [uiTask({ title: "Newest snapshot" })],
    candidates: [],
    discoveryError: null,
  };
  const older = {
    ...newer,
    tasks: [uiTask({ title: "Delayed old snapshot" })],
  };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        list: () => {
          listCalls += 1;
          return listCalls === 1
            ? new Promise<typeof newer>((resolve) => {
                resolveOld = resolve;
              })
            : newer;
        },
      },
    },
  );
  try {
    await waitFor(() => expect(listCalls).toBe(1));
    await slot.behavior.emitRealtime("changed", {});
    await slot.findByText("Newest snapshot");
    resolveOld(older);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.queryByText("Delayed old snapshot")).toBeNull();
    expect(slot.getByText("Newest snapshot")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a delayed memory reread never overwrites text typed while the read is in flight", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const active = uiTask({
    memoryHash: createHash("sha256").update("").digest("hex"),
  });
  const token = {
    datasetEpoch: epoch,
    memoryRevision: 1,
    memoryHash: createHash("sha256").update("initial").digest("hex"),
  };
  let readCount = 0;
  let resolveDelayed!: (value: {
    state: "healthy";
    content: string;
    token: typeof token;
    attribution: Task["memoryAttribution"];
  }) => void;
  const delayed = new Promise<Parameters<typeof resolveDelayed>[0]>(
    (resolve) => {
      resolveDelayed = resolve;
    },
  );
  const data = {
    datasetEpoch: epoch,
    enrollments: [
      {
        id: active.enrollmentId,
        name: "Memory fixture",
        prefix: "MEM",
        revision: 1,
        availability: "available",
      },
    ],
    tasks: [active],
    candidates: [],
    discoveryError: null,
  };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: active.id },
    {
      rpc: {
        list: () => data,
        readMemory: () => {
          readCount += 1;
          return readCount <= 2
            ? {
                state: "healthy" as const,
                content: "initial",
                token,
                attribution: active.memoryAttribution,
              }
            : delayed;
        },
      },
    },
  );
  try {
    const editor = (await slot.findByLabelText(
      "Edit task memory Markdown",
    )) as HTMLTextAreaElement;
    expect(editor.value).toBe("initial");
    await slot.behavior.emitRealtime("changed", {});
    fireEvent.change(editor, { target: { value: "typed during reread" } });
    resolveDelayed({
      state: "healthy",
      content: "new canonical",
      token: {
        ...token,
        memoryRevision: 2,
        memoryHash: createHash("sha256").update("new canonical").digest("hex"),
      },
      attribution: { ...active.memoryAttribution, kind: "human" },
    });
    await slot.findByText(
      "Canonical memory changed while your draft was dirty. The draft and its original dataset/revision/hash token are preserved.",
    );
    expect(editor.value).toBe("typed during reread");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("late memory save completion cannot install task A state into task B", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const a = uiTask({ title: "Task A" });
  const b = uiTask({ id: randomUUID(), title: "Task B", displayId: "ONE-2" });
  const content = new Map([
    [a.id, "memory A"],
    [b.id, "memory B"],
  ]);
  const tokenFor = (value: string, revision = 1) => ({
    datasetEpoch: epoch,
    memoryRevision: revision,
    memoryHash: createHash("sha256").update(value).digest("hex"),
  });
  let resolveSave!: (value: {
    outcome: "saved";
    operationId: string;
    token: ReturnType<typeof tokenFor>;
    attribution: Task["memoryAttribution"];
  }) => void;
  const save = new Promise<Parameters<typeof resolveSave>[0]>((resolve) => {
    resolveSave = resolve;
  });
  const data = {
    datasetEpoch: epoch,
    enrollments: [],
    tasks: [a, b],
    candidates: [],
    discoveryError: null,
  };
  const rpc = {
    list: () => data,
    readMemory: (input: unknown) => ({
      state: "healthy" as const,
      content: content.get((input as { id: string }).id)!,
      token: tokenFor(content.get((input as { id: string }).id)!),
      attribution:
        (input as { id: string }).id === a.id
          ? a.memoryAttribution
          : b.memoryAttribution,
    }),
    saveMemory: () => save,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: a.id }, { rpc });
  const Panel = app.navPanels[0]!.component;
  try {
    const editorA = (await slot.findByLabelText(
      "Edit task memory Markdown",
    )) as HTMLTextAreaElement;
    fireEvent.change(editorA, { target: { value: "submitted A" } });
    fireEvent.click(slot.getByText("Save task memory"));
    await waitFor(() => expect(editorA.disabled).toBe(true));
    expect(editorA.value).toBe("submitted A");
    slot.rerender(<Panel subPath={b.id} />);
    const editorB = (await slot.findByLabelText(
      "Edit task memory Markdown",
    )) as HTMLTextAreaElement;
    expect(editorB.value).toBe("memory B");
    resolveSave({
      outcome: "saved",
      operationId: randomUUID(),
      token: tokenFor("submitted A", 2),
      attribution: { ...a.memoryAttribution, kind: "human" },
    });
    await waitFor(() => expect(editorB.disabled).toBe(false));
    expect(editorB.value).toBe("memory B");
    expect(slot.queryByDisplayValue("submitted A")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("thread linking retains failed drafts, requires validated reassignment and uses normal BB navigation", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const otherTaskId = randomUUID();
  const linked = uiTask({
    linkedThreads: [
      {
        threadId: "thread-linked",
        linkRevision: 4,
        linkedAt: new Date().toISOString(),
        lastKnownTitle: "Normal conversation",
        lastKnownProjectId: "project-ui",
        lastKnownEnvironmentId: "env-ui",
        lastKnownHostId: "host-ui",
        availability: "available",
        runtimeStatus: "idle",
        environmentMismatch: null,
        message:
          "Conversation and task repository environment currently match.",
      },
    ],
  });
  const memoryContent = "# Current memory";
  const token = {
    datasetEpoch: epoch,
    memoryRevision: 1,
    memoryHash: createHash("sha256").update(memoryContent).digest("hex"),
  };
  let rejectInspection = true;
  let sendCount = 0;
  const rpc = {
    list: () => ({
      datasetEpoch: epoch,
      enrollments: [],
      tasks: [linked],
      candidates: [],
      discoveryError: null,
    }),
    readMemory: () => ({
      state: "healthy" as const,
      content: memoryContent,
      token,
      attribution: linked.memoryAttribution,
    }),
    inspectThreadCandidate: () => {
      if (rejectInspection) throw Error("Temporary BB read unavailable");
      return {
        threadId: "thread-candidate",
        title: "Candidate",
        projectId: "project-ui",
        environmentId: "env-ui",
        hostId: "host-ui",
        availability: "available" as const,
        runtimeStatus: "idle" as const,
        environmentMismatch: null,
        currentLink: {
          taskId: otherTaskId,
          displayId: "ONE-9",
          linkRevision: 7,
        },
      };
    },
    linkThread: () => ({
      ...linked.linkedThreads[0],
      threadId: "thread-candidate",
    }),
    sendTaskContext: () => {
      sendCount += 1;
      return { delivery: "queued" as const, message: "Accepted once" };
    },
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: linked.id }, { rpc });
  try {
    const input = (await slot.findByLabelText(
      "Existing BB thread ID",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "thread-candidate" } });
    fireEvent.click(slot.getByText("Validate existing thread"));
    await slot.findByText("Temporary BB read unavailable");
    expect(input.value).toBe("thread-candidate");
    rejectInspection = false;
    fireEvent.click(slot.getByText("Validate existing thread"));
    await slot.findByText(/Currently linked to ONE-9/);
    expect(slot.getByText(`Reassign to ${linked.displayId}`)).toBeTruthy();

    fireEvent.click(slot.getByText("Open conversation"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thread-linked",
    });
    expect(sendCount).toBe(0);
    fireEvent.click(slot.getByText("Send current task context"));
    await slot.findByText("Accepted once");
    expect(sendCount).toBe(1);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("normal new-thread composer forwards its submitted choices with stable task-scoped seeds", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const active = uiTask();
  const enrollment = {
    id: active.enrollmentId,
    projectId: "project-ui",
    hostId: "host-ui",
    repository: "/fixture-ui",
    name: "UI fixture",
    prefix: "ONE",
    nextNumber: 2,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    availability: "available",
  };
  let submission: unknown;
  const operation = {
    id: randomUUID(),
    taskId: active.id,
    state: "linked" as const,
    datasetEpoch: epoch,
    taskRevision: active.revision,
    linkContext: [],
    projectId: "project-ui",
    environment: {
      type: "host" as const,
      hostId: "host-ui",
      workspace: { type: "unmanaged" as const, path: null },
    },
    hostId: "host-ui",
    providerId: "codex",
    model: "gpt-5",
    reasoningLevel: "medium",
    serviceTier: null,
    permissionMode: "auto",
    sendAt: null,
    inputDigest: "a".repeat(64),
    threadId: "thread-created",
    error: null,
    abandonedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const data = {
    datasetEpoch: epoch,
    enrollments: [enrollment],
    tasks: [active],
    startOperations: [],
    candidates: [],
    discoveryError: null,
  };
  const rpc = {
    list: () => data,
    readMemory: () => ({
      state: "healthy" as const,
      content: "",
      token: {
        datasetEpoch: epoch,
        memoryRevision: 1,
        memoryHash: createHash("sha256").update("").digest("hex"),
      },
      attribution: active.memoryAttribution,
    }),
    startLinkedThread: (input: unknown) => {
      submission = input;
      return {
        ...operation,
        id: (input as { operationId: string }).operationId,
      };
    },
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: active.id }, { rpc });
  try {
    const composer = await slot.findByTestId("bb-new-thread-composer");
    expect(composer.getAttribute("data-default-project-id")).toBe("project-ui");
    expect(composer.getAttribute("data-default-environment")).toBe(
      JSON.stringify({
        type: "host",
        hostId: "host-ui",
        workspace: { type: "unmanaged", path: null },
      }),
    );
    expect(composer.getAttribute("data-draft-key")).toBe(
      `task-workspace:start:${epoch}:${active.id}`,
    );
    fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), {
      target: { value: "Keep my composer text" },
    });
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thread-created",
      }),
    );
    expect(submission).toMatchObject({
      id: active.id,
      datasetEpoch: epoch,
      expectedTaskRevision: active.revision,
      expectedLinkContext: [],
      request: {
        projectId: "project-ui",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "auto",
        executionInputSources: {},
        environment: {
          type: "host",
          hostId: "host-ui",
          workspace: { type: "unmanaged", path: null },
        },
        input: [{ type: "text", text: "Keep my composer text", mentions: [] }],
      },
    });
    expect((submission as { operationId: string }).operationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("late start response cannot navigate or install state after task selection changes", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const enrollmentId = randomUUID();
  const first = uiTask({ enrollmentId, title: "First selection" });
  const second = uiTask({
    id: randomUUID(),
    enrollmentId,
    title: "Second selection",
  });
  const enrollment = {
    id: enrollmentId,
    projectId: "project-ui",
    hostId: "host-ui",
    repository: "/fixture-ui",
    name: "UI fixture",
    prefix: "ONE",
    nextNumber: 3,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    availability: "available",
  };
  let resolveStart!: (value: StartOperation) => void;
  const start = new Promise<StartOperation>(
    (resolve) => (resolveStart = resolve),
  );
  const rpc = {
    list: () => ({
      datasetEpoch: epoch,
      enrollments: [enrollment],
      tasks: [first, second],
      startOperations: [],
      candidates: [],
      discoveryError: null,
    }),
    readMemory: () => ({
      state: "healthy" as const,
      content: "",
      token: {
        datasetEpoch: epoch,
        memoryRevision: 1,
        memoryHash: createHash("sha256").update("").digest("hex"),
      },
      attribution: first.memoryAttribution,
    }),
    startLinkedThread: () => start,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: first.id }, { rpc });
  const Panel = app.navPanels[0]!.component;
  try {
    fireEvent.click(await slot.findByTestId("bb-new-thread-composer-submit"));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) => call.method === "startLinkedThread",
        ),
      ).toBe(true),
    );
    slot.rerender(<Panel subPath={second.id} />);
    await waitFor(() =>
      expect(
        slot
          .getByTestId("bb-new-thread-composer")
          .getAttribute("data-draft-key"),
      ).toBe(`task-workspace:start:${epoch}:${second.id}`),
    );
    resolveStart({
      id: randomUUID(),
      taskId: first.id,
      state: "linked",
      datasetEpoch: epoch,
      taskRevision: first.revision,
      linkContext: [],
      projectId: "project-ui",
      environment: {
        type: "host",
        hostId: "host-ui",
        workspace: { type: "unmanaged", path: null },
      },
      hostId: "host-ui",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "auto",
      sendAt: null,
      inputDigest: "b".repeat(64),
      threadId: "late-thread",
      error: null,
      abandonedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).not.toContainEqual({
        method: "toThread",
        threadId: "late-thread",
      }),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("start recovery responses retain epoch, selection and edited-ID authority across restore", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const firstEpoch = randomUUID();
  const secondEpoch = randomUUID();
  const thirdEpoch = randomUUID();
  let currentEpoch = firstEpoch;
  const enrollmentId = randomUUID();
  const first = uiTask({ enrollmentId, title: "Recovery first" });
  const second = uiTask({
    id: randomUUID(),
    enrollmentId,
    title: "Recovery second",
  });
  const enrollment = {
    id: enrollmentId,
    projectId: "project-ui",
    hostId: "host-ui",
    repository: "/fixture-ui",
    name: "UI fixture",
    prefix: "ONE",
    nextNumber: 3,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    availability: "available",
  };
  const operationId = randomUUID();
  const operation = (
    overrides: Partial<StartOperation> = {},
  ): StartOperation => ({
    id: operationId,
    taskId: first.id,
    state: "uncertain",
    datasetEpoch: currentEpoch,
    taskRevision: first.revision,
    linkContext: [],
    projectId: "project-ui",
    environment: {
      type: "host",
      hostId: "host-ui",
      workspace: { type: "unmanaged", path: null },
    },
    hostId: "host-ui",
    providerId: "codex",
    model: "gpt-5",
    reasoningLevel: "medium",
    serviceTier: null,
    permissionMode: "auto",
    sendAt: null,
    inputDigest: "c".repeat(64),
    threadId: null,
    error: "Recovery required",
    abandonedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
  let currentOperation = operation();
  let inspectMode: "delayed" | "immediate" = "delayed";
  let resolveInspect!: (value: ThreadCandidate) => void;
  const delayedInspect = new Promise<ThreadCandidate>(
    (resolve) => (resolveInspect = resolve),
  );
  let resolveIdentify!: (value: StartOperation) => void;
  const delayedIdentify = new Promise<StartOperation>(
    (resolve) => (resolveIdentify = resolve),
  );
  let resolveRetry!: (value: StartOperation) => void;
  const delayedRetry = new Promise<StartOperation>(
    (resolve) => (resolveRetry = resolve),
  );
  let resolveAbandon!: (value: StartOperation) => void;
  const delayedAbandon = new Promise<StartOperation>(
    (resolve) => (resolveAbandon = resolve),
  );
  const candidate: ThreadCandidate = {
    threadId: "thread-edited",
    title: "Exact candidate",
    projectId: "project-ui",
    environmentId: "env-ui",
    hostId: "host-ui",
    availability: "available",
    runtimeStatus: "idle",
    environmentMismatch: null,
    currentLink: null,
  };
  const rpc = {
    list: () => ({
      datasetEpoch: currentEpoch,
      enrollments: [enrollment],
      tasks: [first, second],
      startOperations: [currentOperation],
      candidates: [],
      discoveryError: null,
    }),
    readMemory: () => ({
      state: "healthy" as const,
      content: "",
      token: {
        datasetEpoch: currentEpoch,
        memoryRevision: 1,
        memoryHash: createHash("sha256").update("").digest("hex"),
      },
      attribution: first.memoryAttribution,
    }),
    inspectThreadCandidate: () =>
      inspectMode === "delayed" ? delayedInspect : candidate,
    identifyStartThread: () => delayedIdentify,
    retryStartLink: () => delayedRetry,
    abandonStartOperation: () => delayedAbandon,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: first.id }, { rpc });
  const Panel = app.navPanels[0]!.component;
  try {
    const exactId = (await slot.findByLabelText(
      "Exact conversation ID for uncertain start",
    )) as HTMLInputElement;
    fireEvent.change(exactId, { target: { value: "thread-old" } });
    fireEvent.click(slot.getByText("Validate exact conversation"));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) => call.method === "inspectThreadCandidate",
        ),
      ).toBe(true),
    );
    fireEvent.change(exactId, { target: { value: "thread-edited" } });
    currentEpoch = secondEpoch;
    currentOperation = operation({ datasetEpoch: secondEpoch });
    await slot.behavior.emitRealtime("changed", {});
    resolveInspect(candidate);
    await waitFor(() =>
      expect(
        slot.queryByText(`Identify and link to ${first.displayId}`),
      ).toBeNull(),
    );
    expect(exactId.value).toBe("thread-edited");

    inspectMode = "immediate";
    const inspectCallsBefore = slot.inspection.rpcCalls.filter(
      (call: { method: string }) => call.method === "inspectThreadCandidate",
    ).length;
    fireEvent.click(slot.getByText("Validate exact conversation"));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (call: { method: string }) =>
            call.method === "inspectThreadCandidate",
        ).length,
      ).toBe(inspectCallsBefore + 1),
    );
    await slot.findByText(`Identify and link to ${first.displayId}`);
    fireEvent.click(slot.getByText(`Identify and link to ${first.displayId}`));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.find(
          (call) => call.method === "identifyStartThread",
        )?.input,
      ).toMatchObject({ datasetEpoch: secondEpoch }),
    );
    fireEvent.change(exactId, { target: { value: "thread-after-identify" } });
    slot.rerender(<Panel subPath={second.id} />);
    resolveIdentify(
      operation({
        state: "linked",
        datasetEpoch: secondEpoch,
        threadId: "thread-edited",
      }),
    );
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).not.toContainEqual({
        method: "toThread",
        threadId: "thread-edited",
      }),
    );

    currentOperation = operation({
      state: "awaiting-link",
      datasetEpoch: secondEpoch,
      threadId: "thread-awaiting",
    });
    slot.rerender(<Panel subPath={first.id} />);
    await slot.behavior.emitRealtime("changed", {});
    fireEvent.click(
      await slot.findByText("Retry linking recorded conversation"),
    );
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.find(
          (call) => call.method === "retryStartLink",
        )?.input,
      ).toMatchObject({ datasetEpoch: secondEpoch }),
    );
    currentEpoch = thirdEpoch;
    currentOperation = operation({
      state: "awaiting-link",
      datasetEpoch: thirdEpoch,
      threadId: "thread-awaiting",
    });
    await slot.behavior.emitRealtime("changed", {});
    resolveRetry(
      operation({
        state: "linked",
        datasetEpoch: secondEpoch,
        threadId: "thread-awaiting",
      }),
    );
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).not.toContainEqual({
        method: "toThread",
        threadId: "thread-awaiting",
      }),
    );

    currentOperation = operation({ datasetEpoch: thirdEpoch });
    await slot.behavior.emitRealtime("changed", {});
    fireEvent.click(await slot.findByText("Abandon and quarantine this start"));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.find(
          (call) => call.method === "abandonStartOperation",
        )?.input,
      ).toMatchObject({ datasetEpoch: thirdEpoch }),
    );
    slot.rerender(<Panel subPath={second.id} />);
    resolveAbandon(
      operation({
        datasetEpoch: thirdEpoch,
        abandonedAt: new Date().toISOString(),
      }),
    );
    await waitFor(() =>
      expect(slot.queryByText(/Start operation quarantined/)).toBeNull(),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("lost linked response keeps original identity for explicit replay without a second spawn", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const active = uiTask();
  const enrollment = {
    id: active.enrollmentId,
    projectId: "project-ui",
    hostId: "host-ui",
    repository: "/fixture-ui",
    name: "UI fixture",
    prefix: "ONE",
    nextNumber: 2,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    availability: "available",
  };
  let currentTask = active;
  let durable: StartOperation | null = null;
  const submissions: unknown[] = [];
  let calls = 0;
  let spawnCount = 0;
  let lookupCount = 0;
  const rpc = {
    list: () => ({
      datasetEpoch: epoch,
      enrollments: [enrollment],
      tasks: [currentTask],
      startOperations: durable ? [durable] : [],
      candidates: [],
      discoveryError: null,
    }),
    readMemory: () => ({
      state: "healthy" as const,
      content: "",
      token: {
        datasetEpoch: epoch,
        memoryRevision: 1,
        memoryHash: createHash("sha256").update("").digest("hex"),
      },
      attribution: active.memoryAttribution,
    }),
    startLinkedThread: (value: unknown) => {
      const input = value as UiStartSubmission;
      calls += 1;
      submissions.push(structuredClone(input));
      if (!durable) {
        spawnCount += 1;
        durable = {
          id: input.operationId,
          taskId: active.id,
          state: "linked",
          datasetEpoch: epoch,
          taskRevision: active.revision,
          linkContext: [],
          projectId: "project-ui",
          environment: input.request.environment,
          hostId: "host-ui",
          providerId: input.request.providerId,
          model: input.request.model,
          reasoningLevel: input.request.reasoningLevel,
          serviceTier: input.request.serviceTier ?? null,
          permissionMode: input.request.permissionMode,
          sendAt: input.request.sendAt ?? null,
          inputDigest: "d".repeat(64),
          threadId: "thread-linked-once",
          error: null,
          abandonedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        currentTask = {
          ...active,
          linkedThreads: [
            {
              threadId: "thread-linked-once",
              linkRevision: 1,
              linkedAt: new Date().toISOString(),
              lastKnownTitle: "Linked once",
              lastKnownProjectId: "project-ui",
              lastKnownEnvironmentId: "env-ui",
              lastKnownHostId: "host-ui",
              availability: "available",
              runtimeStatus: "idle",
              environmentMismatch: null,
              message: "Matches",
            },
          ],
        };
        throw new Error("Lost successful start response");
      }
      return durable;
    },
    getStartOperation: () => {
      lookupCount += 1;
      if (lookupCount === 1) throw new Error("Lost durable lookup response");
      return durable!;
    },
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: active.id }, { rpc });
  try {
    const input = await slot.findByTestId("bb-new-thread-composer-input");
    fireEvent.change(input, { target: { value: "Preserve one submission" } });
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await slot.findByText("Lost successful start response");
    expect((input as HTMLTextAreaElement).value).toBe(
      "Preserve one submission",
    );
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thread-linked-once",
      }),
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(calls).toBe(2);
    expect(spawnCount).toBe(1);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("dataset restore invalidates a validated thread candidate while retaining its text for revalidation", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const before = randomUUID();
  const after = randomUUID();
  let currentEpoch = before;
  const active = uiTask();
  const memoryContent = "memory";
  const rpc = {
    list: () => ({
      datasetEpoch: currentEpoch,
      enrollments: [],
      tasks: [active],
      candidates: [],
      discoveryError: null,
    }),
    readMemory: () => ({
      state: "healthy" as const,
      content: memoryContent,
      token: {
        datasetEpoch: currentEpoch,
        memoryRevision: 1,
        memoryHash: createHash("sha256").update(memoryContent).digest("hex"),
      },
      attribution: active.memoryAttribution,
    }),
    inspectThreadCandidate: () => ({
      threadId: "thread-restore",
      title: "Validated before restore",
      projectId: "project-ui",
      environmentId: "env-ui",
      hostId: "host-ui",
      availability: "available" as const,
      runtimeStatus: "idle" as const,
      environmentMismatch: null,
      currentLink: null,
    }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: active.id }, { rpc });
  try {
    const input = (await slot.findByLabelText(
      "Existing BB thread ID",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "thread-restore" } });
    fireEvent.click(slot.getByText("Validate existing thread"));
    await slot.findByText(`Link to ${active.displayId}`);
    currentEpoch = after;
    await slot.behavior.emitRealtime("changed", {});
    await waitFor(() =>
      expect(slot.queryByText(`Link to ${active.displayId}`)).toBeNull(),
    );
    expect(input.value).toBe("thread-restore");
    expect(slot.getByText("Validate existing thread")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("repository draft keeps its epoch and revision until explicit rebase", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const enrollmentId = randomUUID();
  const firstEpoch = randomUUID();
  const replacementEpoch = randomUUID();
  const active = uiTask({
    enrollmentId,
    repositoryPreparation: {
      ...uiTask().repositoryPreparation,
      taskId: "00000000-0000-4000-8000-000000000001",
      environmentId: "env-main",
      revision: 1,
      observation: {
        state: "selected",
        message: "Ready to choose a branch.",
        toolVersion: "but 0.22.3",
        combinedWorkingCopy: {
          hasChanges: true,
          changeCount: 1,
          paths: ["draft.txt"],
        },
      },
    },
  });
  let current = {
    datasetEpoch: firstEpoch,
    enrollments: [
      {
        id: enrollmentId,
        name: "Fixture",
        prefix: "FX",
        revision: 1,
        availability: "available",
      },
    ],
    tasks: [active],
    candidates: [],
    discoveryError: null,
  };
  const calls: unknown[] = [];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: active.id },
    {
      rpc: {
        list: () => current,
        readMemory: () => ({
          state: "healthy" as const,
          content: "",
          token: {
            datasetEpoch: firstEpoch,
            memoryRevision: 1,
            memoryHash: createHash("sha256").update("").digest("hex"),
          },
          attribution: active.memoryAttribution,
        }),
        prepareRepository: (input: unknown) => {
          calls.push(input);
          return {
            ...current.tasks[0]!.repositoryPreparation,
            branchName: "task/typed",
            revision: 3,
            observation: {
              ...current.tasks[0]!.repositoryPreparation.observation,
              state: "ready" as const,
            },
          };
        },
      },
    },
  );
  try {
    await slot.findByLabelText("Repository environment ID");
    fireEvent.change(slot.getByLabelText("Exact task branch name"), {
      target: { value: "task/typed" },
    });
    current = {
      ...current,
      datasetEpoch: replacementEpoch,
      tasks: [
        {
          ...active,
          repositoryPreparation: {
            ...active.repositoryPreparation,
            revision: 2,
          },
        },
      ],
    };
    await slot.behavior.emitRealtime("changed", {});
    await slot.findByText(
      "Repository preparation changed elsewhere. Your branch draft and its original epoch/revision are preserved.",
    );
    expect(
      (slot.getByText("Prepare repository work") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(slot.getByText("Prepare repository work"));
    expect(calls).toHaveLength(0);
    fireEvent.click(slot.getByText("Rebase repository draft on latest state"));
    fireEvent.click(slot.getByText("Prepare repository work"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      datasetEpoch: replacementEpoch,
      expectedRepositoryRevision: 2,
      branchName: "task/typed",
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("repository correction draft preserves stale enrollment tokens", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const enrollmentId = randomUUID();
  const epoch = randomUUID();
  const active = uiTask({ enrollmentId });
  let current = {
    datasetEpoch: epoch,
    enrollments: [
      {
        id: enrollmentId,
        name: "Original",
        prefix: "FX",
        revision: 1,
        availability: "available",
      },
    ],
    tasks: [active],
    candidates: [
      {
        projectId: "project-next",
        name: "Replacement",
        sourceId: "source-next",
        hostId: "host-ui",
        repository: "/replacement",
      },
    ],
    discoveryError: null,
  };
  const calls: unknown[] = [];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: active.id },
    {
      rpc: {
        list: () => current,
        readMemory: () => ({
          state: "healthy" as const,
          content: "",
          token: {
            datasetEpoch: epoch,
            memoryRevision: active.memoryRevision,
            memoryHash: active.memoryHash!,
          },
          attribution: active.memoryAttribution!,
        }),
        reassociateEnrollment: (input: unknown) => {
          calls.push(input);
          return { ...current.enrollments[0], revision: 3 };
        },
      },
    },
  );
  try {
    await slot.findByText("Correct or reassociate enrolled repository");
    fireEvent.click(
      slot.getByText("Correct or reassociate enrolled repository"),
    );
    fireEvent.change(slot.getByLabelText("Replacement main repository"), {
      target: { value: "source-next" },
    });
    fireEvent.change(slot.getByLabelText("Replacement environment ID"), {
      target: { value: "env-next" },
    });
    current = {
      ...current,
      enrollments: [{ ...current.enrollments[0]!, revision: 2 }],
    };
    await slot.behavior.emitRealtime("changed", {});
    await slot.findByText(
      "Enrollment or dataset identity changed elsewhere. Your correction draft is preserved.",
    );
    expect(
      (slot.getByText("Reassociate without repair") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(slot.getByText("Rebase correction draft on latest state"));
    fireEvent.click(slot.getByText("Reassociate without repair"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      datasetEpoch: epoch,
      expectedEnrollmentRevision: 2,
      sourceId: "source-next",
      environmentId: "env-next",
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("memory conflicts expose only recovery actions supported by the observed bytes", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const epoch = randomUUID();
  const active = uiTask({
    memoryHash: createHash("sha256").update("").digest("hex"),
  });
  const data = {
    datasetEpoch: epoch,
    enrollments: [
      {
        id: active.enrollmentId,
        name: "Memory fixture",
        prefix: "MEM",
        revision: 1,
        availability: "available",
      },
    ],
    tasks: [active],
    candidates: [],
    discoveryError: null,
  };
  const committedToken = {
    datasetEpoch: epoch,
    memoryRevision: active.memoryRevision,
    memoryHash: active.memoryHash!,
  };
  const recoverable = renderSlot(
    app.navPanels[0]!,
    { subPath: active.id },
    {
      rpc: {
        list: () => data,
        readMemory: () => ({
          state: "conflict" as const,
          reason: "external-change" as const,
          message: "Canonical memory differs from committed metadata.",
          content: "# External draft",
          observedHash: "1".repeat(64),
          committedToken,
          operationId: null,
          attribution: "unknown-external" as const,
          allowedActions: ["accept-external", "restore-known"] as const,
        }),
      },
    },
  );
  try {
    await recoverable.findByText(/Memory conflict \(external-change\)/);
    recoverable.getByText("Current canonical external content");
    recoverable.getByText("Accept current external content");
    recoverable.getByText("Restore verified known content");
    recoverable.getByText(/External attribution is unknown/);
  } finally {
    recoverable.lifecycle.unmount();
  }

  const unsafe = renderSlot(
    app.navPanels[0]!,
    { subPath: active.id },
    {
      rpc: {
        list: () => data,
        readMemory: () => ({
          state: "conflict" as const,
          reason: "symlink" as const,
          message: "Canonical memory is a symbolic link.",
          content: null,
          observedHash: null,
          committedToken,
          operationId: null,
          attribution: "unknown-external" as const,
          allowedActions: [] as const,
        }),
      },
    },
  );
  try {
    await unsafe.findByText(/cannot be replaced through the plugin/);
    expect(unsafe.queryByText("Accept current external content")).toBeNull();
    expect(unsafe.queryByText("Restore verified known content")).toBeNull();
  } finally {
    unsafe.lifecycle.unmount();
  }
});
