import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

import { statuses } from "./task-status";
export { statuses, normalStatuses } from "./task-status";

export const status = z.enum(statuses);
export const enrollment = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  hostId: z.string(),
  repository: z.string(),
  name: z.string(),
  prefix: z.string(),
  nextNumber: z.number(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const attachedPath = z.object({
  id: z.string().uuid(),
  hostId: z.string(),
  path: z.string(),
  label: z.string().nullable(),
});
export const combinedWorkingCopy = z.object({
  hasChanges: z.boolean(),
  changeCount: z.number().int().nonnegative(),
  paths: z.array(z.string()),
});
export const repositoryObservation = z.object({
  state: z.enum([
    "unselected",
    "selected",
    "ready",
    "unapplied",
    "missing",
    "merged",
    "placement-mismatch",
    "wrong-environment",
    "unavailable",
    "tool-error",
  ]),
  message: z.string(),
  toolVersion: z.string().nullable(),
  combinedWorkingCopy: combinedWorkingCopy.nullable(),
});
export const repositoryPreparation = z.object({
  taskId: z.string().uuid(),
  projectId: z.string(),
  hostId: z.string(),
  repository: z.string(),
  environmentId: z.string().nullable(),
  branchName: z.string().nullable(),
  parentBranchName: z.string().nullable(),
  preparedAt: z.string().nullable(),
  revision: z.number().int().positive(),
  updatedAt: z.string(),
  observation: repositoryObservation,
});
export const wayfinderAttachment = z
  .object({
    taskId: z.string().uuid(),
    projectId: z.string(),
    hostId: z.string(),
    repository: z.string(),
    mapPath: z.string(),
    selectedDirectory: z.string(),
    revision: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict();
const wayfinderDiagnostic = z
  .object({
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
    severity: z.enum(["info", "warning", "error"]),
  })
  .strict();
const wayfinderReference = z
  .object({
    sourcePath: z.string(),
    label: z.string(),
    destination: z.string(),
    fragment: z.string().optional(),
    identity: z.string().optional(),
    kind: z.enum(["inline", "reference"]),
    classification: z.enum(["local", "remote", "unsafe", "invalid"]),
  })
  .strict();
const wayfinderSection = z
  .object({
    heading: z.string(),
    depth: z.number().int().min(1).max(6),
    markdown: z.string(),
  })
  .strict();
const blockerEdge = z
  .object({
    sourcePath: z.string(),
    raw: z.string(),
    navigationTarget: z.string().optional(),
    targetPath: z.string().optional(),
    targetId: z.string().optional(),
    resolution: z.enum([
      "resolved",
      "missing",
      "ambiguous",
      "outside",
      "unsupported",
    ]),
    diagnostic: z.string().optional(),
  })
  .strict();
const normalizedWayfinderTicket = z
  .object({
    path: z.string(),
    id: z.string(),
    numericId: z.number().int().nonnegative(),
    title: z.string(),
    titleSource: z.enum(["h1", "map-link", "filename"]),
    type: z.string().nullable(),
    status: z.enum(["open", "claimed", "resolved", "unknown"]),
    rawMetadata: z.record(z.string(), z.array(z.string())),
    claimedBy: z.string().nullable(),
    questionMarkdown: z.string().nullable(),
    answerMarkdown: z.string().nullable(),
    references: z.array(wayfinderReference),
    blockers: z.array(blockerEdge),
    scope: z.enum(["in-scope", "out-of-scope", "ambiguous"]),
    consistent: z.boolean(),
    diagnostics: z.array(wayfinderDiagnostic),
  })
  .strict();
export const wayfinderGraph = z
  .object({
    adapter: z.literal("wayfinder-explicit-status/v1"),
    source: z
      .object({
        mapPath: z.string(),
        selectedDirectory: z.string(),
        mapState: z.enum(["available", "missing", "unreadable"]),
        discoveryComplete: z.boolean(),
      })
      .strict(),
    map: z
      .object({
        title: z.string(),
        titleSource: z.enum(["h1", "effort-directory"]),
        sections: z.array(wayfinderSection),
        references: z.array(wayfinderReference),
      })
      .strict(),
    tickets: z.array(normalizedWayfinderTicket),
    outOfScope: z.array(z.string()),
    edges: z.array(blockerEdge),
    sccs: z.array(
      z.object({ paths: z.array(z.string()), cyclic: z.boolean() }).strict(),
    ),
    frontier: z
      .object({
        complete: z.boolean(),
        knownReadyPaths: z.array(z.string()),
        label: z.enum(["complete-frontier", "known-component-readiness"]),
      })
      .strict(),
    diagnostics: z.array(wayfinderDiagnostic),
  })
  .strict();
export type WayfinderGraph = z.infer<typeof wayfinderGraph>;
const wayfinderSourceFile = z
  .object({
    path: z.string(),
    state: z.enum(["available", "missing", "unreadable"]),
    text: z.string().optional(),
    revision: z.string().optional(),
  })
  .strict();
export const wayfinderSourceRead = z
  .object({
    repository: z.string(),
    mapPath: z.string(),
    selectedDirectory: z.string().nullable(),
    candidates: z.array(z.string()),
    status: z.enum([
      "ready",
      "selection-required",
      "incomplete",
      "source-changing",
    ]),
    discoveryComplete: z.boolean(),
    diagnostics: z.array(wayfinderDiagnostic),
    scanTime: z.string(),
    sourceRevision: z.string(),
    watchRoot: z.string(),
    map: wayfinderSourceFile,
    tickets: z.array(wayfinderSourceFile),
  })
  .strict();
export type WayfinderSourceRead = z.infer<typeof wayfinderSourceRead>;
export const wayfinderView = z
  .object({
    attachment: wayfinderAttachment,
    graph: wayfinderGraph,
    scanTime: z.string(),
    sourceRevision: z.string(),
    workspaceLabel: z.literal("Combined working-copy view"),
    environmentId: z.string(),
    branchName: z.string(),
    refreshState: z.enum([
      "current",
      "degraded",
      "source-changing",
      "incomplete",
    ]),
  })
  .strict();
export type WayfinderView = z.infer<typeof wayfinderView>;
export const linkedThread = z.object({
  threadId: z.string(),
  linkRevision: z.number().int().positive(),
  linkedAt: z.string(),
  lastKnownTitle: z.string().nullable(),
  lastKnownProjectId: z.string(),
  lastKnownEnvironmentId: z.string().nullable(),
  lastKnownHostId: z.string().nullable(),
  availability: z.enum(["available", "archived", "missing", "unavailable"]),
  runtimeStatus: z
    .enum(["active", "error", "idle", "pending", "starting", "stopping"])
    .nullable(),
  environmentMismatch: z.string().nullable(),
  message: z.string(),
});
export type LinkedThread = z.infer<typeof linkedThread>;
export const threadCandidate = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  hostId: z.string().nullable(),
  availability: z.enum(["available", "archived"]),
  runtimeStatus: z.enum([
    "active",
    "error",
    "idle",
    "pending",
    "starting",
    "stopping",
  ]),
  environmentMismatch: z.string().nullable(),
  currentLink: z
    .object({
      taskId: z.string().uuid(),
      displayId: z.string(),
      linkRevision: z.number().int().positive(),
    })
    .nullable(),
});
export type ThreadCandidate = z.infer<typeof threadCandidate>;
const mentionResource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("thread"),
      label: z.string(),
      projectId: z.string().optional(),
      threadId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project"),
      label: z.string(),
      projectId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("section"),
      label: z.string(),
      sectionId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      label: z.string(),
      path: z.string(),
      source: z.enum(["thread-storage", "workspace"]),
      entryKind: z.enum(["directory", "file"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      label: z.string(),
      name: z.string(),
      origin: z.enum(["builtin", "project", "user"]),
      source: z.enum(["command", "skill"]),
      trigger: z.literal("/"),
      argumentHint: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plugin"),
      label: z.string(),
      pluginId: z.string(),
      itemId: z.string(),
      icon: z.string().nullable().optional(),
    })
    .strict(),
]);
const inputVisibility = z.literal("agent-only").optional();
export const structuredPromptInput = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      mentions: z
        .array(
          z
            .object({
              start: z.number(),
              end: z.number(),
              resource: mentionResource,
            })
            .strict(),
        )
        .default([]),
      visibility: inputVisibility,
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      url: z.string(),
      visibility: inputVisibility,
    })
    .strict(),
  z
    .object({
      type: z.literal("localImage"),
      path: z.string(),
      visibility: inputVisibility,
    })
    .strict(),
  z
    .object({
      type: z.literal("localFile"),
      path: z.string(),
      mimeType: z.string().optional(),
      name: z.string().optional(),
      sizeBytes: z.number().optional(),
      visibility: inputVisibility,
    })
    .strict(),
]);
const branchChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), name: z.string() }).strict(),
  z.object({ kind: z.literal("new"), baseBranch: z.string() }).strict(),
]);
export const threadEnvironment = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("reuse"), environmentId: z.string() }).strict(),
    z
      .object({
        type: z.literal("host"),
        hostId: z.string().optional(),
        workspace: z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("unmanaged"),
              path: z.string().nullable(),
              branch: branchChoice.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("managed-worktree"),
              baseBranch: z.discriminatedUnion("kind", [
                z
                  .object({ kind: z.literal("named"), name: z.string() })
                  .strict(),
                z.object({ kind: z.literal("default") }).strict(),
              ]),
            })
            .strict(),
          z.object({ type: z.literal("personal") }).strict(),
        ]),
      })
      .strict(),
    z.object({ type: z.literal("project-default") }).strict(),
    z
      .object({
        type: z.literal("provider"),
        environmentProviderId: z.literal("project-checkout"),
        machine: z
          .object({
            type: z.literal("existing"),
            hostId: z.string(),
          })
          .strict(),
        inputs: z
          .object({
            path: z.string().nullable().optional(),
            branch: branchChoice.optional(),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict(),
  ])
  .transform((environment) => {
    // BB 0.43's composer converts legacy host seeds to provider requests.
    // Normalize the equivalent checkout before validation and replay hashing,
    // preserving explicit path/branch choices for the server's existing guards.
    if (environment.type !== "provider") return environment;
    return {
      type: "host" as const,
      hostId: environment.machine.hostId,
      workspace: {
        type: "unmanaged" as const,
        path: environment.inputs?.path ?? null,
        ...(environment.inputs?.branch === undefined
          ? {}
          : { branch: environment.inputs.branch }),
      },
    };
  });
export const newThreadRequest = z
  .object({
    projectId: z.string(),
    providerId: z.string(),
    model: z.string(),
    reasoningLevel: z.enum([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "ultracode",
    ]),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    serviceTier: z.enum(["default", "fast"]).optional(),
    executionInputSources: z
      .object({
        providerId: z.enum(["explicit", "client-preference"]).optional(),
        model: z.enum(["explicit", "client-preference"]).optional(),
        reasoningLevel: z.enum(["explicit", "client-preference"]).optional(),
        serviceTier: z.enum(["explicit", "client-preference"]).optional(),
        permissionMode: z.enum(["explicit", "client-preference"]).optional(),
      })
      .strict(),
    environment: threadEnvironment,
    input: z.array(structuredPromptInput).min(1),
    sendAt: z.number().optional(),
  })
  .strict();
export type NewThreadRequestPayload = z.infer<typeof newThreadRequest>;
export const startOperationState = z.enum([
  "prepared",
  "dispatching",
  "awaiting-link",
  "linked",
  "failed-before-dispatch",
  "uncertain",
]);
export const startOperation = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  state: startOperationState,
  datasetEpoch: z.string().uuid(),
  taskRevision: z.number().int().positive(),
  linkContext: z.array(
    z.object({
      threadId: z.string(),
      linkRevision: z.number().int().positive(),
    }),
  ),
  projectId: z.string(),
  environment: threadEnvironment,
  hostId: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  serviceTier: z.string().nullable(),
  permissionMode: z.string(),
  sendAt: z.number().nullable(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: z.string().nullable(),
  error: z.string().nullable(),
  abandonedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StartOperation = z.infer<typeof startOperation>;
export const task = z.object({
  id: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  number: z.number(),
  displayId: z.string(),
  title: z.string(),
  description: z.string(),
  status,
  blockerReason: z.string().nullable(),
  dependencyIds: z.array(z.string().uuid()),
  blockerTaskIds: z.array(z.string().uuid()),
  dependencyCycle: z.boolean(),
  paths: z.array(attachedPath),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  attribution: z.string(),
  attributionAt: z.string(),
  memoryState: z.enum(["pending", "healthy", "conflict", "error"]),
  memoryError: z.string().nullable(),
  memoryHash: z.string().nullable(),
  memoryRevision: z.number(),
  memoryAttribution: z.object({
    kind: z.enum(["initialization", "human", "agent", "unknown-external"]),
    route: z.string(),
    threadId: z.string().nullable(),
    sessionId: z.string().nullable(),
    at: z.string(),
  }),
  linkedThreads: z.array(linkedThread),
  repositoryPreparation,
  wayfinderAttachment: wayfinderAttachment.nullable().optional(),
});
export type Enrollment = z.infer<typeof enrollment>;
export type Task = z.infer<typeof task>;
export type RepositoryPreparation = z.infer<typeof repositoryPreparation>;
export type RepositoryObservation = z.infer<typeof repositoryObservation>;
export type WayfinderAttachment = z.infer<typeof wayfinderAttachment>;
export const memoryToken = z.object({
  datasetEpoch: z.string().uuid(),
  memoryRevision: z.number().int().nonnegative(),
  memoryHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MemoryToken = z.infer<typeof memoryToken>;
export const memoryAttribution = task.shape.memoryAttribution;
export const memoryView = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("healthy"),
    content: z.string(),
    token: memoryToken,
    attribution: memoryAttribution,
  }),
  z.object({
    state: z.literal("conflict"),
    operationId: z.string().uuid().nullable(),
    content: z.string().nullable(),
    committedToken: memoryToken,
    observedHash: z.string().nullable(),
    reason: z.enum([
      "external-change",
      "missing",
      "symlink",
      "oversize",
      "invalid-utf8",
      "unsafe-path",
    ]),
    message: z.string(),
    attribution: z.literal("unknown-external"),
    allowedActions: z.array(z.enum(["accept-external", "restore-known"])),
  }),
  z.object({
    state: z.literal("pending"),
    operationId: z.string().uuid(),
    committedToken: memoryToken.nullable(),
    message: z.string(),
  }),
]);
export type MemoryView = z.infer<typeof memoryView>;
export const memoryMutationResult = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.enum(["saved", "accepted-external", "restored-known", "no-op"]),
    operationId: z.string().uuid(),
    token: memoryToken,
    attribution: memoryAttribution,
  }),
  z.object({
    outcome: z.enum([
      "stale",
      "not-applied",
      "invalid-content",
      "external-conflict",
      "missing-file",
      "recovery-pending",
      "operation-mismatch",
    ]),
    operationId: z.string().uuid(),
    message: z.string(),
  }),
]);
export type MemoryMutationResult = z.infer<typeof memoryMutationResult>;
export const backupHealth = z
  .object({
    state: z.enum(["not-yet-created", "healthy", "degraded"]),
    localDay: z.string(),
    observedAt: z.string(),
    lastAttemptAt: z.string().nullable(),
    lastSuccessfulAt: z.string().nullable(),
    lastSuccessfulLocalDay: z.string().nullable(),
    lastSuccessfulPath: z.string().nullable(),
    dailyArchiveCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
    warning: z.string().nullable(),
  })
  .strict();
export type BackupHealth = z.infer<typeof backupHealth>;
const restoreCounts = z
  .object({
    enrollments: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    tables: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    memoryBytes: z.number().int().nonnegative(),
  })
  .strict();
export const candidate = z.object({
  projectId: z.string(),
  name: z.string(),
  sourceId: z.string(),
  hostId: z.string(),
  repository: z.string(),
});
export const enrollInput = z
  .object({
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{1,11}$/),
  })
  .strict();
export const createInput = z
  .object({
    enrollmentId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(65536).default(""),
  })
  .strict();
const revisionInput = z.object({
  id: z.string().uuid(),
  datasetEpoch: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});
const repositoryRevisionInput = z.object({
  id: z.string().uuid(),
  datasetEpoch: z.string().uuid(),
  expectedRepositoryRevision: z.number().int().positive(),
});
const branchName = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value), {
    message: "Branch name contains control characters.",
  });
export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({
      datasetEpoch: z.string().uuid(),
      enrollments: z.array(enrollment.extend({ availability: z.string() })),
      tasks: z.array(task),
      startOperations: z.array(startOperation),
      candidates: z.array(candidate),
      discoveryError: z.string().nullable(),
      backup: backupHealth,
    }),
  },
  enroll: { input: enrollInput, output: enrollment },
  create: { input: createInput, output: task },
  updateDetails: {
    input: revisionInput
      .extend({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(65536),
      })
      .strict(),
    output: task,
  },
  setStatus: {
    input: revisionInput
      .extend({
        status,
        blockerReason: z.string().trim().min(1).max(2000).nullable(),
      })
      .strict(),
    output: task,
  },
  replaceRelationships: {
    input: revisionInput
      .extend({
        dependencyIds: z.array(z.string().uuid()).max(100),
        blockerTaskIds: z.array(z.string().uuid()).max(100),
      })
      .strict(),
    output: task,
  },
  replacePaths: {
    input: revisionInput
      .extend({
        paths: z
          .array(
            z
              .object({
                id: z.string().uuid().optional(),
                path: z.string().trim().min(1).max(4096),
                label: z.string().trim().max(200).nullable(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    output: task,
  },
  retryMemory: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: task,
  },
  readMemory: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: memoryView,
  },
  saveMemory: {
    input: z
      .object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        token: memoryToken,
        content: z.string().max(1024 * 1024),
      })
      .strict(),
    output: memoryMutationResult,
  },
  acceptExternalMemory: {
    input: z
      .object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        token: memoryToken,
        observedHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    output: memoryMutationResult,
  },
  restoreKnownMemory: {
    input: z
      .object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        token: memoryToken,
        observedHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        content: z.string().max(1024 * 1024),
      })
      .strict(),
    output: memoryMutationResult,
  },
  startLinkedThread: {
    input: z
      .object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        expectedTaskRevision: z.number().int().positive(),
        expectedLinkContext: z.array(
          z
            .object({
              threadId: z.string(),
              linkRevision: z.number().int().positive(),
            })
            .strict(),
        ),
        request: newThreadRequest,
      })
      .strict(),
    output: startOperation,
  },
  getStartOperation: {
    input: z
      .object({ id: z.string().uuid(), operationId: z.string().uuid() })
      .strict(),
    output: startOperation,
  },
  retryStartLink: {
    input: z
      .object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
      })
      .strict(),
    output: startOperation,
  },
  identifyStartThread: {
    input: z
      .object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        threadId: z.string().trim().min(1).max(200),
        expectedCurrentLinkRevision: z.number().int().positive().nullable(),
        reassign: z.boolean(),
      })
      .strict(),
    output: startOperation,
  },
  abandonStartOperation: {
    input: z
      .object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
      })
      .strict(),
    output: startOperation,
  },
  linkThread: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        threadId: z.string().trim().min(1).max(200),
        expectedCurrentLinkRevision: z.number().int().positive().nullable(),
        reassign: z.boolean(),
      })
      .strict(),
    output: linkedThread,
  },
  inspectThreadCandidate: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        threadId: z.string().trim().min(1).max(200),
      })
      .strict(),
    output: threadCandidate,
  },
  refreshThreadLink: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        threadId: z.string().min(1).max(200),
        expectedLinkRevision: z.number().int().positive(),
      })
      .strict(),
    output: linkedThread,
  },
  sendTaskContext: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        threadId: z.string().min(1).max(200),
        expectedLinkRevision: z.number().int().positive(),
      })
      .strict(),
    output: z.object({
      delivery: z.enum(["sent", "queued"]),
      message: z.string(),
    }),
  },
  releaseIdleThreadRuntime: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        threadId: z.string().min(1).max(200),
        expectedLinkRevision: z.number().int().positive(),
      })
      .strict(),
    output: z.object({ released: z.literal(true), message: z.string() }),
  },
  selectRepositoryEnvironment: {
    input: repositoryRevisionInput
      .extend({ environmentId: z.string().min(1).max(200) })
      .strict(),
    output: repositoryPreparation,
  },
  prepareRepository: {
    input: repositoryRevisionInput
      .extend({
        action: z.enum([
          "create-independent",
          "create-stacked",
          "associate-independent",
          "associate-stacked",
          "restack-existing",
        ]),
        branchName,
        parentBranchName: branchName.nullable(),
      })
      .strict(),
    output: repositoryPreparation,
  },
  reassociateEnrollment: {
    input: z
      .object({
        enrollmentId: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        expectedEnrollmentRevision: z.number().int().positive(),
        projectId: z.string().min(1),
        sourceId: z.string().min(1),
        environmentId: z.string().min(1).max(200),
      })
      .strict(),
    output: enrollment,
  },
  inspectWayfinderSource: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        mapPath: z.string().trim().min(1).max(4096),
        selectedDirectory: z.string().trim().min(1).max(4096).nullable(),
      })
      .strict(),
    output: wayfinderSourceRead,
  },
  saveWayfinderAttachment: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        expectedAttachmentRevision: z.number().int().nonnegative(),
        mapPath: z.string().trim().min(1).max(4096),
        selectedDirectory: z.string().trim().min(1).max(4096).nullable(),
      })
      .strict(),
    output: wayfinderAttachment,
  },
  readWayfinderView: {
    input: z
      .object({
        id: z.string().uuid(),
        datasetEpoch: z.string().uuid(),
        viewId: z.string().uuid(),
      })
      .strict(),
    output: wayfinderView,
  },
  closeWayfinderView: {
    input: z.object({ viewId: z.string().uuid() }).strict(),
    output: z.object({ closed: z.literal(true) }).strict(),
  },
  exportBackup: {
    input: z
      .object({
        destination: z.string().trim().min(1).max(4096),
      })
      .strict(),
    output: backupHealth,
  },
  retryDailyBackup: {
    input: z.null(),
    output: backupHealth,
  },
  exportRecoveryArchive: {
    input: z
      .object({
        reason: z.string().trim().min(1).max(500),
      })
      .strict(),
    output: backupHealth,
  },
  previewRestore: {
    input: z
      .object({
        path: z.string().trim().min(1).max(4096),
      })
      .strict(),
    output: z
      .object({
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        archiveKind: z.literal("complete"),
        schemaVersion: z.number().int().positive(),
        createdAt: z.string(),
        localDay: z.string(),
        source: z
          .object({ datasetId: z.string(), hostId: z.string() })
          .strict(),
        counts: restoreCounts,
        warnings: z.array(z.string()),
        current: z
          .object({
            datasetId: z.string().uuid(),
            hostId: z.string(),
            tasks: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  },
  restoreDataset: {
    input: z
      .object({
        path: z.string().trim().min(1).max(4096),
        expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
        currentDatasetEpoch: z.string().uuid(),
        confirmReplace: z.literal(true),
      })
      .strict(),
    output: z
      .object({
        datasetEpoch: z.string().uuid(),
        restoredCounts: restoreCounts,
        protective: z
          .object({
            kind: z.enum(["complete", "recovery-only"]),
            path: z.string().nullable(),
          })
          .strict(),
        warnings: z.array(z.string()),
      })
      .strict(),
  },
});
const branchInventory = z.object({
  repository: z.string(),
  version: z.string(),
  appliedStacks: z.array(z.array(z.string())),
  branches: z.array(
    z.object({ name: z.string(), merged: z.boolean() }).strict(),
  ),
  combinedWorkingCopy,
});
export const hostContract = defineRpcContract({
  validateRepository: {
    input: z.object({ repository: z.string().min(1) }).strict(),
    output: z.object({ repository: z.string(), version: z.string() }),
  },
  readMemory: {
    input: z
      .object({
        dataset: z.string().uuid(),
        taskId: z.string().uuid(),
      })
      .strict(),
    output: z.discriminatedUnion("state", [
      z.object({
        state: z.literal("present"),
        content: z.string(),
        bytesBase64: z.string(),
        hash: z.string(),
        size: z.number(),
      }),
      z.object({ state: z.literal("missing") }),
      z.object({
        state: z.literal("invalid"),
        reason: z.enum(["symlink", "oversize", "invalid-utf8", "unsafe-path"]),
        message: z.string(),
        observedHash: z.string().nullable(),
      }),
    ]),
  },
  initializeMemory: {
    input: z
      .object({ dataset: z.string().uuid(), taskId: z.string().uuid() })
      .strict(),
    output: z.discriminatedUnion("state", [
      z.object({
        state: z.literal("present"),
        content: z.string(),
        bytesBase64: z.string(),
        hash: z.string(),
        size: z.number(),
      }),
      z.object({
        state: z.literal("invalid"),
        reason: z.enum(["symlink", "oversize", "invalid-utf8", "unsafe-path"]),
        message: z.string(),
        observedHash: z.string().nullable(),
      }),
    ]),
  },
  replaceMemory: {
    input: z
      .object({
        dataset: z.string().uuid(),
        taskId: z.string().uuid(),
        operationId: z.string().uuid(),
        expectedHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        content: z.string().max(1024 * 1024),
      })
      .strict(),
    output: z.object({ hash: z.string(), size: z.number() }),
  },
  confirmMemoryDurable: {
    input: z
      .object({
        dataset: z.string().uuid(),
        taskId: z.string().uuid(),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    output: z.object({ hash: z.string(), size: z.number() }),
  },
  inspectRepository: {
    input: z.object({ repository: z.string().min(1) }).strict(),
    output: branchInventory,
  },
  mutateBranch: {
    input: z
      .object({
        repository: z.string().min(1),
        action: z.enum([
          "create-independent",
          "create-stacked",
          "restack-existing",
        ]),
        branchName,
        parentBranchName: branchName.nullable(),
      })
      .strict(),
    output: branchInventory,
  },
  readWayfinderSource: {
    input: z
      .object({
        repository: z.string().min(1),
        mapPath: z.string().min(1).max(4096),
        selectedDirectory: z.string().min(1).max(4096).nullable(),
      })
      .strict(),
    output: wayfinderSourceRead,
  },
  startWayfinderWatch: {
    input: z
      .object({
        watchId: z.string().uuid(),
        repository: z.string().min(1),
        watchRoot: z.string().min(1),
      })
      .strict(),
    output: z.object({ watching: z.literal(true) }).strict(),
  },
  stopWayfinderWatch: {
    input: z.object({ watchId: z.string().uuid() }).strict(),
    output: z.object({ stopped: z.literal(true) }).strict(),
  },
  archiveStatus: {
    input: z
      .object({
        dataset: z.string().uuid(),
        hostId: z.string().min(1).max(200),
      })
      .strict(),
    output: backupHealth,
  },
  publishArchive: {
    input: z
      .object({
        dataset: z.string().uuid(),
        hostId: z.string().min(1).max(200),
        kind: z.enum(["daily", "manual", "protective", "recovery-only"]),
        archiveBase64: z.string().max(24 * 1024 * 1024),
        destination: z.string().max(4096).nullable(),
      })
      .strict(),
    output: backupHealth.extend({ publishedPath: z.string().nullable() }),
  },
  recordArchiveFailure: {
    input: z
      .object({
        dataset: z.string().uuid(),
        hostId: z.string().min(1).max(200),
        message: z.string().min(1).max(2000),
      })
      .strict(),
    output: backupHealth,
  },
  readArchiveCandidate: {
    input: z
      .object({
        path: z.string().min(1).max(4096),
      })
      .strict(),
    output: z
      .object({
        bytesBase64: z.string().max(24 * 1024 * 1024),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  },
  beginStagedDataset: {
    input: z
      .object({
        dataset: z.string().uuid(),
        token: z.string().uuid(),
      })
      .strict(),
    output: z.object({ created: z.literal(true) }).strict(),
  },
  stageRestoredMemory: {
    input: z
      .object({
        dataset: z.string().uuid(),
        token: z.string().uuid(),
        taskId: z.string().uuid(),
        bytesBase64: z.string().max(2 * 1024 * 1024),
        expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    output: z
      .object({
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().nonnegative(),
      })
      .strict(),
  },
  verifyStagedDataset: {
    input: z
      .object({
        dataset: z.string().uuid(),
        token: z.string().uuid(),
        memories: z
          .array(
            z
              .object({
                taskId: z.string().uuid(),
                expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
              })
              .strict(),
          )
          .max(20_000),
      })
      .strict(),
    output: z.object({ verified: z.literal(true) }).strict(),
  },
  finalizeStagedDataset: {
    input: z
      .object({
        dataset: z.string().uuid(),
        token: z.string().uuid(),
      })
      .strict(),
    output: z.object({ finalized: z.boolean() }).strict(),
  },
  discardStagedDataset: {
    input: z
      .object({
        dataset: z.string().uuid(),
        token: z.string().uuid(),
      })
      .strict(),
    output: z
      .object({
        removed: z.boolean(),
      })
      .strict(),
  },
  reconcileStagedDatasets: {
    input: z
      .object({
        activeDataset: z.string().uuid(),
      })
      .strict(),
    output: z
      .object({
        discarded: z.array(z.string()),
        finalized: z.array(z.string()),
      })
      .strict(),
  },
});
export const hostSignals = {
  wayfinderChanged: {
    payload: z
      .object({
        watchId: z.string().uuid(),
        kind: z.enum(["changed", "rescan-required", "watch-error"]),
        message: z.string().nullable(),
      })
      .strict(),
  },
} satisfies ExperimentalHostSignals;
