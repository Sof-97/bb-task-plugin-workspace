import { afterEach, expect, test, vi } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, {
  createTaskWorkspacePlugin,
  type StartFailurePoint,
} from "./server";
import hostEntry from "./host";
import {
  task,
  enrollment,
  hostContract,
  type NewThreadRequestPayload,
} from "./contract";
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
async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for deterministic test gate.");
}
async function fixture(startFailure?: { point: StartFailurePoint | null }) {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-test-"));
  cleanups.push(async () => {
    try {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 20,
      });
    } catch (error) {
      try {
        const leftovers = await import("node:fs/promises").then((fs) =>
          fs.readdir(join(root, "host", "datasets"), { recursive: true }),
        );
        console.log(
          "LEFTOVERS",
          join(root, "host", "datasets"),
          JSON.stringify(leftovers.slice(0, 40)),
        );
      } catch {
        // diagnostics only
      }
      throw error;
    }
  });
  const worker = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: {
      dataDir: join(root, "host"),
      tempDir: join(root, "temp"),
    },
  });
  cleanups.push(() => worker.experimental_dispose());
  let present = true,
    fail = false,
    lose = false,
    repositoryReady = true,
    mutationCount = 0,
    postMutationMismatch = false;
  let failReplace = false,
    confirmFailures = 0,
    loseReplaceResponse = false;
  let inspectGate: Promise<void> | null = null;
  let releaseInspect: (() => void) | null = null;
  let replaceGate: Promise<void> | null = null;
  let releaseReplace: (() => void) | null = null;
  let nextDelivery: "sent" | "queued" = "sent";
  let sendCount = 0;
  let stopCount = 0;
  let spawnCount = 0;
  let possibleDispatchFailure = false;
  let spawnGate: Promise<void> | null = null;
  let releaseSpawn: (() => void) | null = null;
  let environmentGetCount = 0;
  let environmentGetGateAt: number | null = null;
  let environmentGetGate: Promise<void> | null = null;
  let releaseEnvironmentGet: (() => void) | null = null;
  let threadGetCount = 0;
  let pendingThreadEnvironmentReads = 0;
  let threadGetGate: Promise<void> | null = null;
  let releaseThreadGet: (() => void) | null = null;
  const wayfinderReadGates: Array<Promise<void>> = [];
  const releaseWayfinderReads: Array<() => void> = [];
  const wayfinderWatchGates: Array<Promise<void>> = [];
  const releaseWayfinderWatches: Array<() => void> = [];
  const wayfinderStopGates: Array<Promise<void>> = [];
  const releaseWayfinderStops: Array<() => void> = [];
  const spawnRequests: unknown[] = [];
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
  const environments = new Map([
    [
      "env-main",
      {
        id: "env-main",
        name: null,
        projectId: "project-1",
        hostId: "host-1",
        path: "/fixture",
        managed: false,
        isGitRepo: true,
        isWorktree: false,
        workspaceProvisionType: "unmanaged" as const,
        branchName: "gitbutler/workspace",
        baseBranch: null,
        defaultBranch: "main",
        mergeBaseBranch: null,
        status: "ready" as const,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  ]);
  const appliedStacks: string[][] = [];
  const localBranches = new Set<string>();
  const mergedBranches = new Set<string>();
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const inventory = (repository = "/fixture") => ({
    repository,
    version: "but 0.22.3",
    appliedStacks: appliedStacks.map((stack) => [...stack]),
    branches: [...localBranches].map((name) => ({
      name,
      merged: mergedBranches.has(name),
    })),
    combinedWorkingCopy: {
      hasChanges: true,
      changeCount: 2,
      paths: ["tracked.txt", "untracked.txt"],
    },
  });
  const projects = [
    {
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
    },
  ];
  projects.push({
    ...projects[0],
    id: "project-2",
    sources: [
      {
        ...projects[0].sources[0],
        id: "source-2",
        projectId: "project-2",
        path: "/fixture-2",
      },
    ],
  });
  environments.set("env-second", {
    ...environments.get("env-main")!,
    id: "env-second",
    projectId: "project-2",
    path: "/fixture-2",
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "task-workspace",
    dataDir: join(root, "db"),
    experimental_hostEntry: true,
    sdk: {
      projects: {
        list: async () => (present ? projects : []),
        get: async ({ projectId }) => {
          const project = projects.find((item) => item.id === projectId);
          if (!project || !present) throw Error("Project not found");
          return project;
        },
      },
      environments: {
        get: async ({ environmentId }) => {
          environmentGetCount += 1;
          if (
            environmentGetGate &&
            environmentGetGateAt === environmentGetCount
          )
            await environmentGetGate;
          const environment = environments.get(environmentId);
          if (!environment) throw Error("Environment not found");
          return environment;
        },
      },
      hosts: {
        list: async () => [connectedHost],
        get: async ({ hostId }) => {
          if (hostId !== connectedHost.id) throw Error("Host not found");
          return connectedHost;
        },
      },
      threads: {
        get: async ({ threadId }) => {
          threadGetCount += 1;
          if (threadGetGate) await threadGetGate;
          const thread = threads.get(threadId);
          if (!thread) throw Error("Thread unavailable");
          if (pendingThreadEnvironmentReads > 0) {
            pendingThreadEnvironmentReads -= 1;
            return { ...thread, environmentId: null };
          }
          return thread;
        },
        send: async () => {
          sendCount += 1;
          return nextDelivery === "sent"
            ? ({ ok: true, delivery: "sent" } as const)
            : ({
                ok: true,
                delivery: "queued",
                queuedMessage: {
                  id: "queued-fixture",
                },
              } as never);
        },
        stop: async ({ threadId }) => {
          stopCount += 1;
          const thread = threads.get(threadId);
          if (thread) threads.set(threadId, { ...thread, status: "idle" });
          return { ok: true as const };
        },
        spawn: async (request) => {
          spawnCount += 1;
          spawnRequests.push(request);
          if (spawnGate) await spawnGate;
          const threadId = `thread-spawn-${spawnCount}`;
          const thread = makeThreadResponse({
            id: threadId,
            projectId: "project-1",
            environmentId: "env-main",
            status: request.sendAt ? "pending" : "active",
            title: request.title ?? `Thread ${threadId}`,
          });
          threads.set(threadId, thread);
          if (possibleDispatchFailure) {
            possibleDispatchFailure = false;
            throw Error("Injected lost spawn response after possible dispatch");
          }
          return thread;
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "validateRepository") {
        if (!repositoryReady) throw Error("Repository needs correction");
        const value = input as { repository: string };
        return { repository: value.repository, version: "fixture" };
      }
      if (method === "inspectRepository") {
        if (inspectGate) await inspectGate;
        return inventory((input as { repository: string }).repository);
      }
      if (method === "mutateBranch") {
        mutationCount += 1;
        const value = input as {
          action: string;
          branchName: string;
          parentBranchName: string | null;
        };
        if (value.action.startsWith("create")) {
          localBranches.add(value.branchName);
          if (value.action === "create-independent")
            appliedStacks.push([value.branchName]);
          else {
            const stack = appliedStacks.find((names) =>
              names.includes(value.parentBranchName!),
            )!;
            stack.splice(
              stack.indexOf(value.parentBranchName!),
              0,
              value.branchName,
            );
          }
        } else {
          for (const stack of appliedStacks) {
            const index = stack.indexOf(value.branchName);
            if (index >= 0) stack.splice(index, 1);
          }
          const parentStack = appliedStacks.find((names) =>
            names.includes(value.parentBranchName!),
          )!;
          parentStack.splice(
            parentStack.indexOf(value.parentBranchName!),
            0,
            value.branchName,
          );
        }
        if (postMutationMismatch) {
          for (const stack of appliedStacks) {
            const index = stack.indexOf(value.branchName);
            if (index >= 0) stack.splice(index, 1);
          }
        }
        return inventory();
      }
      if (method === "readWayfinderSource") {
        const gate = wayfinderReadGates.shift();
        if (gate) await gate;
        const value = input as {
          repository: string;
          mapPath: string;
          selectedDirectory: string | null;
        };
        return {
          repository: value.repository,
          mapPath: value.mapPath,
          selectedDirectory: value.selectedDirectory ?? "planning/tickets",
          candidates: ["planning/tickets"],
          status: "ready",
          discoveryComplete: true,
          diagnostics: [],
          scanTime: "2026-09-12T00:00:00.000Z",
          sourceRevision: "a".repeat(64),
          watchRoot: value.repository,
          map: {
            path: value.mapPath,
            state: "available",
            text: "# Fixture map\n\n## Decisions\n- [First](tickets/01-first.md)",
            revision: "map:1",
          },
          tickets: [
            {
              path: "planning/tickets/01-first.md",
              state: "available",
              text: "# First\nType: task\nStatus: open\n\n## Question\nReady?",
              revision: "ticket:1",
            },
          ],
        };
      }
      if (method === "startWayfinderWatch") {
        const gate = wayfinderWatchGates.shift();
        if (gate) await gate;
        return { watching: true };
      }
      if (method === "stopWayfinderWatch") {
        const gate = wayfinderStopGates.shift();
        if (gate) await gate;
        return { stopped: true };
      }
      if (method === "archiveStatus")
        return worker.experimental_call(
          "archiveStatus",
          hostContract.archiveStatus.input.parse(input),
        );
      if (method === "publishArchive")
        return worker.experimental_call(
          "publishArchive",
          hostContract.publishArchive.input.parse(input),
        );
      if (method === "recordArchiveFailure")
        return worker.experimental_call(
          "recordArchiveFailure",
          hostContract.recordArchiveFailure.input.parse(input),
        );
      if (fail) throw Error("Injected filesystem unavailable");
      if (method === "replaceMemory" && failReplace)
        throw Error("Injected failure before replacement");
      if (method === "replaceMemory" && replaceGate) await replaceGate;
      if (method === "confirmMemoryDurable" && confirmFailures > 0) {
        confirmFailures -= 1;
        throw Error("Injected durability confirmation failure");
      }
      const result =
        method === "readMemory"
          ? await worker.experimental_call(
              "readMemory",
              hostContract.readMemory.input.parse(input),
            )
          : method === "initializeMemory"
            ? await worker.experimental_call(
                "initializeMemory",
                hostContract.initializeMemory.input.parse(input),
              )
            : method === "replaceMemory"
              ? await worker.experimental_call(
                  "replaceMemory",
                  hostContract.replaceMemory.input.parse(input),
                )
              : await worker.experimental_call(
                  "confirmMemoryDurable",
                  hostContract.confirmMemoryDurable.input.parse(input),
                );
      if (lose) {
        lose = false;
        throw Error("Lost response after file creation");
      }
      if (method === "replaceMemory" && loseReplaceResponse) {
        loseReplaceResponse = false;
        throw Error("Lost response after durable replacement");
      }
      return result;
    },
  });
  cleanups.push(() => harness.lifecycle.dispose());
  const dailyHooks = {
    failStartAt: startFailure
      ? (point: StartFailurePoint) => {
          if (startFailure.point === point) {
            startFailure.point = null;
            throw Error(`Injected start failure at ${point}`);
          }
        }
      : undefined,
    onDailyAttempt: (attempt: Promise<unknown>) => dailyAttempts.push(attempt),
  };
  const entry = startFailure
    ? createTaskWorkspacePlugin(dailyHooks)
    : (target: Parameters<typeof plugin>[0]) => plugin(target, dailyHooks);
  await entry(bb);
  const call = harness.behavior.callRpc;
  const enrolled = enrollment.parse(
    await call("enroll", {
      projectId: "project-1",
      sourceId: "source-1",
      prefix: "fx",
    }),
  );
  return {
    root,
    harness,
    threads,
    call,
    enrolled,
    setPresent: (v: boolean) => (present = v),
    setFail: (v: boolean) => (fail = v),
    setLose: () => (lose = true),
    setFailReplace: (value: boolean) => (failReplace = value),
    setConfirmFailures: (value: number) => (confirmFailures = value),
    loseReplaceResponse: () => (loseReplaceResponse = true),
    breakRepository: () => (repositoryReady = false),
    moveSource: () => {
      projects[0].sources[0].hostId = "host-other";
    },
    environment: environments.get("env-main")!,
    environments,
    appliedStacks,
    localBranches,
    mergedBranches,
    mutationCount: () => mutationCount,
    setPostMutationMismatch: (value: boolean) => (postMutationMismatch = value),
    addThread: (
      threadId: string,
      overrides: Partial<ReturnType<typeof makeThreadResponse>> = {},
    ) =>
      threads.set(
        threadId,
        makeThreadResponse({
          id: threadId,
          projectId: "project-1",
          environmentId: "env-main",
          status: "idle",
          title: `Thread ${threadId}`,
          ...overrides,
        }),
      ),
    removeThread: (threadId: string) => threads.delete(threadId),
    setNextDelivery: (value: "sent" | "queued") => (nextDelivery = value),
    sendCount: () => sendCount,
    stopCount: () => stopCount,
    spawnCount: () => spawnCount,
    spawnRequests,
    delayThreadEnvironment: (reads: number) =>
      (pendingThreadEnvironmentReads = reads),
    loseSpawnResponse: () => (possibleDispatchFailure = true),
    delaySpawns: () => {
      spawnGate = new Promise<void>((resolve) => (releaseSpawn = resolve));
    },
    releaseSpawns: () => {
      releaseSpawn?.();
      spawnGate = null;
      releaseSpawn = null;
    },
    delayEnvironmentGet: (callNumber: number) => {
      environmentGetGateAt = callNumber;
      environmentGetGate = new Promise<void>(
        (resolve) => (releaseEnvironmentGet = resolve),
      );
    },
    environmentGetCount: () => environmentGetCount,
    releaseEnvironmentGet: () => {
      releaseEnvironmentGet?.();
      environmentGetGate = null;
      environmentGetGateAt = null;
      releaseEnvironmentGet = null;
    },
    delayThreadGets: () => {
      threadGetGate = new Promise<void>(
        (resolve) => (releaseThreadGet = resolve),
      );
    },
    threadGetCount: () => threadGetCount,
    releaseThreadGets: () => {
      releaseThreadGet?.();
      threadGetGate = null;
      releaseThreadGet = null;
    },
    delayReplacements: () => {
      replaceGate = new Promise<void>((resolve) => (releaseReplace = resolve));
    },
    releaseReplacements: () => {
      releaseReplace?.();
      replaceGate = null;
      releaseReplace = null;
    },
    delayInspects: () => {
      inspectGate = new Promise<void>((resolve) => (releaseInspect = resolve));
    },
    releaseInspects: () => {
      releaseInspect?.();
      inspectGate = null;
      releaseInspect = null;
    },
    delayNextWayfinderRead: () => {
      wayfinderReadGates.push(
        new Promise<void>((resolve) => releaseWayfinderReads.push(resolve)),
      );
    },
    releaseNextWayfinderRead: () => releaseWayfinderReads.shift()?.(),
    delayNextWayfinderWatch: () => {
      wayfinderWatchGates.push(
        new Promise<void>((resolve) => releaseWayfinderWatches.push(resolve)),
      );
    },
    releaseNextWayfinderWatch: () => releaseWayfinderWatches.shift()?.(),
    delayNextWayfinderStop: () => {
      wayfinderStopGates.push(
        new Promise<void>((resolve) => releaseWayfinderStops.push(resolve)),
      );
    },
    releaseNextWayfinderStop: () => releaseWayfinderStops.shift()?.(),
    db: bb.storage.database(),
  };
}
test("concurrent numbering and reload; capture is independent of repository readiness", async () => {
  const f = await fixture();
  await expect(
    f.call("enroll", {
      projectId: "project-1",
      sourceId: "source-1",
      prefix: "OTHER",
    }),
  ).rejects.toThrow();
  f.breakRepository();
  const rows = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      f
        .call("create", {
          enrollmentId: f.enrolled.id,
          title: `Task ${i}`,
          description: "# Heading\n- [ ] Item",
        })
        .then((v) => task.parse(v)),
    ),
  );
  expect(new Set(rows.map((t) => t.displayId)).size).toBe(12);
  expect(rows.map((t) => t.number).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  expect(rows.every((t) => t.memoryState === "healthy")).toBe(true);
  const replacement = await f.harness.lifecycle.reload(plugin);
  f.call = replacement.harness.behavior.callRpc;
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  expect(
    task.parse(
      await f.call("create", { enrollmentId: f.enrolled.id, title: "Reload" }),
    ).displayId,
  ).toBe("FX-13");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  f.setPresent(false);
  const list = (await f.call("list", null)) as {
    tasks: unknown[];
    enrollments: Array<{ availability: string; name: string }>;
  };
  expect(list.tasks).toHaveLength(13);
  expect(list.enrollments[0]).toMatchObject({
    availability: "missing project",
    name: "Fixture project",
  });
  await expect(
    f.call("create", { enrollmentId: f.enrolled.id, title: "Missing" }),
  ).rejects.toThrow();
});

type TestStartSubmission = {
  id: string;
  operationId: string;
  datasetEpoch: string;
  expectedTaskRevision: number;
  expectedLinkContext: Array<{ threadId: string; linkRevision: number }>;
  request: NewThreadRequestPayload;
};

async function startSubmission(
  f: Awaited<ReturnType<typeof fixture>>,
  created: ReturnType<typeof task.parse>,
  overrides: Partial<Omit<TestStartSubmission, "request">> = {},
): Promise<TestStartSubmission> {
  const listed = (await f.call("list", null)) as { datasetEpoch: string };
  return {
    id: created.id,
    operationId: randomUUID(),
    datasetEpoch: listed.datasetEpoch,
    expectedTaskRevision: created.revision,
    expectedLinkContext: created.linkedThreads.map(
      ({ threadId, linkRevision }) => ({ threadId, linkRevision }),
    ),
    request: {
      projectId: "project-1",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "medium",
      permissionMode: "auto",
      serviceTier: "fast",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
        serviceTier: "explicit",
      },
      environment: {
        type: "host",
        hostId: "host-1",
        workspace: { type: "unmanaged", path: null },
      },
      input: [
        {
          type: "text",
          text: "Inspect @fixture without changing its offset.",
          mentions: [
            {
              start: 8,
              end: 16,
              resource: {
                kind: "project",
                label: "fixture",
                projectId: "project-1",
              },
            },
          ],
        },
        {
          type: "localFile",
          path: "attachments/spec.md",
          name: "spec.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
        },
      ],
      sendAt: Date.now() + 60_000,
    },
    ...overrides,
  };
}

test("thread start waits for BB to attach its environment before linking", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Provisioning checkout",
    }),
  );
  f.delayThreadEnvironment(2);
  const submission = await startSubmission(f, created);
  expect(await f.call("startLinkedThread", submission)).toMatchObject({
    state: "linked",
    threadId: "thread-spawn-1",
    error: null,
  });
  expect(f.spawnCount()).toBe(1);
});

test("slow checkout preparation stays recoverable without spawning twice", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Slow checkout",
    }),
  );
  const submission = await startSubmission(f, created);
  f.delayThreadEnvironment(100);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const pending = f.call("startLinkedThread", submission);
    await expect.poll(() => f.threadGetCount()).toBeGreaterThanOrEqual(2);
    vi.setSystemTime(Date.now() + 11_000);
    expect(await pending).toMatchObject({
      state: "awaiting-link",
      threadId: "thread-spawn-1",
      error: expect.stringContaining("still preparing its checkout"),
    });
  } finally {
    vi.useRealTimers();
  }
  f.delayThreadEnvironment(0);
  expect(
    await f.call("retryStartLink", {
      id: created.id,
      operationId: submission.operationId,
      datasetEpoch: submission.datasetEpoch,
    }),
  ).toMatchObject({ state: "linked", error: null });
  expect(f.spawnCount()).toBe(1);
});

test("BB provider project checkout submissions link once and preserve replay identity", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Current composer",
    }),
  );
  const input = await startSubmission(f, created);
  const submission = {
    ...input,
    request: {
      ...input.request,
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: "host-1" },
        inputs: {},
      },
    },
  };
  expect(await f.call("startLinkedThread", submission)).toMatchObject({
    state: "linked",
    threadId: "thread-spawn-1",
  });
  expect(await f.call("startLinkedThread", submission)).toMatchObject({
    state: "linked",
  });
  expect(f.spawnCount()).toBe(1);
  expect(f.spawnRequests[0]).toMatchObject({
    environment: input.request.environment,
    providerId: input.request.providerId,
    model: input.request.model,
  });
});

test.each([
  { hostId: "host-other", inputs: {} },
  { hostId: "host-1", inputs: { path: "/another/checkout" } },
  { hostId: "host-1", inputs: { branch: { kind: "existing", name: "other" } } },
  { hostId: "host-1", inputs: { branch: { kind: "new", baseBranch: "main" } } },
])(
  "provider checkout retains environment guards: %j",
  async ({ hostId, inputs }) => {
    const f = await fixture();
    const created = task.parse(
      await f.call("create", {
        enrollmentId: f.enrolled.id,
        title: "Guarded composer",
      }),
    );
    const input = await startSubmission(f, created);
    expect(
      await f.call("startLinkedThread", {
        ...input,
        request: {
          ...input.request,
          environment: {
            type: "provider",
            environmentProviderId: "project-checkout",
            machine: { type: "existing", hostId },
            inputs,
          },
        },
      }),
    ).toMatchObject({ state: "failed-before-dispatch" });
    expect(f.spawnCount()).toBe(0);
  },
);

test("normal composer submission preserves declared choices and structured blocks while linking atomically", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Composer task",
      description: "# Discuss first",
    }),
  );
  const input = await startSubmission(f, created);
  const before = task.parse(
    ((await f.call("list", null)) as { tasks: unknown[] }).tasks.find(
      (value) => (value as { id: string }).id === created.id,
    ),
  );
  const result = (await f.call("startLinkedThread", input)) as {
    state: string;
    threadId: string;
    inputDigest: string;
  };
  expect(result).toMatchObject({ state: "linked", threadId: "thread-spawn-1" });
  expect(f.spawnCount()).toBe(1);
  const submitted = f.spawnRequests[0] as {
    input: unknown[];
    prompt?: string;
    projectId: string;
    providerId: string;
    model: string;
    reasoningLevel: string;
    permissionMode: string;
    serviceTier: string;
    executionInputSources: unknown;
    environment: unknown;
    sendAt: number;
  };
  expect(submitted.prompt).toBeUndefined();
  expect(submitted.input.slice(0, 2)).toEqual(input.request.input);
  expect(submitted.input[2]).toMatchObject({
    type: "text",
    mentions: [],
    text: expect.stringContaining("# Current task context"),
  });
  expect(submitted).toMatchObject({
    projectId: input.request.projectId,
    providerId: input.request.providerId,
    model: input.request.model,
    reasoningLevel: input.request.reasoningLevel,
    permissionMode: input.request.permissionMode,
    serviceTier: input.request.serviceTier,
    executionInputSources: input.request.executionInputSources,
    environment: input.request.environment,
    sendAt: input.request.sendAt,
  });
  const after = task.parse(
    ((await f.call("list", null)) as { tasks: unknown[] }).tasks.find(
      (value) => (value as { id: string }).id === created.id,
    ),
  );
  expect(after).toMatchObject({
    status: before.status,
    revision: before.revision,
    repositoryPreparation: before.repositoryPreparation,
  });
  expect(after.linkedThreads.map((link) => link.threadId)).toEqual([
    "thread-spawn-1",
  ]);
  expect(after.linkedThreads[0]?.runtimeStatus).toBe("pending");
  const stored = f.db
    .prepare("SELECT * FROM thread_start_operations WHERE id=?")
    .get(input.operationId) as Record<string, unknown>;
  expect(JSON.stringify(stored)).not.toContain("Inspect @fixture");
  expect(stored).toMatchObject({
    state: "linked",
    threadId: "thread-spawn-1",
    datasetEpoch: input.datasetEpoch,
    taskRevision: input.expectedTaskRevision,
    projectId: input.request.projectId,
    hostId: "host-1",
    providerId: input.request.providerId,
    model: input.request.model,
    reasoningLevel: input.request.reasoningLevel,
    serviceTier: input.request.serviceTier,
    permissionMode: input.request.permissionMode,
    sendAt: input.request.sendAt,
    inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.parse(stored.linkContextJson as string)).toEqual([]);
  expect(JSON.parse(stored.environmentJson as string)).toEqual(
    input.request.environment,
  );
  expect(JSON.parse(stored.executionInputSourcesJson as string)).toEqual(
    input.request.executionInputSources,
  );

  expect(await f.call("startLinkedThread", input)).toEqual(result);
  expect(f.spawnCount()).toBe(1);
});

test.each([
  ["before-prepared", "failed-before-dispatch", 0],
  ["persist-dispatching", "failed-before-dispatch", 0],
  ["after-dispatching", "uncertain", 0],
  ["after-spawn-before-thread-id", "uncertain", 1],
  ["after-awaiting-link", "awaiting-link", 1],
  ["link-final-transaction", "awaiting-link", 1],
] as const)(
  "start failure at %s is durable as %s without duplicate dispatch",
  async (point, expectedState, expectedSpawns) => {
    const failure = { point: point as StartFailurePoint | null };
    const f = await fixture(failure);
    const created = task.parse(
      await f.call("create", {
        enrollmentId: f.enrolled.id,
        title: `Failure ${point}`,
      }),
    );
    const input = await startSubmission(f, created);
    const first = (await f.call("startLinkedThread", input)) as {
      state: string;
      threadId: string | null;
    };
    expect(first.state).toBe(expectedState);
    expect(f.spawnCount()).toBe(expectedSpawns);
    if (point === "link-final-transaction")
      expect(
        (
          f.db
            .prepare(
              "SELECT count(*) AS count FROM thread_links WHERE taskId=?",
            )
            .get(created.id) as { count: number }
        ).count,
      ).toBe(0);
    const second = (await f.call("startLinkedThread", input)) as {
      state: string;
    };
    expect(f.spawnCount()).toBe(expectedSpawns);
    if (expectedState === "awaiting-link") expect(second.state).toBe("linked");
    else expect(second.state).toBe(expectedState);
    expect(f.sendCount()).toBe(0);
    expect(
      (
        f.db
          .prepare("SELECT count(*) AS count FROM thread_links WHERE taskId=?")
          .get(created.id) as { count: number }
      ).count,
    ).toBe(expectedState === "awaiting-link" ? 1 : 0);
  },
);

test("possible-dispatch SDK failure is uncertain and never retries spawn or first send", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Lost spawn response",
    }),
  );
  const input = await startSubmission(f, created);
  f.loseSpawnResponse();
  expect(await f.call("startLinkedThread", input)).toMatchObject({
    state: "uncertain",
    threadId: null,
  });
  expect(f.spawnCount()).toBe(1);
  expect(await f.call("startLinkedThread", input)).toMatchObject({
    state: "uncertain",
  });
  expect(f.spawnCount()).toBe(1);
  expect(f.sendCount()).toBe(0);
  await expect(
    f.call("startLinkedThread", {
      ...input,
      request: { ...input.request, model: "different-model" },
    }),
  ).rejects.toThrow(/does not match/);
});

test("external spawn is not held under task coordination and exposes dispatching state", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "In-flight seam",
    }),
  );
  const input = await startSubmission(f, created);
  f.delaySpawns();
  const starting = f.call("startLinkedThread", input);
  await expect.poll(() => f.spawnCount()).toBe(1);
  expect(
    f.db
      .prepare("SELECT state FROM thread_start_operations WHERE id=?")
      .get(input.operationId),
  ).toEqual({ state: "dispatching" });
  const visible = (await f.call("list", null)) as {
    startOperations: Array<{ id: string; state: string }>;
  };
  expect(visible.startOperations).toContainEqual(
    expect.objectContaining({ id: input.operationId, state: "dispatching" }),
  );
  const changed = task.parse(
    await f.call("updateDetails", {
      id: created.id,
      datasetEpoch: input.datasetEpoch,
      expectedRevision: created.revision,
      title: "Changed while external spawn waits",
      description: "Task coordination is not held by the SDK call.",
    }),
  );
  expect(changed.revision).toBe(created.revision + 1);
  f.releaseSpawns();
  expect(await starting).toMatchObject({ state: "linked" });
});

test("restored prepared and dispatching starts quarantine safely without replay", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Restored start",
    }),
  );
  const input = await startSubmission(f, created);
  input.request.projectId = "project-2";
  expect(await f.call("startLinkedThread", input)).toMatchObject({
    state: "failed-before-dispatch",
  });
  f.db
    .prepare(
      "UPDATE thread_start_operations SET state='prepared',error=NULL WHERE id=?",
    )
    .run(input.operationId);
  let replacement = await f.harness.lifecycle.reload(plugin);
  f.call = replacement.harness.behavior.callRpc;
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  expect(
    await f.call("getStartOperation", {
      id: created.id,
      operationId: input.operationId,
    }),
  ).toMatchObject({
    state: "failed-before-dispatch",
  });
  expect(f.spawnCount()).toBe(0);
  const second = await fixture();
  const secondTask = task.parse(
    await second.call("create", {
      enrollmentId: second.enrolled.id,
      title: "Restored dispatch",
    }),
  );
  const secondInput = await startSubmission(second, secondTask);
  secondInput.request.projectId = "project-2";
  await second.call("startLinkedThread", secondInput);
  second.db
    .prepare(
      "UPDATE thread_start_operations SET state='dispatching',error=NULL WHERE id=?",
    )
    .run(secondInput.operationId);
  replacement = await second.harness.lifecycle.reload(plugin);
  second.call = replacement.harness.behavior.callRpc;
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  expect(
    await second.call("getStartOperation", {
      id: secondTask.id,
      operationId: secondInput.operationId,
    }),
  ).toMatchObject({
    state: "uncertain",
  });
  expect(second.spawnCount()).toBe(0);
});

test("known returned ID retries linking only, handles conflict and requires exact explicit reassignment", async () => {
  const failure = {
    point: "after-awaiting-link" as StartFailurePoint | null,
  };
  const f = await fixture(failure);
  const firstTask = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Awaiting original",
    }),
  );
  const otherTask = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Conflicting owner",
    }),
  );
  const input = await startSubmission(f, firstTask);
  const awaiting = (await f.call("startLinkedThread", input)) as {
    state: string;
    threadId: string;
  };
  expect(awaiting).toMatchObject({
    state: "awaiting-link",
    threadId: "thread-spawn-1",
  });
  const list = (await f.call("list", null)) as { datasetEpoch: string };
  await f.call("linkThread", {
    id: otherTask.id,
    datasetEpoch: list.datasetEpoch,
    threadId: awaiting.threadId,
    expectedCurrentLinkRevision: null,
    reassign: false,
  });
  expect(
    await f.call("retryStartLink", {
      id: firstTask.id,
      operationId: input.operationId,
      datasetEpoch: input.datasetEpoch,
    }),
  ).toMatchObject({ state: "awaiting-link", threadId: awaiting.threadId });
  expect(f.spawnCount()).toBe(1);
  await expect(
    f.call("identifyStartThread", {
      id: firstTask.id,
      operationId: input.operationId,
      datasetEpoch: input.datasetEpoch,
      threadId: "another-thread",
      expectedCurrentLinkRevision: null,
      reassign: false,
    }),
  ).rejects.toThrow(/already recorded/);
  expect(
    await f.call("identifyStartThread", {
      id: firstTask.id,
      operationId: input.operationId,
      datasetEpoch: input.datasetEpoch,
      threadId: awaiting.threadId,
      expectedCurrentLinkRevision: 1,
      reassign: true,
    }),
  ).toMatchObject({ state: "linked", threadId: awaiting.threadId });
  expect(f.spawnCount()).toBe(1);
  expect(
    (
      f.db
        .prepare("SELECT count(*) AS count FROM thread_links WHERE threadId=?")
        .get(awaiting.threadId) as { count: number }
    ).count,
  ).toBe(1);
});

test("stale epoch and unsafe composer environments fail before dispatch and require deliberate quarantine", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Rejected choices",
    }),
  );
  const stale = await startSubmission(f, created, {
    datasetEpoch: randomUUID(),
  });
  await expect(f.call("startLinkedThread", stale)).rejects.toThrow(
    /dataset changed/i,
  );
  expect(f.spawnCount()).toBe(0);
  expect(
    f.db.prepare("SELECT count(*) AS count FROM thread_start_operations").get(),
  ).toEqual({ count: 0 });
  const wrongProject = await startSubmission(f, created);
  wrongProject.request.projectId = "project-2";
  expect(await f.call("startLinkedThread", wrongProject)).toMatchObject({
    state: "failed-before-dispatch",
  });
  await f.call("abandonStartOperation", {
    id: created.id,
    operationId: wrongProject.operationId,
    datasetEpoch: wrongProject.datasetEpoch,
  });
  const unsafeEnvironments: NewThreadRequestPayload["environment"][] = [
    {
      type: "host",
      hostId: "host-other",
      workspace: { type: "unmanaged", path: null },
    },
    {
      type: "host",
      hostId: "host-1",
      workspace: {
        type: "unmanaged",
        path: null,
        branch: { kind: "existing", name: "feat/implicit" },
      },
    },
    {
      type: "host",
      hostId: "host-1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    },
    { type: "project-default" },
  ];
  for (const environment of unsafeEnvironments) {
    const unsafe = await startSubmission(f, created);
    unsafe.request.environment =
      environment as typeof unsafe.request.environment;
    expect(await f.call("startLinkedThread", unsafe)).toMatchObject({
      state: "failed-before-dispatch",
    });
    expect(f.spawnCount()).toBe(0);
    const state = await f.call("abandonStartOperation", {
      id: created.id,
      operationId: unsafe.operationId,
      datasetEpoch: unsafe.datasetEpoch,
    });
    expect(state).toMatchObject({
      state: "failed-before-dispatch",
      abandonedAt: expect.any(String),
    });
  }
});

test("restored epochs reject replay and every recovery mutation without consuming a start slot", async () => {
  const racing = await fixture();
  const racingTask = task.parse(
    await racing.call("create", {
      enrollmentId: racing.enrolled.id,
      title: "Restore during validation",
    }),
  );
  const racingInput = await startSubmission(racing, racingTask);
  racingInput.request.environment = {
    type: "reuse",
    environmentId: "env-main",
  };
  racing.delayEnvironmentGet(1);
  const validating = racing.call("startLinkedThread", racingInput);
  await expect.poll(() => racing.environmentGetCount()).toBe(1);
  racing.db.prepare("UPDATE dataset SET id=?").run(randomUUID());
  racing.releaseEnvironmentGet();
  await expect(validating).rejects.toThrow(/dataset changed/i);
  expect(
    racing.db
      .prepare("SELECT count(*) AS count FROM thread_start_operations")
      .get(),
  ).toEqual({ count: 0 });

  const linked = await fixture();
  const linkedTask = task.parse(
    await linked.call("create", {
      enrollmentId: linked.enrolled.id,
      title: "Linked before restore",
    }),
  );
  const linkedInput = await startSubmission(linked, linkedTask);
  expect(await linked.call("startLinkedThread", linkedInput)).toMatchObject({
    state: "linked",
  });
  linked.db.prepare("UPDATE dataset SET id=?").run(randomUUID());
  await expect(linked.call("startLinkedThread", linkedInput)).rejects.toThrow(
    /dataset changed/i,
  );
  expect(linked.spawnCount()).toBe(1);

  const failure = {
    point: "after-awaiting-link" as StartFailurePoint | null,
  };
  const f = await fixture(failure);
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Restore boundary",
    }),
  );
  const input = await startSubmission(f, created);
  expect(await f.call("startLinkedThread", input)).toMatchObject({
    state: "awaiting-link",
    threadId: "thread-spawn-1",
  });
  const replacementEpoch = randomUUID();
  f.db.prepare("UPDATE dataset SET id=?").run(replacementEpoch);
  const before = f.db
    .prepare(
      "SELECT state,threadId,error,abandonedAt FROM thread_start_operations WHERE id=?",
    )
    .get(input.operationId);
  await expect(f.call("startLinkedThread", input)).rejects.toThrow(
    /dataset changed/i,
  );
  for (const [method, value] of [
    [
      "retryStartLink",
      {
        id: created.id,
        operationId: input.operationId,
        datasetEpoch: input.datasetEpoch,
      },
    ],
    [
      "identifyStartThread",
      {
        id: created.id,
        operationId: input.operationId,
        datasetEpoch: input.datasetEpoch,
        threadId: "thread-spawn-1",
        expectedCurrentLinkRevision: null,
        reassign: false,
      },
    ],
    [
      "abandonStartOperation",
      {
        id: created.id,
        operationId: input.operationId,
        datasetEpoch: input.datasetEpoch,
      },
    ],
  ] as const)
    await expect(f.call(method, value)).rejects.toThrow(/dataset changed/i);
  expect(
    f.db
      .prepare(
        "SELECT state,threadId,error,abandonedAt FROM thread_start_operations WHERE id=?",
      )
      .get(input.operationId),
  ).toEqual(before);
  expect(
    f.db
      .prepare("SELECT count(*) AS count FROM thread_links WHERE taskId=?")
      .get(created.id),
  ).toEqual({ count: 0 });
  const fresh = await startSubmission(f, created, {
    datasetEpoch: input.datasetEpoch,
  });
  await expect(f.call("startLinkedThread", fresh)).rejects.toThrow(
    /dataset changed/i,
  );
  expect(
    f.db.prepare("SELECT count(*) AS count FROM thread_start_operations").get(),
  ).toEqual({ count: 1 });
});

test("abandonment before dispatch and during spawn quarantines without spawning twice or linking", async () => {
  const before = await fixture();
  const beforeTask = task.parse(
    await before.call("create", {
      enrollmentId: before.enrolled.id,
      title: "Abandon before dispatch",
    }),
  );
  const beforeInput = await startSubmission(before, beforeTask);
  beforeInput.request.environment = {
    type: "reuse",
    environmentId: "env-main",
  };
  before.delayEnvironmentGet(2);
  const preparing = before.call("startLinkedThread", beforeInput);
  await expect.poll(() => before.environmentGetCount()).toBe(2);
  const abandonedBefore = await before.call("abandonStartOperation", {
    id: beforeTask.id,
    operationId: beforeInput.operationId,
    datasetEpoch: beforeInput.datasetEpoch,
  });
  expect(abandonedBefore).toMatchObject({ abandonedAt: expect.any(String) });
  before.releaseEnvironmentGet();
  expect(await preparing).toMatchObject({ abandonedAt: expect.any(String) });
  expect(before.spawnCount()).toBe(0);

  const during = await fixture();
  const duringTask = task.parse(
    await during.call("create", {
      enrollmentId: during.enrolled.id,
      title: "Abandon during spawn",
    }),
  );
  const duringInput = await startSubmission(during, duringTask);
  during.delaySpawns();
  const dispatching = during.call("startLinkedThread", duringInput);
  await expect.poll(() => during.spawnCount()).toBe(1);
  await during.call("abandonStartOperation", {
    id: duringTask.id,
    operationId: duringInput.operationId,
    datasetEpoch: duringInput.datasetEpoch,
  });
  during.releaseSpawns();
  expect(await dispatching).toMatchObject({
    state: "awaiting-link",
    threadId: "thread-spawn-1",
    abandonedAt: expect.any(String),
  });
  await expect(
    during.call("retryStartLink", {
      id: duringTask.id,
      operationId: duringInput.operationId,
      datasetEpoch: duringInput.datasetEpoch,
    }),
  ).rejects.toThrow(/abandoned/i);
  expect(during.spawnCount()).toBe(1);
  expect(
    during.db
      .prepare("SELECT count(*) AS count FROM thread_links WHERE taskId=?")
      .get(duringTask.id),
  ).toEqual({ count: 0 });
});

test("abandonment during link completion and identification wins the final transaction", async () => {
  const awaitingFailure = {
    point: "after-awaiting-link" as StartFailurePoint | null,
  };
  const linking = await fixture(awaitingFailure);
  const linkingTask = task.parse(
    await linking.call("create", {
      enrollmentId: linking.enrolled.id,
      title: "Abandon while linking",
    }),
  );
  const linkingInput = await startSubmission(linking, linkingTask);
  await linking.call("startLinkedThread", linkingInput);
  linking.delayThreadGets();
  const retrying = linking.call("retryStartLink", {
    id: linkingTask.id,
    operationId: linkingInput.operationId,
    datasetEpoch: linkingInput.datasetEpoch,
  });
  await expect.poll(() => linking.threadGetCount()).toBe(1);
  await linking.call("abandonStartOperation", {
    id: linkingTask.id,
    operationId: linkingInput.operationId,
    datasetEpoch: linkingInput.datasetEpoch,
  });
  linking.releaseThreadGets();
  expect(await retrying).toMatchObject({ abandonedAt: expect.any(String) });
  expect(
    linking.db
      .prepare("SELECT count(*) AS count FROM thread_links WHERE taskId=?")
      .get(linkingTask.id),
  ).toEqual({ count: 0 });

  const uncertainFailure = {
    point: "after-dispatching" as StartFailurePoint | null,
  };
  const identifying = await fixture(uncertainFailure);
  const identifyingTask = task.parse(
    await identifying.call("create", {
      enrollmentId: identifying.enrolled.id,
      title: "Abandon while identifying",
    }),
  );
  const identifyingInput = await startSubmission(identifying, identifyingTask);
  expect(
    await identifying.call("startLinkedThread", identifyingInput),
  ).toMatchObject({
    state: "uncertain",
  });
  identifying.addThread("thread-human-identified");
  identifying.delayThreadGets();
  const identification = identifying.call("identifyStartThread", {
    id: identifyingTask.id,
    operationId: identifyingInput.operationId,
    datasetEpoch: identifyingInput.datasetEpoch,
    threadId: "thread-human-identified",
    expectedCurrentLinkRevision: null,
    reassign: false,
  });
  await expect.poll(() => identifying.threadGetCount()).toBe(1);
  await identifying.call("abandonStartOperation", {
    id: identifyingTask.id,
    operationId: identifyingInput.operationId,
    datasetEpoch: identifyingInput.datasetEpoch,
  });
  identifying.releaseThreadGets();
  await expect(identification).rejects.toThrow(/abandoned/i);
  await expect(
    identifying.call("identifyStartThread", {
      id: identifyingTask.id,
      operationId: identifyingInput.operationId,
      datasetEpoch: identifyingInput.datasetEpoch,
      threadId: "thread-human-identified",
      expectedCurrentLinkRevision: null,
      reassign: false,
    }),
  ).rejects.toThrow(/abandoned/i);
  expect(
    identifying.db
      .prepare("SELECT count(*) AS count FROM thread_links WHERE taskId=?")
      .get(identifyingTask.id),
  ).toEqual({ count: 0 });
});

test("verified reuse of the existing unmanaged main checkout remains supported", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Reuse main checkout",
    }),
  );
  const input = await startSubmission(f, created);
  input.request.environment = {
    type: "reuse",
    environmentId: "env-main",
  } as typeof input.request.environment;
  expect(await f.call("startLinkedThread", input)).toMatchObject({
    state: "linked",
  });
  expect(f.spawnRequests[0]).toMatchObject({
    environment: { type: "reuse", environmentId: "env-main" },
  });
});
test("failed initialization and lost response recover original identity after reload", async () => {
  const f = await fixture();
  f.setFail(true);
  const t = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Recover" }),
  );
  expect(t.memoryState).toBe("error");
  const replacement = await f.harness.lifecycle.reload(plugin);
  f.call = replacement.harness.behavior.callRpc;
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  f.setFail(false);
  f.setLose();
  expect(
    task.parse(await f.call("retryMemory", { id: t.id })).memoryState,
  ).toBe("error");
  expect(task.parse(await f.call("retryMemory", { id: t.id }))).toMatchObject({
    id: t.id,
    displayId: "FX-1",
    memoryState: "healthy",
    memoryRevision: 1,
  });
});
test("existing bytes, missing initialized files and absent operation metadata are preserved as errors", async () => {
  const f = await fixture();
  f.setFail(true);
  const t = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Conflict" }),
  );
  const { id } = f.db.prepare("SELECT id FROM dataset").get() as { id: string };
  const dir = join(f.root, "host", "datasets", id, "memory");
  await mkdir(dir, { recursive: true });
  const path = join(dir, t.id + ".md");
  await writeFile(path, "preserve me");
  f.setFail(false);
  expect(
    task.parse(await f.call("retryMemory", { id: t.id })).memoryState,
  ).toBe("conflict");
  expect(await readFile(path, "utf8")).toBe("preserve me");
  expect(
    task.parse(await f.call("retryMemory", { id: t.id })).memoryState,
  ).toBe("conflict");
  await rm(path);
  expect(
    task.parse(await f.call("retryMemory", { id: t.id })).memoryState,
  ).toBe("conflict");
  await expect(readFile(path)).rejects.toThrow();
  f.db.prepare("DELETE FROM pending_operations WHERE taskId=?").run(t.id);
  expect(
    task.parse(await f.call("retryMemory", { id: t.id })).memoryState,
  ).toBe("conflict");
  await expect(readFile(path)).rejects.toThrow();
});

test("memory saves serialize revisions, preserve no-op attribution and replay only the latest compatible operation", async () => {
  const f = await fixture();
  const first = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Memory A" }),
  );
  const second = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Memory B" }),
  );
  const initial = (await f.call("readMemory", { id: first.id })) as {
    state: string;
    token: { datasetEpoch: string; memoryRevision: number; memoryHash: string };
    attribution: unknown;
  };
  expect(initial.state).toBe("healthy");
  const operationA = randomUUID();
  const operationB = randomUUID();
  const [accepted, stale] = await Promise.all([
    f.call("saveMemory", {
      id: first.id,
      operationId: operationA,
      token: initial.token,
      content: "# First accepted\n",
    }),
    f.call("saveMemory", {
      id: first.id,
      operationId: operationB,
      token: initial.token,
      content: "# Stale contender\n",
    }),
  ] as const);
  expect(
    [accepted, stale]
      .map((value) => (value as { outcome: string }).outcome)
      .sort(),
  ).toEqual(["saved", "stale"]);
  const saved =
    (accepted as { outcome: string }).outcome === "saved" ? accepted : stale;
  const savedResult = saved as {
    outcome: string;
    token: { datasetEpoch: string; memoryRevision: number; memoryHash: string };
    attribution: unknown;
  };
  const replay = await f.call("saveMemory", {
    id: first.id,
    operationId: operationA,
    token: initial.token,
    content: "# First accepted\n",
  });
  expect(replay).toEqual(saved);
  expect(
    await f.call("saveMemory", {
      id: second.id,
      operationId: operationA,
      token: ((await f.call("readMemory", { id: second.id })) as typeof initial)
        .token,
      content: "# First accepted\n",
    }),
  ).toMatchObject({ outcome: "operation-mismatch" });
  expect(
    await f.call("saveMemory", {
      id: first.id,
      operationId: operationA,
      token: savedResult.token,
      content: "incompatible reuse",
    }),
  ).toMatchObject({ outcome: "operation-mismatch" });

  const beforeNoop = task.parse(
    ((await f.call("list", null)) as { tasks: unknown[] }).tasks.find(
      (value) => (value as { id: string }).id === first.id,
    ),
  );
  const noOp = await f.call("saveMemory", {
    id: first.id,
    operationId: randomUUID(),
    token: savedResult.token,
    content: "# First accepted\n",
  });
  expect(noOp).toMatchObject({
    outcome: "no-op",
    token: savedResult.token,
    attribution: beforeNoop.memoryAttribution,
  });
  const epoch = savedResult.token.datasetEpoch;
  const metadataChanged = task.parse(
    await f.call("updateDetails", {
      id: first.id,
      datasetEpoch: epoch,
      expectedRevision: beforeNoop.revision,
      title: "Metadata only",
      description: "independent",
    }),
  );
  expect(metadataChanged.memoryRevision).toBe(savedResult.token.memoryRevision);
  expect(metadataChanged.memoryAttribution).toEqual(
    beforeNoop.memoryAttribution,
  );

  const fresh = (await f.call("readMemory", {
    id: first.id,
  })) as typeof initial;
  const latestOperation = randomUUID();
  const latest = await f.call("saveMemory", {
    id: first.id,
    operationId: latestOperation,
    token: fresh.token,
    content: "latest",
  });
  expect(latest).toMatchObject({ outcome: "saved" });
  expect(
    await f.call("saveMemory", {
      id: first.id,
      operationId: operationA,
      token: initial.token,
      content: "# First accepted\n",
    }),
  ).toMatchObject({ outcome: "stale" });

  const wrongEpoch = {
    ...(latest as { token: typeof initial.token }).token,
    datasetEpoch: randomUUID(),
  };
  expect(
    await f.call("saveMemory", {
      id: first.id,
      operationId: latestOperation,
      token: wrongEpoch,
      content: "latest",
    }),
  ).toMatchObject({ outcome: "stale" });

  const operationsBefore = (
    f.db
      .prepare("SELECT count(*) AS count FROM memory_operations WHERE taskId=?")
      .get(first.id) as { count: number }
  ).count;
  expect(
    await f.call("saveMemory", {
      id: first.id,
      operationId: randomUUID(),
      token: (latest as { token: typeof initial.token }).token,
      content: "é".repeat(600_000),
    }),
  ).toMatchObject({ outcome: "invalid-content" });
  expect(
    (
      f.db
        .prepare(
          "SELECT count(*) AS count FROM memory_operations WHERE taskId=?",
        )
        .get(first.id) as { count: number }
    ).count,
  ).toBe(operationsBefore);

  let retainedOperationId = "";
  const currentToken = (latest as { token: typeof initial.token }).token;
  for (let index = 0; index < 12; index += 1) {
    retainedOperationId = randomUUID();
    expect(
      await f.call("saveMemory", {
        id: first.id,
        operationId: retainedOperationId,
        token: currentToken,
        content: "latest",
      }),
    ).toMatchObject({ outcome: "no-op" });
    f.db
      .prepare(
        "UPDATE memory_operations SET updatedAt='2026-09-11T00:00:00.000Z' WHERE taskId=?",
      )
      .run(first.id);
  }
  expect(
    (
      f.db
        .prepare(
          "SELECT count(*) AS count FROM memory_operations WHERE taskId=?",
        )
        .get(first.id) as { count: number }
    ).count,
  ).toBeLessThanOrEqual(8);
  expect(
    await f.call("saveMemory", {
      id: first.id,
      operationId: retainedOperationId,
      token: currentToken,
      content: "latest",
    }),
  ).toMatchObject({ outcome: "no-op", operationId: retainedOperationId });
});

test("memory operations reconcile replacement and durability boundaries with real files", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Crashes" }),
  );
  let view = (await f.call("readMemory", { id: created.id })) as {
    state: string;
    content: string;
    token: { datasetEpoch: string; memoryRevision: number; memoryHash: string };
  };
  f.setFailReplace(true);
  const before = randomUUID();
  expect(
    await f.call("saveMemory", {
      id: created.id,
      operationId: before,
      token: view.token,
      content: "not applied",
    }),
  ).toMatchObject({ outcome: "not-applied" });
  expect(
    ((await f.call("readMemory", { id: created.id })) as typeof view).content,
  ).toBe("");
  f.setFailReplace(false);

  view = (await f.call("readMemory", { id: created.id })) as typeof view;
  f.loseReplaceResponse();
  const lostResponseId = randomUUID();
  const lostResponse = await f.call("saveMemory", {
    id: created.id,
    operationId: lostResponseId,
    token: view.token,
    content: "durable despite lost host response",
  });
  expect(lostResponse).toMatchObject({ outcome: "saved" });
  expect(
    await f.call("saveMemory", {
      id: created.id,
      operationId: lostResponseId,
      token: view.token,
      content: "durable despite lost host response",
    }),
  ).toEqual(lostResponse);

  view = (await f.call("readMemory", { id: created.id })) as typeof view;
  f.setConfirmFailures(3);
  const pendingId = randomUUID();
  expect(
    await f.call("saveMemory", {
      id: created.id,
      operationId: pendingId,
      token: view.token,
      content: "renamed awaiting durable confirmation",
    }),
  ).toMatchObject({ outcome: "recovery-pending" });
  const prepared = f.db
    .prepare("SELECT state FROM memory_operations WHERE id=?")
    .get(pendingId) as { state: string };
  expect(prepared.state).toBe("prepared");
  const operationCount = (
    f.db
      .prepare("SELECT count(*) AS count FROM memory_operations WHERE taskId=?")
      .get(created.id) as { count: number }
  ).count;
  expect(
    await f.call("saveMemory", {
      id: created.id,
      operationId: randomUUID(),
      token: view.token,
      content: "renamed awaiting durable confirmation",
    }),
  ).toMatchObject({ outcome: "recovery-pending", operationId: pendingId });
  expect(
    await f.call("restoreKnownMemory", {
      id: created.id,
      operationId: randomUUID(),
      token: view.token,
      observedHash: createHash("sha256")
        .update("renamed awaiting durable confirmation")
        .digest("hex"),
      content: view.content,
    }),
  ).toMatchObject({ outcome: "recovery-pending", operationId: pendingId });
  expect(
    (
      f.db
        .prepare(
          "SELECT count(*) AS count FROM memory_operations WHERE taskId=?",
        )
        .get(created.id) as { count: number }
    ).count,
  ).toBe(operationCount);
  expect(f.db.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(f.db.pragma("synchronous", { simple: true })).toBe(2);
  const replacement = await f.harness.lifecycle.reload(plugin);
  f.call = replacement.harness.behavior.callRpc;
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  expect(await f.call("readMemory", { id: created.id })).toMatchObject({
    state: "healthy",
    content: "renamed awaiting durable confirmation",
    token: { memoryRevision: view.token.memoryRevision + 1 },
  });
});

test("external changes require explicit accept or verified restore, including revision-zero recovery", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "External" }),
  );
  const { id: datasetId } = f.db.prepare("SELECT id FROM dataset").get() as {
    id: string;
  };
  const directory = join(f.root, "host", "datasets", datasetId, "memory");
  const path = join(directory, `${created.id}.md`);
  await writeFile(path, "external valid Markdown");
  let conflict = (await f.call("readMemory", { id: created.id })) as {
    state: string;
    content: string | null;
    observedHash: string | null;
    committedToken: {
      datasetEpoch: string;
      memoryRevision: number;
      memoryHash: string;
    };
    allowedActions: string[];
  };
  expect(conflict).toMatchObject({
    state: "conflict",
    content: "external valid Markdown",
    allowedActions: ["accept-external", "restore-known"],
  });
  const accepted = await f.call("acceptExternalMemory", {
    id: created.id,
    operationId: randomUUID(),
    token: conflict.committedToken,
    observedHash: conflict.observedHash,
  });
  expect(accepted).toMatchObject({
    outcome: "accepted-external",
    attribution: { kind: "unknown-external" },
  });
  await rm(path);
  conflict = (await f.call("readMemory", {
    id: created.id,
  })) as typeof conflict;
  expect(conflict).toMatchObject({
    state: "conflict",
    observedHash: null,
    allowedActions: ["restore-known"],
  });
  const restored = await f.call("restoreKnownMemory", {
    id: created.id,
    operationId: randomUUID(),
    token: conflict.committedToken,
    observedHash: null,
    content: "external valid Markdown",
  });
  expect(restored).toMatchObject({
    outcome: "restored-known",
    token: { memoryRevision: conflict.committedToken.memoryRevision },
  });

  const committedAfterRestore = (
    restored as { token: typeof conflict.committedToken }
  ).token;
  const invalidBytes = Buffer.from([0xff, 0x61]);
  await writeFile(path, invalidBytes);
  conflict = (await f.call("readMemory", {
    id: created.id,
  })) as typeof conflict;
  expect(conflict).toMatchObject({
    state: "conflict",
    allowedActions: ["restore-known"],
    observedHash: createHash("sha256").update(invalidBytes).digest("hex"),
  });
  expect(
    await f.call("restoreKnownMemory", {
      id: created.id,
      operationId: randomUUID(),
      token: committedAfterRestore,
      observedHash: conflict.observedHash,
      content: "external valid Markdown",
    }),
  ).toMatchObject({ outcome: "restored-known" });

  const outside = join(f.root, "outside-memory.md");
  await writeFile(outside, "outside target");
  await rm(path);
  await symlink(outside, path);
  conflict = (await f.call("readMemory", {
    id: created.id,
  })) as typeof conflict;
  expect(conflict).toMatchObject({
    state: "conflict",
    observedHash: null,
    allowedActions: [],
  });
  expect(await readFile(outside, "utf8")).toBe("outside target");
  await rm(path);
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  conflict = (await f.call("readMemory", {
    id: created.id,
  })) as typeof conflict;
  expect(conflict).toMatchObject({
    state: "conflict",
    observedHash: null,
    allowedActions: [],
  });
  expect((await readFile(path)).byteLength).toBe(1024 * 1024 + 1);

  f.setFail(true);
  const initialConflict = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Initial conflict",
    }),
  );
  f.setFail(false);
  const initialPath = join(directory, `${initialConflict.id}.md`);
  await writeFile(initialPath, "pre-existing bytes");
  let initialView = (await f.call("readMemory", {
    id: initialConflict.id,
  })) as typeof conflict;
  expect(initialView).toMatchObject({
    state: "conflict",
    committedToken: { memoryRevision: 0 },
  });
  expect(
    await f.call("acceptExternalMemory", {
      id: initialConflict.id,
      operationId: randomUUID(),
      token: initialView.committedToken,
      observedHash: initialView.observedHash,
    }),
  ).toMatchObject({
    outcome: "accepted-external",
    token: { memoryRevision: 1 },
  });

  f.setFail(true);
  const missingInitial = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Initial missing recovery",
    }),
  );
  f.setFail(false);
  const missingPath = join(directory, `${missingInitial.id}.md`);
  await writeFile(missingPath, "conflict then deleted");
  await f.call("readMemory", { id: missingInitial.id });
  await rm(missingPath);
  initialView = (await f.call("readMemory", {
    id: missingInitial.id,
  })) as typeof conflict;
  expect(initialView).toMatchObject({
    state: "conflict",
    observedHash: null,
    committedToken: { memoryRevision: 0 },
  });
  expect(
    await f.call("restoreKnownMemory", {
      id: missingInitial.id,
      operationId: randomUUID(),
      token: initialView.committedToken,
      observedHash: null,
      content: "",
    }),
  ).toMatchObject({ outcome: "restored-known", token: { memoryRevision: 1 } });
});

test("wire validation rejects empty titles, unknown fields and unnormalized invalid prefixes", async () => {
  const f = await fixture();
  await expect(
    f.call("create", { enrollmentId: f.enrolled.id, title: "  " }),
  ).rejects.toThrow();
  await expect(
    f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Task",
      status: "Completed",
    }),
  ).rejects.toThrow();
  await expect(
    f.call("enroll", {
      projectId: "project-1",
      sourceId: "source-1",
      prefix: "../bad",
    }),
  ).rejects.toThrow();
});

test("project moved off enrolled host blocks capture while preserving tasks", async () => {
  const f = await fixture();
  f.moveSource();
  await expect(
    f.call("create", { enrollmentId: f.enrolled.id, title: "Moved" }),
  ).rejects.toThrow("no longer resolves");
  const list = (await f.call("list", null)) as {
    enrollments: Array<{ availability: string }>;
  };
  expect(list.enrollments[0].availability).toBe("project or host unavailable");
});

test("prefix uniqueness is normalized across different projects", async () => {
  const f = await fixture();
  await expect(
    f.call("enroll", {
      projectId: "project-2",
      sourceId: "source-2",
      prefix: " fx ",
    }),
  ).rejects.toThrow("already enrolled");
});

function toolJson(
  value: Awaited<
    ReturnType<
      Awaited<
        ReturnType<typeof fixture>
      >["harness"]["behavior"]["callAgentTool"]
    >
  >,
) {
  const part =
    typeof value === "string"
      ? value
      : value.content[0]?.type === "text"
        ? value.content[0].text
        : "";
  return JSON.parse(part) as Record<string, unknown>;
}

test("enrolled sessions expose narrow tools while durable links solely authorize calls", async () => {
  const f = await fixture();
  const configured = await f.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ project: { id: "project-1" } }),
  );
  expect(configured.tools.map((value) => value.name)).toEqual([
    "task_workspace_read_current_task",
    "task_workspace_save_memory",
    "task_workspace_ready_for_agent_review",
  ]);
  expect(
    (
      await f.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ project: { id: "outside" } }),
      )
    ).tools,
  ).toEqual([]);
  const unlinked = await f.harness.behavior.callAgentTool(
    "task_workspace_read_current_task",
    {},
    { threadId: "thread-unlinked", projectId: "project-1" },
  );
  expect(unlinked).toMatchObject({ isError: true });
  expect(toolJson(unlinked).message).toContain("not-linked");

  const [a, b] = await Promise.all(
    ["Linked A", "Linked B"].map((title) =>
      f
        .call("create", { enrollmentId: f.enrolled.id, title })
        .then((value) => task.parse(value)),
    ),
  );
  const { datasetEpoch } = (await f.call("list", null)) as {
    datasetEpoch: string;
  };
  f.addThread("thread-one");
  f.addThread("thread-two");
  f.addThread("thread-cross-project", { projectId: "project-2" });
  await expect(
    f.call("inspectThreadCandidate", {
      id: a.id,
      datasetEpoch,
      threadId: "thread-cross-project",
    }),
  ).rejects.toThrow("not enrolled project");
  const candidate = (await f.call("inspectThreadCandidate", {
    id: a.id,
    datasetEpoch,
    threadId: "thread-one",
  })) as { currentLink: null; environmentMismatch: null };
  expect(candidate).toMatchObject({
    currentLink: null,
    environmentMismatch: null,
  });
  const first = (await f.call("linkThread", {
    id: a.id,
    datasetEpoch,
    threadId: "thread-one",
    expectedCurrentLinkRevision: null,
    reassign: false,
  })) as { linkRevision: number };
  await f.call("linkThread", {
    id: a.id,
    datasetEpoch,
    threadId: "thread-two",
    expectedCurrentLinkRevision: null,
    reassign: false,
  });
  expect(first.linkRevision).toBe(1);
  expect(f.sendCount()).toBe(0);
  expect(f.stopCount()).toBe(0);
  const reassigned = (await f.call("linkThread", {
    id: b.id,
    datasetEpoch,
    threadId: "thread-one",
    expectedCurrentLinkRevision: 1,
    reassign: true,
  })) as { linkRevision: number };
  expect(reassigned.linkRevision).toBe(2);
  await expect(
    f.call("linkThread", {
      id: a.id,
      datasetEpoch,
      threadId: "thread-one",
      expectedCurrentLinkRevision: 1,
      reassign: true,
    }),
  ).rejects.toThrow("exact current link revision");
  const read = toolJson(
    await f.harness.behavior.callAgentTool(
      "task_workspace_read_current_task",
      {},
      { threadId: "thread-one", projectId: "project-1" },
    ),
  );
  expect(read).toMatchObject({
    ok: true,
    datasetEpoch,
    linkRevision: 2,
    task: { id: b.id },
  });
  const wrongTrustedProject = await f.harness.behavior.callAgentTool(
    "task_workspace_read_current_task",
    {},
    { threadId: "thread-one", projectId: "project-2" },
  );
  expect(wrongTrustedProject).toMatchObject({ isError: true });
  const list = (await f.call("list", null)) as { tasks: unknown[] };
  expect(
    list.tasks.map((value) => task.parse(value).linkedThreads.length),
  ).toEqual([1, 1]);
});

test("agent save and review enforce current link, project, memory and task epochs at mutation boundaries", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all(
    ["Race A", "Race B"].map((title) =>
      f
        .call("create", { enrollmentId: f.enrolled.id, title })
        .then((value) => task.parse(value)),
    ),
  );
  const { datasetEpoch } = (await f.call("list", null)) as {
    datasetEpoch: string;
  };
  f.addThread("thread-race");
  await f.call("linkThread", {
    id: a.id,
    datasetEpoch,
    threadId: "thread-race",
    expectedCurrentLinkRevision: null,
    reassign: false,
  });
  const read = toolJson(
    await f.harness.behavior.callAgentTool(
      "task_workspace_read_current_task",
      {},
      { threadId: "thread-race", projectId: "project-1" },
    ),
  ) as {
    datasetEpoch: string;
    linkRevision: number;
    task: { revision: number };
    memory: {
      token: {
        datasetEpoch: string;
        memoryRevision: number;
        memoryHash: string;
      };
    };
  };
  f.delayReplacements();
  const operationId = randomUUID();
  const saving = f.harness.behavior.callAgentTool(
    "task_workspace_save_memory",
    {
      operationId,
      expectedLinkRevision: read.linkRevision,
      token: read.memory.token,
      content: "# Agent durable save\n",
    },
    { threadId: "thread-race", projectId: "project-1" },
  );
  await expect
    .poll(
      () =>
        f.harness.experimental_hostRpcCalls.filter(
          (call) => call.method === "replaceMemory",
        ).length,
    )
    .toBe(1);
  const reassigning = f.call("linkThread", {
    id: b.id,
    datasetEpoch,
    threadId: "thread-race",
    expectedCurrentLinkRevision: 1,
    reassign: true,
  });
  f.releaseReplacements();
  expect(toolJson(await saving)).toMatchObject({
    ok: true,
    result: { outcome: "saved", attribution: { threadId: "thread-race" } },
  });
  await expect(reassigning).resolves.toMatchObject({ linkRevision: 2 });
  const replayAfterReassignment = toolJson(
    await f.harness.behavior.callAgentTool(
      "task_workspace_save_memory",
      {
        operationId,
        expectedLinkRevision: 1,
        token: read.memory.token,
        content: "# Agent durable save\n",
      },
      { threadId: "thread-race", projectId: "project-1" },
    ),
  );
  expect(replayAfterReassignment.ok).toBe(false);
  const inProgress = task.parse(
    await f.call("setStatus", {
      id: b.id,
      datasetEpoch,
      expectedRevision: b.revision,
      status: "In progress",
      blockerReason: null,
    }),
  );
  const staleReview = await f.harness.behavior.callAgentTool(
    "task_workspace_ready_for_agent_review",
    {
      datasetEpoch,
      expectedTaskRevision: inProgress.revision - 1,
      expectedLinkRevision: 2,
    },
    { threadId: "thread-race", projectId: "project-1" },
  );
  expect(staleReview).toMatchObject({ isError: true });
  const staleEpoch = await f.harness.behavior.callAgentTool(
    "task_workspace_ready_for_agent_review",
    {
      datasetEpoch: randomUUID(),
      expectedTaskRevision: inProgress.revision,
      expectedLinkRevision: 2,
    },
    { threadId: "thread-race", projectId: "project-1" },
  );
  expect(staleEpoch).toMatchObject({ isError: true });
  const reviewed = toolJson(
    await f.harness.behavior.callAgentTool(
      "task_workspace_ready_for_agent_review",
      {
        datasetEpoch,
        expectedTaskRevision: inProgress.revision,
        expectedLinkRevision: 2,
      },
      { threadId: "thread-race", projectId: "project-1" },
    ),
  );
  expect(reviewed).toMatchObject({
    ok: true,
    task: { status: "Ready for agent review" },
  });
  const repeated = await f.harness.behavior.callAgentTool(
    "task_workspace_ready_for_agent_review",
    {
      datasetEpoch,
      expectedTaskRevision: inProgress.revision + 1,
      expectedLinkRevision: 2,
    },
    { threadId: "thread-race", projectId: "project-1" },
  );
  expect(repeated).toMatchObject({ isError: true });
});

test("thread recovery distinguishes unavailable reads, never stops active work and accepts queued send once", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Recovery" }),
  );
  const { datasetEpoch } = (await f.call("list", null)) as {
    datasetEpoch: string;
  };
  f.addThread("thread-recovery", { status: "active" });
  await f.call("linkThread", {
    id: created.id,
    datasetEpoch,
    threadId: "thread-recovery",
    expectedCurrentLinkRevision: null,
    reassign: false,
  });
  await expect(
    f.call("releaseIdleThreadRuntime", {
      id: created.id,
      datasetEpoch,
      threadId: "thread-recovery",
      expectedLinkRevision: 1,
    }),
  ).rejects.toThrow("not idle");
  expect(f.stopCount()).toBe(0);
  f.removeThread("thread-recovery");
  expect(
    await f.call("refreshThreadLink", {
      id: created.id,
      datasetEpoch,
      threadId: "thread-recovery",
      expectedLinkRevision: 1,
    }),
  ).toMatchObject({ availability: "unavailable", linkRevision: 1 });
  f.addThread("thread-recovery", {
    status: "idle",
    deletedAt: Date.now(),
  });
  expect(
    await f.call("refreshThreadLink", {
      id: created.id,
      datasetEpoch,
      threadId: "thread-recovery",
      expectedLinkRevision: 1,
    }),
  ).toMatchObject({ availability: "missing", linkRevision: 1 });
  f.addThread("thread-recovery", { status: "idle" });
  await expect(
    f.call("releaseIdleThreadRuntime", {
      id: created.id,
      datasetEpoch,
      threadId: "thread-recovery",
      expectedLinkRevision: 1,
    }),
  ).resolves.toMatchObject({ released: true });
  expect(f.stopCount()).toBe(1);
  f.setNextDelivery("queued");
  await expect(
    f.call("sendTaskContext", {
      id: created.id,
      datasetEpoch,
      threadId: "thread-recovery",
      expectedLinkRevision: 1,
    }),
  ).resolves.toMatchObject({ delivery: "queued" });
  expect(f.sendCount()).toBe(1);
  const sent = f.harness.inspection.sdk.callsTo("threads.send")[0]?.[0];
  expect(JSON.stringify(sent)).toContain("# Current task context");
  expect(JSON.stringify(sent)).toContain(created.displayId);
  expect(JSON.stringify(sent)).toContain("not a transcript");
});

test("enrollment reassociation rejects a task captured while its acquired lock set was waiting", async () => {
  const f = await fixture();
  const first = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Authority holder",
    }),
  );
  const { datasetEpoch } = (await f.call("list", null)) as {
    datasetEpoch: string;
  };
  f.addThread("thread-authority");
  await f.call("linkThread", {
    id: first.id,
    datasetEpoch,
    threadId: "thread-authority",
    expectedCurrentLinkRevision: null,
    reassign: false,
  });
  const read = toolJson(
    await f.harness.behavior.callAgentTool(
      "task_workspace_read_current_task",
      {},
      { threadId: "thread-authority", projectId: "project-1" },
    ),
  ) as {
    linkRevision: number;
    memory: {
      token: {
        datasetEpoch: string;
        memoryRevision: number;
        memoryHash: string;
      };
    };
  };
  f.delayReplacements();
  const saving = f.harness.behavior.callAgentTool(
    "task_workspace_save_memory",
    {
      operationId: randomUUID(),
      expectedLinkRevision: read.linkRevision,
      token: read.memory.token,
      content: "authority save",
    },
    { threadId: "thread-authority", projectId: "project-1" },
  );
  await expect
    .poll(
      () =>
        f.harness.experimental_hostRpcCalls.filter(
          (call) => call.method === "replaceMemory",
        ).length,
    )
    .toBe(1);
  const reassociation = f.call("reassociateEnrollment", {
    enrollmentId: f.enrolled.id,
    datasetEpoch,
    expectedEnrollmentRevision: f.enrolled.revision + 1,
    projectId: "project-2",
    sourceId: "source-2",
    environmentId: "env-second",
  });
  await expect
    .poll(() =>
      f.harness.experimental_hostRpcCalls.some(
        (call) =>
          call.method === "inspectRepository" &&
          (call.input as { repository?: string }).repository === "/fixture-2",
      ),
    )
    .toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await f.call("create", {
    enrollmentId: f.enrolled.id,
    title: "Captured while correction waited",
  });
  f.releaseReplacements();
  expect(toolJson(await saving)).toMatchObject({ ok: true });
  await expect(reassociation).rejects.toThrow(
    /Enrollment changed|task set changed/,
  );
  const list = (await f.call("list", null)) as {
    tasks: unknown[];
    enrollments: Array<{ projectId: string }>;
  };
  expect(list.tasks).toHaveLength(2);
  expect(list.enrollments[0]?.projectId).toBe("project-1");
});

test("manual workflow persists with dataset revisions, separate relationships, cycles and paths", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all(
    ["Alpha", "Beta"].map((title) =>
      f
        .call("create", { enrollmentId: f.enrolled.id, title })
        .then((value) => task.parse(value)),
    ),
  );
  const firstList = (await f.call("list", null)) as {
    datasetEpoch: string;
  };
  await expect(
    f.call("setStatus", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: a.revision,
      status: "Blocked",
      blockerReason: null,
    }),
  ).rejects.toThrow("reason is required");
  const blocked = task.parse(
    await f.call("setStatus", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: a.revision,
      status: "Blocked",
      blockerReason: "Human must approve access",
    }),
  );
  expect(blocked).toMatchObject({
    status: "Blocked",
    blockerReason: "Human must approve access",
    revision: 2,
    attribution: "rpc:setStatus",
    memoryRevision: 1,
  });
  expect(Date.parse(blocked.attributionAt)).not.toBeNaN();
  await expect(
    f.call("updateDetails", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: a.revision,
      title: "Stale",
      description: "",
    }),
  ).rejects.toThrow("reload");
  await expect(
    f.call("updateDetails", {
      id: a.id,
      datasetEpoch: randomUUID(),
      expectedRevision: blocked.revision,
      title: "Wrong epoch",
      description: "",
    }),
  ).rejects.toThrow("Dataset changed");
  const related = task.parse(
    await f.call("replaceRelationships", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: blocked.revision,
      dependencyIds: [b.id],
      blockerTaskIds: [b.id],
    }),
  );
  expect(related).toMatchObject({
    status: "Blocked",
    dependencyIds: [b.id],
    blockerTaskIds: [b.id],
  });
  await expect(
    f.call("replaceRelationships", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: related.revision,
      dependencyIds: [b.id, b.id],
      blockerTaskIds: [],
    }),
  ).rejects.toThrow("Duplicate");
  await expect(
    f.call("replaceRelationships", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: related.revision,
      dependencyIds: [a.id],
      blockerTaskIds: [],
    }),
  ).rejects.toThrow("cannot reference itself");
  const bRelated = task.parse(
    await f.call("replaceRelationships", {
      id: b.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: b.revision,
      dependencyIds: [a.id],
      blockerTaskIds: [],
    }),
  );
  expect(bRelated.status).toBe("Inbox");
  const cycleList = (await f.call("list", null)) as { tasks: unknown[] };
  expect(
    cycleList.tasks.map((value) => task.parse(value).dependencyCycle),
  ).toEqual([true, true]);
  const currentA = task.parse(cycleList.tasks[0]);
  console.log(
    "MW-DEBUG",
    JSON.stringify({
      revA: currentA.revision,
      revB: task.parse(cycleList.tasks[1]).revision,
    }),
  );
  const withPath = task.parse(
    await f.call("replacePaths", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: currentA.revision,
      paths: [{ path: "/reference/only", label: "Design" }],
    }),
  );
  expect(withPath.paths[0]).toMatchObject({
    hostId: "host-1",
    path: "/reference/only",
    label: "Design",
  });
  const pathId = withPath.paths[0]!.id;
  const unblocked = task.parse(
    await f.call("setStatus", {
      id: a.id,
      datasetEpoch: firstList.datasetEpoch,
      expectedRevision: withPath.revision,
      status: "Ready to implement",
      blockerReason: null,
    }),
  );
  expect(unblocked).toMatchObject({
    status: "Ready to implement",
    blockerReason: null,
    dependencyIds: [b.id],
    blockerTaskIds: [b.id],
  });
  const replacement = await f.harness.lifecycle.reload(plugin);
  f.call = replacement.harness.behavior.callRpc;
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  const persisted = (await f.call("list", null)) as { tasks: unknown[] };
  expect(task.parse(persisted.tasks[0])).toMatchObject({
    id: a.id,
    displayId: "FX-1",
    status: "Ready to implement",
    dependencyIds: [b.id],
    blockerTaskIds: [b.id],
    paths: [{ id: pathId, path: "/reference/only" }],
  });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

test("incomplete memory blocks task mutations but later memory conflicts remain independent", async () => {
  const f = await fixture();
  f.setFail(true);
  const pending = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Pending" }),
  );
  const list = (await f.call("list", null)) as { datasetEpoch: string };
  await expect(
    f.call("setStatus", {
      id: pending.id,
      datasetEpoch: list.datasetEpoch,
      expectedRevision: pending.revision,
      status: "Research",
      blockerReason: null,
    }),
  ).rejects.toThrow("initialization must recover");
  f.setFail(false);
  const healthy = task.parse(await f.call("retryMemory", { id: pending.id }));
  const { id: datasetId } = f.db.prepare("SELECT id FROM dataset").get() as {
    id: string;
  };
  const path = join(
    f.root,
    "host",
    "datasets",
    datasetId,
    "memory",
    pending.id + ".md",
  );
  await writeFile(path, "external change");
  expect(
    task.parse(await f.call("retryMemory", { id: pending.id })).memoryState,
  ).toBe("conflict");
  expect(
    task.parse(
      await f.call("updateDetails", {
        id: pending.id,
        datasetEpoch: list.datasetEpoch,
        expectedRevision: healthy.revision,
        title: "Metadata still independent",
        description: "# Safe",
      }),
    ),
  ).toMatchObject({ title: "Metadata still independent", memoryRevision: 1 });
  expect(await readFile(path, "utf8")).toBe("external change");
});

test("initial memory recovery gates preparation while later memory conflicts remain independent", async () => {
  const f = await fixture();
  f.setFail(true);
  const pending = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Preparation memory gate",
    }),
  );
  const epoch = ((await f.call("list", null)) as { datasetEpoch: string })
    .datasetEpoch;
  await expect(
    f.call("selectRepositoryEnvironment", {
      id: pending.id,
      datasetEpoch: epoch,
      expectedRepositoryRevision: pending.repositoryPreparation.revision,
      environmentId: "env-main",
    }),
  ).rejects.toThrow("initialization must recover");
  expect(f.mutationCount()).toBe(0);
  f.setFail(false);
  const healthy = task.parse(await f.call("retryMemory", { id: pending.id }));
  const { id: datasetId } = f.db.prepare("SELECT id FROM dataset").get() as {
    id: string;
  };
  const memoryPath = join(
    f.root,
    "host",
    "datasets",
    datasetId,
    "memory",
    pending.id + ".md",
  );
  await writeFile(memoryPath, "later external conflict");
  expect(
    task.parse(await f.call("retryMemory", { id: pending.id })).memoryState,
  ).toBe("conflict");
  const selected = (await f.call("selectRepositoryEnvironment", {
    id: pending.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: healthy.repositoryPreparation.revision,
    environmentId: "env-main",
  })) as typeof healthy.repositoryPreparation;
  expect(selected.observation.state).toBe("selected");
});

test("explicit preparation creates empty independent and stacked branches without task lifecycle side effects", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all(
    ["Independent", "Stacked"].map((title) =>
      f.call("create", { enrollmentId: f.enrolled.id, title }),
    ),
  ).then((values) => values.map((value) => task.parse(value)));
  const initial = (await f.call("list", null)) as {
    datasetEpoch: string;
    tasks: unknown[];
  };
  let aPreparation = a.repositoryPreparation;
  let bPreparation = b.repositoryPreparation;
  aPreparation = (await f.call("selectRepositoryEnvironment", {
    id: a.id,
    datasetEpoch: initial.datasetEpoch,
    expectedRepositoryRevision: aPreparation.revision,
    environmentId: "env-main",
  })) as typeof aPreparation;
  bPreparation = (await f.call("selectRepositoryEnvironment", {
    id: b.id,
    datasetEpoch: initial.datasetEpoch,
    expectedRepositoryRevision: bPreparation.revision,
    environmentId: "env-main",
  })) as typeof bPreparation;
  aPreparation = (await f.call("prepareRepository", {
    id: a.id,
    datasetEpoch: initial.datasetEpoch,
    expectedRepositoryRevision: aPreparation.revision,
    action: "create-independent",
    branchName: "task/independent",
    parentBranchName: null,
  })) as typeof aPreparation;
  expect(aPreparation).toMatchObject({
    branchName: "task/independent",
    parentBranchName: null,
    observation: { state: "ready" },
  });
  bPreparation = (await f.call("prepareRepository", {
    id: b.id,
    datasetEpoch: initial.datasetEpoch,
    expectedRepositoryRevision: bPreparation.revision,
    action: "create-stacked",
    branchName: "task/stacked",
    parentBranchName: "task/independent",
  })) as typeof bPreparation;
  expect(bPreparation.observation.state).toBe("ready");
  expect(f.appliedStacks).toEqual([["task/stacked", "task/independent"]]);
  const after = (await f.call("list", null)) as { tasks: unknown[] };
  const [currentA, currentB] = after.tasks.map((value) => task.parse(value));
  expect(currentA.repositoryPreparation.observation.state).toBe("ready");
  expect(currentB.repositoryPreparation.observation.state).toBe("ready");
  expect(currentA).toMatchObject({ status: "Inbox", revision: 1 });
  expect(currentB).toMatchObject({ status: "Inbox", revision: 1 });
  expect(
    currentA.repositoryPreparation.observation.combinedWorkingCopy,
  ).toMatchObject({ hasChanges: true, changeCount: 2 });
  expect(JSON.stringify(currentA.repositoryPreparation)).not.toMatch(
    /commitId|stackId|cliId|sha/i,
  );
  const mutationsBeforeRelationship = f.mutationCount();
  await f.call("replaceRelationships", {
    id: b.id,
    datasetEpoch: initial.datasetEpoch,
    expectedRevision: currentB.revision,
    dependencyIds: [a.id],
    blockerTaskIds: [],
  });
  expect(f.mutationCount()).toBe(mutationsBeforeRelationship);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

test("unapplied, renamed, missing and merged branches remain exact recoverable observations", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Recovery",
    }),
  );
  const epoch = ((await f.call("list", null)) as { datasetEpoch: string })
    .datasetEpoch;
  let preparation = (await f.call("selectRepositoryEnvironment", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: created.repositoryPreparation.revision,
    environmentId: "env-main",
  })) as typeof created.repositoryPreparation;
  f.localBranches.add("task/recovery");
  f.appliedStacks.push(["task/recovery"]);
  preparation = (await f.call("prepareRepository", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: preparation.revision,
    action: "associate-independent",
    branchName: "task/recovery",
    parentBranchName: null,
  })) as typeof preparation;
  f.appliedStacks.splice(0);
  let listed = (await f.call("list", null)) as { tasks: unknown[] };
  expect(
    task.parse(listed.tasks[0]).repositoryPreparation.observation.state,
  ).toBe("unapplied");
  expect(f.mutationCount()).toBe(0);
  f.localBranches.delete("task/recovery");
  f.localBranches.add("task/renamed");
  listed = (await f.call("list", null)) as { tasks: unknown[] };
  const renamed = task.parse(listed.tasks[0]).repositoryPreparation;
  expect(renamed.branchName).toBe("task/recovery");
  expect(renamed.observation.state).toBe("missing");
  expect(renamed.observation.message).toContain("no SHA");
  f.localBranches.delete("task/renamed");
  listed = (await f.call("list", null)) as { tasks: unknown[] };
  expect(
    task.parse(listed.tasks[0]).repositoryPreparation.observation.state,
  ).toBe("missing");
  f.localBranches.add("task/recovery");
  f.appliedStacks.push(["task/recovery"]);
  f.mergedBranches.add("task/recovery");
  listed = (await f.call("list", null)) as { tasks: unknown[] };
  const merged = task.parse(listed.tasks[0]);
  expect(merged.repositoryPreparation.observation.state).toBe("merged");
  expect(merged.status).toBe("Inbox");
  expect(merged.repositoryPreparation.branchName).toBe("task/recovery");
});

test("wrong project, host, path, worktree and unavailable environments are rejected without mutation", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Wrong" }),
  );
  const epoch = ((await f.call("list", null)) as { datasetEpoch: string })
    .datasetEpoch;
  const base = { ...f.environment };
  const cases = [
    { projectId: "project-2" },
    { hostId: "host-other" },
    { path: "/wrong" },
    { isWorktree: true, managed: true },
  ];
  for (const [index, override] of cases.entries()) {
    f.environments.set(`env-wrong-${index}`, {
      ...base,
      ...override,
      id: `env-wrong-${index}`,
    });
    await expect(
      f.call("selectRepositoryEnvironment", {
        id: created.id,
        datasetEpoch: epoch,
        expectedRepositoryRevision: created.repositoryPreparation.revision,
        environmentId: `env-wrong-${index}`,
      }),
    ).rejects.toThrow();
  }
  await expect(
    f.call("selectRepositoryEnvironment", {
      id: created.id,
      datasetEpoch: epoch,
      expectedRepositoryRevision: created.repositoryPreparation.revision,
      environmentId: "env-absent",
    }),
  ).rejects.toThrow("unavailable");
  expect(f.mutationCount()).toBe(0);
});

test("repository operations serialize stale requests and reject post-mutation mismatches", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Race" }),
  );
  const epoch = ((await f.call("list", null)) as { datasetEpoch: string })
    .datasetEpoch;
  let preparation = (await f.call("selectRepositoryEnvironment", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: created.repositoryPreparation.revision,
    environmentId: "env-main",
  })) as typeof created.repositoryPreparation;
  f.delayInspects();
  const first = f.call("prepareRepository", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: preparation.revision,
    action: "create-independent",
    branchName: "task/first",
    parentBranchName: null,
  });
  const stale = f.call("prepareRepository", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: preparation.revision,
    action: "create-independent",
    branchName: "task/stale",
    parentBranchName: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.mutationCount()).toBe(0);
  f.releaseInspects();
  preparation = (await first) as typeof preparation;
  await expect(stale).rejects.toThrow("changed");
  expect(f.mutationCount()).toBe(1);
  expect(f.localBranches.has("task/stale")).toBe(false);
  f.setPostMutationMismatch(true);
  await expect(
    f.call("prepareRepository", {
      id: created.id,
      datasetEpoch: epoch,
      expectedRepositoryRevision: preparation.revision,
      action: "create-independent",
      branchName: "task/mismatch",
      parentBranchName: null,
    }),
  ).rejects.toThrow("state changed");
  const after = (await f.call("list", null)) as { tasks: unknown[] };
  expect(task.parse(after.tasks[0]).repositoryPreparation.branchName).toBe(
    "task/first",
  );
});

test("repository correction waits behind an in-flight preparation inspection", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Queue" }),
  );
  const epoch = ((await f.call("list", null)) as { datasetEpoch: string })
    .datasetEpoch;
  const selected = (await f.call("selectRepositoryEnvironment", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: created.repositoryPreparation.revision,
    environmentId: "env-main",
  })) as typeof created.repositoryPreparation;
  const beforeInspectCalls = f.harness.experimental_hostRpcCalls.filter(
    (call) => call.method === "inspectRepository",
  ).length;
  f.delayInspects();
  const preparing = f.call("prepareRepository", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: selected.revision,
    action: "create-independent",
    branchName: "task/queued",
    parentBranchName: null,
  });
  const correcting = f.call("reassociateEnrollment", {
    enrollmentId: f.enrolled.id,
    datasetEpoch: epoch,
    expectedEnrollmentRevision: f.enrolled.revision + 1,
    projectId: "project-2",
    sourceId: "source-2",
    environmentId: "env-second",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    f.harness.experimental_hostRpcCalls.filter(
      (call) => call.method === "inspectRepository",
    ).length,
  ).toBe(beforeInspectCalls + 1);
  expect(f.mutationCount()).toBe(0);
  f.releaseInspects();
  await preparing;
  const corrected = enrollment.parse(await correcting);
  expect(corrected.projectId).toBe("project-2");
  expect(f.mutationCount()).toBe(1);
});

async function attachedWayfinder(f: Awaited<ReturnType<typeof fixture>>) {
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Wayfinder fixture",
    }),
  );
  const epoch = ((await f.call("list", null)) as { datasetEpoch: string })
    .datasetEpoch;
  let preparation = (await f.call("selectRepositoryEnvironment", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: created.repositoryPreparation.revision,
    environmentId: "env-main",
  })) as typeof created.repositoryPreparation;
  preparation = (await f.call("prepareRepository", {
    id: created.id,
    datasetEpoch: epoch,
    expectedRepositoryRevision: preparation.revision,
    action: "create-independent",
    branchName: "task/wayfinder-fixture",
    parentBranchName: null,
  })) as typeof preparation;
  expect(preparation.observation.state).toBe("ready");

  const inspected = (await f.call("inspectWayfinderSource", {
    id: created.id,
    datasetEpoch: epoch,
    mapPath: "planning/map.md",
    selectedDirectory: null,
  })) as { selectedDirectory: string; status: string };
  expect(inspected).toMatchObject({
    status: "ready",
    selectedDirectory: "planning/tickets",
  });
  const attachment = (await f.call("saveWayfinderAttachment", {
    id: created.id,
    datasetEpoch: epoch,
    expectedAttachmentRevision: 0,
    mapPath: "planning/map.md",
    selectedDirectory: "planning/tickets",
  })) as { revision: number; mapPath: string; selectedDirectory: string };
  return { created, epoch, attachment };
}

test("Wayfinder attachment persists explicit identity and reads only a currently ready prepared workspace", async () => {
  const f = await fixture();
  const { created, epoch, attachment } = await attachedWayfinder(f);
  expect(attachment).toMatchObject({
    revision: 1,
    mapPath: "planning/map.md",
    selectedDirectory: "planning/tickets",
  });
  const listed = (await f.call("list", null)) as { tasks: unknown[] };
  expect(
    task.parse(
      listed.tasks.find((value) => (value as { id: string }).id === created.id),
    ).wayfinderAttachment,
  ).toEqual(expect.objectContaining(attachment));

  const viewId = randomUUID();
  const view = (await f.call("readWayfinderView", {
    id: created.id,
    datasetEpoch: epoch,
    viewId,
  })) as {
    workspaceLabel: string;
    graph: { frontier: { knownReadyPaths: string[] } };
  };
  expect(view).toMatchObject({
    workspaceLabel: "Combined working-copy view",
    graph: {
      frontier: {
        knownReadyPaths: ["planning/tickets/01-first.md"],
      },
    },
  });
  expect(
    f.harness.experimental_hostRpcCalls.some(
      (call) => call.method === "startWayfinderWatch",
    ),
  ).toBe(true);
  await f.call("closeWayfinderView", { viewId });
  expect(
    f.harness.experimental_hostRpcCalls.some(
      (call) => call.method === "stopWayfinderWatch",
    ),
  ).toBe(true);
  f.db
    .prepare("UPDATE wayfinder_attachments SET repository=? WHERE taskId=?")
    .run("/older-repository", created.id);
  await expect(
    f.call("readWayfinderView", {
      id: created.id,
      datasetEpoch: epoch,
      viewId: randomUUID(),
    }),
  ).rejects.toThrow(/older repository identity/i);
  await expect(
    f.call("saveWayfinderAttachment", {
      id: created.id,
      datasetEpoch: epoch,
      expectedAttachmentRevision: 0,
      mapPath: "planning/map.md",
      selectedDirectory: "planning/tickets",
    }),
  ).rejects.toThrow(/changed/i);
});

test("Wayfinder close tombstones reads before source and watch setup finish", async () => {
  const f = await fixture();
  const { created, epoch } = await attachedWayfinder(f);

  f.delayNextWayfinderRead();
  const sourceViewId = randomUUID();
  const readDuringSource = f.call("readWayfinderView", {
    id: created.id,
    datasetEpoch: epoch,
    viewId: sourceViewId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.call("closeWayfinderView", { viewId: sourceViewId });
  f.releaseNextWayfinderRead();
  await expect(readDuringSource).rejects.toThrow(/closed or superseded/i);
  await expect(
    f.call("readWayfinderView", {
      id: created.id,
      datasetEpoch: epoch,
      viewId: sourceViewId,
    }),
  ).rejects.toThrow(/drawer was closed/i);

  const viewId = randomUUID();
  f.delayNextWayfinderWatch();
  const readDuringWatch = f.call("readWayfinderView", {
    id: created.id,
    datasetEpoch: epoch,
    viewId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.call("closeWayfinderView", { viewId });
  f.releaseNextWayfinderWatch();
  await expect(readDuringWatch).rejects.toThrow(/closed or superseded/i);
  const started = f.harness.experimental_hostRpcCalls.filter(
    (call) => call.method === "startWayfinderWatch",
  );
  const stopped = f.harness.experimental_hostRpcCalls.filter(
    (call) => call.method === "stopWayfinderWatch",
  );
  expect(stopped.length).toBeGreaterThanOrEqual(started.length);
});

test("Wayfinder reversed reads cannot replace the newest generation watcher", async () => {
  const f = await fixture();
  const { created, epoch } = await attachedWayfinder(f);
  const viewId = randomUUID();
  f.delayNextWayfinderRead();
  const oldRead = f.call("readWayfinderView", {
    id: created.id,
    datasetEpoch: epoch,
    viewId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newRead = f.call("readWayfinderView", {
    id: created.id,
    datasetEpoch: epoch,
    viewId,
  });
  await expect(newRead).resolves.toMatchObject({ refreshState: "current" });
  const newestWatch = (
    f.harness.experimental_hostRpcCalls
      .filter((call) => call.method === "startWayfinderWatch")
      .at(-1)?.input as { watchId: string }
  ).watchId;
  f.releaseNextWayfinderRead();
  await expect(oldRead).rejects.toThrow(/superseded/i);
  expect(
    f.harness.experimental_hostRpcCalls
      .filter((call) => call.method === "stopWayfinderWatch")
      .some(
        (call) => (call.input as { watchId: string }).watchId === newestWatch,
      ),
  ).toBe(false);
  await f.call("closeWayfinderView", { viewId });
  expect(
    f.harness.experimental_hostRpcCalls
      .filter((call) => call.method === "stopWayfinderWatch")
      .some(
        (call) => (call.input as { watchId: string }).watchId === newestWatch,
      ),
  ).toBe(true);
});

test("Wayfinder rejects attachment and dataset changes during watch setup", async () => {
  for (const change of ["attachment", "dataset"] as const) {
    const f = await fixture();
    const { created, epoch } = await attachedWayfinder(f);
    f.delayNextWayfinderWatch();
    const pending = f.call("readWayfinderView", {
      id: created.id,
      datasetEpoch: epoch,
      viewId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (change === "attachment")
      f.db
        .prepare(
          "UPDATE wayfinder_attachments SET revision=revision+1 WHERE taskId=?",
        )
        .run(created.id);
    else f.db.prepare("UPDATE dataset SET id=?").run(randomUUID());
    f.releaseNextWayfinderWatch();
    await expect(pending).rejects.toThrow(/changed|dataset/i);
  }
});

test("Wayfinder rereads attachment authority after the final async workspace validation", async () => {
  const f = await fixture();
  const { created, epoch } = await attachedWayfinder(f);
  const beforeEnvironmentReads = f.environmentGetCount();
  const finalValidationCall = beforeEnvironmentReads + 4;
  f.delayEnvironmentGet(finalValidationCall);
  const pending = f.call("readWayfinderView", {
    id: created.id,
    datasetEpoch: epoch,
    viewId: randomUUID(),
  });
  await waitUntil(() => f.environmentGetCount() === finalValidationCall);
  f.db
    .prepare(
      "UPDATE wayfinder_attachments SET revision=revision+1 WHERE taskId=?",
    )
    .run(created.id);
  f.releaseEnvironmentGet();
  await expect(pending).rejects.toThrow(/attachment|workspace/i);
  const newestWatch = (
    f.harness.experimental_hostRpcCalls
      .filter((call) => call.method === "startWayfinderWatch")
      .at(-1)?.input as { watchId: string }
  ).watchId;
  expect(
    f.harness.experimental_hostRpcCalls
      .filter((call) => call.method === "stopWayfinderWatch")
      .some(
        (call) => (call.input as { watchId: string }).watchId === newestWatch,
      ),
  ).toBe(true);
});

test("Wayfinder synchronously rejects durable changes during previous-watch disposal", async () => {
  for (const change of ["dataset", "attachment", "preparation"] as const) {
    const f = await fixture();
    const { created, epoch } = await attachedWayfinder(f);
    const viewId = randomUUID();
    await f.call("readWayfinderView", {
      id: created.id,
      datasetEpoch: epoch,
      viewId,
    });
    const previousWatch = (
      f.harness.experimental_hostRpcCalls
        .filter((call) => call.method === "startWayfinderWatch")
        .at(-1)?.input as { watchId: string }
    ).watchId;
    f.delayNextWayfinderStop();
    const stopsBefore = f.harness.experimental_hostRpcCalls.filter(
      (call) => call.method === "stopWayfinderWatch",
    ).length;
    const pending = f.call("readWayfinderView", {
      id: created.id,
      datasetEpoch: epoch,
      viewId,
    });
    await waitUntil(
      () =>
        f.harness.experimental_hostRpcCalls.filter(
          (call) => call.method === "stopWayfinderWatch",
        ).length ===
        stopsBefore + 1,
    );
    const newestWatch = (
      f.harness.experimental_hostRpcCalls
        .filter((call) => call.method === "startWayfinderWatch")
        .at(-1)?.input as { watchId: string }
    ).watchId;
    expect(newestWatch).not.toBe(previousWatch);
    if (change === "dataset")
      f.db.prepare("UPDATE dataset SET id=?").run(randomUUID());
    else if (change === "attachment")
      f.db
        .prepare(
          "UPDATE wayfinder_attachments SET revision=revision+1 WHERE taskId=?",
        )
        .run(created.id);
    else
      f.db
        .prepare(
          "UPDATE repository_workspaces SET revision=revision+1 WHERE taskId=?",
        )
        .run(created.id);
    f.releaseNextWayfinderStop();
    await expect(pending).rejects.toThrow(/dataset|attachment|workspace/i);
    await waitUntil(() =>
      f.harness.experimental_hostRpcCalls
        .filter((call) => call.method === "stopWayfinderWatch")
        .some(
          (call) => (call.input as { watchId: string }).watchId === newestWatch,
        ),
    );
  }
});

test("explicit enrollment reassociation preserves task identities and prefix", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", {
      enrollmentId: f.enrolled.id,
      title: "Keep identity",
    }),
  );
  const epoch = ((await f.call("list", null)) as { datasetEpoch: string })
    .datasetEpoch;
  const corrected = enrollment.parse(
    await f.call("reassociateEnrollment", {
      enrollmentId: f.enrolled.id,
      datasetEpoch: epoch,
      expectedEnrollmentRevision: f.enrolled.revision + 1,
      projectId: "project-2",
      sourceId: "source-2",
      environmentId: "env-second",
    }),
  );
  expect(corrected).toMatchObject({
    id: f.enrolled.id,
    projectId: "project-2",
    prefix: "FX",
    nextNumber: 2,
  });
  const after = (await f.call("list", null)) as { tasks: unknown[] };
  const retained = task.parse(after.tasks[0]);
  expect(retained).toMatchObject({
    id: created.id,
    displayId: created.displayId,
    number: created.number,
    status: created.status,
    memoryRevision: created.memoryRevision,
  });
  expect(retained.repositoryPreparation).toMatchObject({
    projectId: "project-2",
    repository: "/fixture-2",
    environmentId: "env-second",
  });
});

test("delete task keeps BB threads, removes relationships, rejects stale requests and never reuses numbers", async () => {
  const f = await fixture();
  f.addThread("thread-one");
  f.addThread("thread-two");
  const a = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Delete me" }),
  );
  const b = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Keep me" }),
  );
  const { datasetEpoch } = (await f.call("list", null)) as {
    datasetEpoch: string;
  };
  for (const threadId of ["thread-one", "thread-two"])
    await f.call("linkThread", {
      id: a.id,
      datasetEpoch,
      threadId,
      expectedCurrentLinkRevision: null,
      reassign: false,
    });
  f.db
    .prepare(
      "INSERT INTO task_relationships(taskId,targetTaskId,kind) VALUES(?,?,'depends-on')",
    )
    .run(b.id, a.id);
  const current = ((await f.call("list", null)) as { tasks: unknown[] }).tasks
    .map((t) => task.parse(t))
    .find((t) => t.id === a.id)!;
  const input = { id: a.id, datasetEpoch, expectedRevision: current.revision };
  await expect(
    f.call("deleteTask", { ...input, datasetEpoch: randomUUID() }),
  ).rejects.toThrow(/dataset/i);
  await expect(
    f.call("deleteTask", { ...input, expectedRevision: current.revision + 1 }),
  ).rejects.toThrow(/changed/i);
  const callsBefore = f.harness.inspection.sdk.calls.length;
  await f.call("deleteTask", input);
  expect(
    f.harness.inspection.sdk.calls
      .slice(callsBefore)
      .filter((c) => c.path.startsWith("threads.")),
  ).toEqual([]);
  expect(f.threads.has("thread-one")).toBe(true);
  expect(f.threads.has("thread-two")).toBe(true);
  for (const name of [
    "tasks",
    "thread_links",
    "thread_start_operations",
    "pending_operations",
    "memory_operations",
    "memory_operation_ids",
    "repository_workspaces",
  ]) {
    const column = name === "tasks" ? "id" : "taskId";
    expect(
      f.db
        .prepare(`SELECT count(*) AS n FROM ${name} WHERE ${column}=?`)
        .get(a.id),
    ).toEqual({ n: 0 });
  }
  expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const remaining = (
    (await f.call("list", null)) as { tasks: unknown[] }
  ).tasks.map((t) => task.parse(t));
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({
    id: b.id,
    revision: b.revision + 1,
    dependencyIds: [],
  });
  await f.call("linkThread", {
    id: b.id,
    datasetEpoch,
    threadId: "thread-one",
    expectedCurrentLinkRevision: null,
    reassign: false,
  });
  const c = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "New task" }),
  );
  expect(c.number).toBe(3);
});

test("delete refuses an in-flight thread start and preserves its eventual thread", async () => {
  const f = await fixture();
  const created = task.parse(
    await f.call("create", { enrollmentId: f.enrolled.id, title: "Starting" }),
  );
  const input = await startSubmission(f, created);
  f.delaySpawns();
  const starting = f.call("startLinkedThread", input);
  await expect.poll(() => f.spawnCount()).toBe(1);
  try {
    await expect(
      f.call("deleteTask", {
        id: created.id,
        datasetEpoch: input.datasetEpoch,
        expectedRevision: created.revision,
      }),
    ).rejects.toThrow(/pending thread start/i);
  } finally {
    f.releaseSpawns();
  }
  await starting;
  expect(f.threads.has("thread-spawn-1")).toBe(true);
  const current = ((await f.call("list", null)) as { tasks: unknown[] }).tasks
    .map((t) => task.parse(t))
    .find((t) => t.id === created.id)!;
  await f.call("deleteTask", {
    id: current.id,
    datasetEpoch: input.datasetEpoch,
    expectedRevision: current.revision,
  });
  expect(f.threads.has("thread-spawn-1")).toBe(true);
  const unlinked = await f.harness.behavior.callAgentTool(
    "task_workspace_read_current_task",
    {},
    { threadId: "thread-spawn-1", projectId: "project-1" },
  );
  expect(toolJson(unlinked).message).toContain("not-linked");
});
