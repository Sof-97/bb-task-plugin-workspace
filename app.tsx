import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type {
  rpcContract,
  Task,
  MemoryToken,
  MemoryView,
  ThreadCandidate,
  StartOperation,
  Enrollment,
} from "./contract";
import { normalStatuses } from "./task-status";
import { safeMarkdown } from "./markdown";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { WayfinderPanel } from "./wayfinder-view";

type StartSubmission = {
  id: string;
  operationId: string;
  datasetEpoch: string;
  expectedTaskRevision: number;
  expectedLinkContext: Array<{ threadId: string; linkRevision: number }>;
  request: NewThreadRequest;
};

function taskDraftValue(task: Task) {
  return JSON.stringify([
    task.title,
    task.description,
    task.status,
    task.blockerReason ?? "",
    task.dependencyIds,
    task.blockerTaskIds,
    task.paths.map((item) => [item.id, `${item.label ?? ""} | ${item.path}`]),
  ]);
}

function repositoryDraftValue(
  environmentId: string,
  branchName: string,
  parentBranchName: string,
  action: string,
) {
  return JSON.stringify([environmentId, branchName, parentBranchName, action]);
}

function TaskStartComposer({
  task,
  enrollment,
  datasetEpoch,
  onSubmit,
}: {
  task: Task;
  enrollment: Enrollment;
  datasetEpoch: string;
  onSubmit: (request: NewThreadRequest) => Promise<void>;
}) {
  const [seeds] = useState(() => ({
    projectId: enrollment.projectId,
    environment: task.repositoryPreparation.environmentId
      ? ({
          type: "reuse" as const,
          environmentId: task.repositoryPreparation.environmentId,
        } as const)
      : ({
          type: "host" as const,
          hostId: enrollment.hostId,
          workspace: { type: "unmanaged" as const, path: null },
        } as const),
  }));
  return (
    <NewThreadComposer
      defaultProjectId={seeds.projectId}
      defaultEnvironment={seeds.environment}
      draftKey={`task-workspace:start:${datasetEpoch}:${task.id}`}
      placeholder={`Discuss ${task.displayId}…`}
      layout="document"
      onSubmit={(request) => {
        const submission = onSubmit(request);
        // The host awaits this same rejected promise to retain its draft. The
        // attached observer also keeps minimal/synthetic hosts that ignore the
        // returned promise from producing an unhandled rejection.
        void submission.catch(() => {});
        return submission;
      }}
    />
  );
}

function Board({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate(),
    connection = useRealtimeConnectionState();
  const taskId = subPath.replace(/^\//, "");
  const [data, setData] = useState<Awaited<
    ReturnType<typeof rpc.call<"list">>
  > | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [prefix, setPrefix] = useState("");
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [filterProject, setFilterProject] = useState("all");
  const [query, setQuery] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [nextStatus, setNextStatus] = useState<
    (typeof normalStatuses)[number] | "Blocked"
  >("Inbox");
  const [blockerReason, setBlockerReason] = useState("");
  const [dependencyIds, setDependencyIds] = useState<string[]>([]);
  const [blockerTaskIds, setBlockerTaskIds] = useState<string[]>([]);
  const [pathLines, setPathLines] = useState("");
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftEpoch, setDraftEpoch] = useState("");
  const [baseDraftValue, setBaseDraftValue] = useState("");
  const [draftConflict, setDraftConflict] = useState(false);
  const [repositoryEnvironment, setRepositoryEnvironment] = useState("");
  const [repositoryBranch, setRepositoryBranch] = useState("");
  const [repositoryParent, setRepositoryParent] = useState("");
  const [repositoryAction, setRepositoryAction] = useState<
    | "create-independent"
    | "create-stacked"
    | "associate-independent"
    | "associate-stacked"
    | "restack-existing"
  >("create-independent");
  const [correctionSource, setCorrectionSource] = useState("");
  const [correctionEnvironment, setCorrectionEnvironment] = useState("");
  const [repositoryDraftRevision, setRepositoryDraftRevision] = useState(0);
  const [repositoryDraftEpoch, setRepositoryDraftEpoch] = useState("");
  const [repositoryBaseValue, setRepositoryBaseValue] = useState("");
  const [repositoryConflict, setRepositoryConflict] = useState(false);
  const [correctionDraftRevision, setCorrectionDraftRevision] = useState(0);
  const [correctionDraftEpoch, setCorrectionDraftEpoch] = useState("");
  const [correctionBaseValue, setCorrectionBaseValue] = useState("");
  const [correctionConflict, setCorrectionConflict] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryView | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryBase, setMemoryBase] = useState("");
  const [memoryDraftToken, setMemoryDraftToken] = useState<MemoryToken | null>(
    null,
  );
  const [memoryDraftConflict, setMemoryDraftConflict] = useState(false);
  const [memoryRestoreKnown, setMemoryRestoreKnown] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [restorePreview, setRestorePreview] = useState<Awaited<
    ReturnType<typeof rpc.call<"previewRestore">>
  > | null>(null);
  const [restoreMessage, setRestoreMessage] = useState("");
  const restoreGeneration = useRef(0);
  const restorePreviewPath = useRef("");
  const [memoryOperation, setMemoryOperation] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const [linkDrafts, setLinkDrafts] = useState<Record<string, string>>({});
  const [linkCandidates, setLinkCandidates] = useState<
    Record<
      string,
      { candidate: ThreadCandidate; datasetEpoch: string } | undefined
    >
  >({});
  const [threadNotices, setThreadNotices] = useState<Record<string, string>>(
    {},
  );
  const [startNotices, setStartNotices] = useState<Record<string, string>>({});
  const [startRecoveryIds, setStartRecoveryIds] = useState<
    Record<string, string>
  >({});
  const [startRecoveryCandidates, setStartRecoveryCandidates] = useState<
    Record<
      string,
      | {
          candidate: ThreadCandidate;
          datasetEpoch: string;
          threadId: string;
          editGeneration: number;
        }
      | undefined
    >
  >({});
  const drawer = useRef<HTMLElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const previousTaskId = useRef("");
  const refreshGeneration = useRef(0);
  const memoryRefreshGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const selectedTaskRef = useRef(taskId);
  const datasetEpochRef = useRef("");
  const memoryDraftRef = useRef("");
  const memoryBaseRef = useRef("");
  const memoryTokenRef = useRef<MemoryToken | null>(null);
  const memoryEditGeneration = useRef(0);
  const linkDraftsRef = useRef<Record<string, string>>({});
  const startSubmissions = useRef<Record<string, StartSubmission>>({});
  const startRecoveryEditGenerations = useRef<Record<string, number>>({});
  if (selectedTaskRef.current !== taskId) {
    selectedTaskRef.current = taskId;
    selectionGeneration.current += 1;
    memoryRefreshGeneration.current += 1;
  }
  const mounted = useRef(true);
  const report = useCallback(
    (value: unknown) =>
      setError(value instanceof Error ? value.message : String(value)),
    [],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const result = await rpc.call("list");
      if (mounted.current && generation === refreshGeneration.current)
        setData(result);
    } catch (value) {
      if (mounted.current && generation === refreshGeneration.current)
        report(value);
    }
  }, [rpc, report]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, connection]);
  useRealtime("changed", () => void refresh());
  const selected = data?.tasks.find((task) => task.id === taskId);
  const selectedEnrollment = data?.enrollments.find(
    (item) => item.id === selected?.enrollmentId,
  );
  const datasetEpoch = data?.datasetEpoch ?? "";
  datasetEpochRef.current = datasetEpoch;
  useEffect(() => {
    restoreGeneration.current += 1;
    restorePreviewPath.current = "";
    setRestorePreview(null);
  }, [datasetEpoch]);
  memoryDraftRef.current = memoryDraft;
  memoryBaseRef.current = memoryBase;
  memoryTokenRef.current = memoryDraftToken;
  const memoryDirty = Boolean(memoryDraftToken && memoryDraft !== memoryBase);
  const sameMemoryToken = (left: MemoryToken | null, right: MemoryToken) =>
    Boolean(
      left &&
      left.datasetEpoch === right.datasetEpoch &&
      left.memoryRevision === right.memoryRevision &&
      left.memoryHash === right.memoryHash,
    );
  const loadMemoryDraft = useCallback(
    (view: Extract<MemoryView, { state: "healthy" }>) => {
      setMemoryDraft(view.content);
      setMemoryBase(view.content);
      setMemoryDraftToken(view.token);
      setMemoryDraftConflict(false);
      setMemoryOperation(null);
    },
    [],
  );
  const refreshMemory = useCallback(
    async (reset = false) => {
      if (!taskId) return;
      const requestedTask = taskId;
      const requestedSelection = selectionGeneration.current;
      const generation = ++memoryRefreshGeneration.current;
      try {
        const result = await rpc.call("readMemory", { id: taskId });
        if (
          !mounted.current ||
          generation !== memoryRefreshGeneration.current ||
          selectedTaskRef.current !== requestedTask ||
          selectionGeneration.current !== requestedSelection
        )
          return;
        setMemoryView(result);
        if (result.state === "healthy") {
          const currentToken = memoryTokenRef.current;
          const currentlyDirty = Boolean(
            currentToken && memoryDraftRef.current !== memoryBaseRef.current,
          );
          if (reset || !currentToken) loadMemoryDraft(result);
          else if (!sameMemoryToken(currentToken, result.token)) {
            if (currentlyDirty) setMemoryDraftConflict(true);
            else loadMemoryDraft(result);
          }
        } else if (
          memoryTokenRef.current &&
          memoryDraftRef.current !== memoryBaseRef.current
        ) {
          setMemoryDraftConflict(true);
        }
      } catch (value) {
        if (mounted.current && generation === memoryRefreshGeneration.current)
          report(value);
      }
    },
    [loadMemoryDraft, report, rpc, taskId],
  );
  useRealtime("changed", () => void refreshMemory());
  useEffect(() => {
    void refreshMemory();
  }, [connection]);
  useEffect(() => {
    const onFocus = () => {
      void refresh();
      void refreshMemory();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, refreshMemory]);
  useEffect(() => {
    setMemoryView(null);
    setMemoryDraft("");
    setMemoryBase("");
    setMemoryDraftToken(null);
    setMemoryDraftConflict(false);
    setMemoryRestoreKnown("");
    setMemoryOperation(null);
    if (taskId) void refreshMemory(true);
  }, [taskId]);
  const currentDraftValue = JSON.stringify([
    editTitle,
    editDescription,
    nextStatus,
    blockerReason,
    dependencyIds,
    blockerTaskIds,
    pathLines
      .split("\n")
      .filter((line) => line.trim())
      .map((line, index) => [selected?.paths[index]?.id ?? "", line]),
  ]);
  const linkDraft = taskId ? (linkDrafts[taskId] ?? "") : "";
  const candidateRecord = taskId ? linkCandidates[taskId] : undefined;
  const linkCandidate =
    candidateRecord?.datasetEpoch === datasetEpoch
      ? candidateRecord.candidate
      : undefined;
  const currentStart = (data?.startOperations ?? [])
    .filter(
      (operation) =>
        operation.taskId === taskId &&
        !operation.abandonedAt &&
        operation.state !== "linked",
    )
    .at(-1);
  const startRecoveryCandidateRecord = currentStart
    ? startRecoveryCandidates[currentStart.id]
    : undefined;
  const startRecoveryCandidate =
    currentStart &&
    startRecoveryCandidateRecord?.datasetEpoch === datasetEpoch &&
    startRecoveryCandidateRecord.threadId ===
      (startRecoveryIds[currentStart.id] ?? "").trim() &&
    startRecoveryCandidateRecord.editGeneration ===
      (startRecoveryEditGenerations.current[currentStart.id] ?? 0)
      ? startRecoveryCandidateRecord.candidate
      : undefined;
  const draftDirty = Boolean(
    baseDraftValue && currentDraftValue !== baseDraftValue,
  );
  const currentRepositoryDraftValue = repositoryDraftValue(
    repositoryEnvironment,
    repositoryBranch,
    repositoryParent,
    repositoryAction,
  );
  const repositoryDirty = Boolean(
    repositoryBaseValue && currentRepositoryDraftValue !== repositoryBaseValue,
  );
  const currentCorrectionDraftValue = JSON.stringify([
    correctionSource,
    correctionEnvironment,
  ]);
  const correctionDirty = Boolean(
    correctionBaseValue && currentCorrectionDraftValue !== correctionBaseValue,
  );
  const loadDraft = useCallback((value: Task, epoch: string) => {
    setEditTitle(value.title);
    setEditDescription(value.description);
    setNextStatus(value.status);
    setBlockerReason(value.blockerReason ?? "");
    setDependencyIds(value.dependencyIds);
    setBlockerTaskIds(value.blockerTaskIds);
    setPathLines(
      value.paths
        .map((item) => `${item.label ?? ""} | ${item.path}`)
        .join("\n"),
    );
    setDraftRevision(value.revision);
    setDraftEpoch(epoch);
    setBaseDraftValue(taskDraftValue(value));
    setDraftConflict(false);
  }, []);
  const loadRepositoryDraft = useCallback((value: Task, epoch: string) => {
    const preparation = value.repositoryPreparation;
    const action = preparation.parentBranchName
      ? "associate-stacked"
      : preparation.branchName
        ? "associate-independent"
        : "create-independent";
    setRepositoryEnvironment(preparation.environmentId ?? "");
    setRepositoryBranch(preparation.branchName ?? "");
    setRepositoryParent(preparation.parentBranchName ?? "");
    setRepositoryAction(action);
    setRepositoryDraftRevision(preparation.revision);
    setRepositoryDraftEpoch(epoch);
    setRepositoryBaseValue(
      repositoryDraftValue(
        preparation.environmentId ?? "",
        preparation.branchName ?? "",
        preparation.parentBranchName ?? "",
        action,
      ),
    );
    setRepositoryConflict(false);
  }, []);
  const loadCorrectionDraft = useCallback(
    (value: Task, enrollmentRevision: number, epoch: string) => {
      setCorrectionSource("");
      setCorrectionEnvironment(value.repositoryPreparation.environmentId ?? "");
      setCorrectionDraftRevision(enrollmentRevision);
      setCorrectionDraftEpoch(epoch);
      setCorrectionBaseValue(
        JSON.stringify(["", value.repositoryPreparation.environmentId ?? ""]),
      );
      setCorrectionConflict(false);
    },
    [],
  );
  useEffect(() => {
    if (!selected) return;
    loadDraft(selected, datasetEpoch);
    loadRepositoryDraft(selected, datasetEpoch);
    const enrollment = data?.enrollments.find(
      (item) => item.id === selected.enrollmentId,
    );
    if (enrollment)
      loadCorrectionDraft(selected, enrollment.revision, datasetEpoch);
    requestAnimationFrame(() => drawer.current?.focus());
  }, [selected?.id]);
  useEffect(() => {
    if (
      !selected ||
      !draftRevision ||
      (selected.revision === draftRevision && datasetEpoch === draftEpoch)
    )
      return;
    if (draftDirty) setDraftConflict(true);
    else loadDraft(selected, datasetEpoch);
  }, [
    datasetEpoch,
    draftDirty,
    draftEpoch,
    draftRevision,
    loadDraft,
    selected,
  ]);
  useEffect(() => {
    if (
      !selected ||
      !repositoryDraftRevision ||
      (selected.repositoryPreparation.revision === repositoryDraftRevision &&
        datasetEpoch === repositoryDraftEpoch)
    )
      return;
    if (repositoryDirty) setRepositoryConflict(true);
    else loadRepositoryDraft(selected, datasetEpoch);
  }, [
    datasetEpoch,
    loadRepositoryDraft,
    repositoryDirty,
    repositoryDraftEpoch,
    repositoryDraftRevision,
    selected,
  ]);
  useEffect(() => {
    if (
      !selected ||
      !selectedEnrollment ||
      !correctionDraftRevision ||
      (selectedEnrollment.revision === correctionDraftRevision &&
        datasetEpoch === correctionDraftEpoch)
    )
      return;
    if (correctionDirty) setCorrectionConflict(true);
    else
      loadCorrectionDraft(selected, selectedEnrollment.revision, datasetEpoch);
  }, [
    correctionDirty,
    correctionDraftEpoch,
    correctionDraftRevision,
    datasetEpoch,
    loadCorrectionDraft,
    selected,
    selectedEnrollment,
  ]);
  useEffect(() => {
    if (previousTaskId.current && !taskId)
      requestAnimationFrame(() => board.current?.focus());
    previousTaskId.current = taskId;
  }, [taskId]);
  useEffect(() => {
    if (!taskId) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") navigate.toPluginPanel("board");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navigate, taskId]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (value) {
      report(value);
    } finally {
      setBusy(false);
    }
  }
  const isCurrentStartView = (
    originTask: string,
    originEpoch: string,
    originSelection: number,
  ) =>
    selectedTaskRef.current === originTask &&
    datasetEpochRef.current === originEpoch &&
    selectionGeneration.current === originSelection;
  async function runStartRecovery(
    originTask: string,
    originEpoch: string,
    originSelection: number,
    action: () => Promise<void>,
  ) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (value) {
      if (isCurrentStartView(originTask, originEpoch, originSelection))
        report(value);
    } finally {
      setBusy(false);
    }
  }
  async function submitTaskThread(request: NewThreadRequest) {
    if (!selected || !selectedEnrollment)
      throw new Error("Current task enrollment is unavailable.");
    const originTask = selected.id;
    const originEpoch = datasetEpoch;
    const originRevision = selected.revision;
    const originSelection = selectionGeneration.current;
    const requestInput =
      startSubmissions.current[originTask] ??
      ({
        id: originTask,
        operationId: crypto.randomUUID(),
        datasetEpoch: originEpoch,
        expectedTaskRevision: originRevision,
        expectedLinkContext: selected.linkedThreads.map(
          ({ threadId, linkRevision }) => ({ threadId, linkRevision }),
        ),
        request,
      } satisfies StartSubmission);
    startSubmissions.current[originTask] = requestInput;
    const operationId = requestInput.operationId;
    const stillSelected = () =>
      selectedTaskRef.current === originTask &&
      datasetEpochRef.current === originEpoch &&
      selectionGeneration.current === originSelection;
    try {
      const result = await rpc.call("startLinkedThread", requestInput);
      if (stillSelected())
        setStartNotices((current) => ({
          ...current,
          [originTask]: result.error ?? `Start operation is ${result.state}.`,
        }));
      await refresh();
      if (result.state !== "linked")
        throw new Error(
          result.error ??
            `Start operation is ${result.state}; the composer draft is retained.`,
        );
      delete startSubmissions.current[originTask];
      if (stillSelected() && result.threadId)
        navigate.toThread(result.threadId);
    } catch (value) {
      let durable: StartOperation | null = null;
      try {
        durable = await rpc.call("getStartOperation", {
          id: originTask,
          operationId,
        });
      } catch {
        // A failure before durable preparation can legitimately have no row.
      }
      if (durable?.state === "linked" && durable.threadId) {
        await refresh();
        delete startSubmissions.current[originTask];
        if (stillSelected()) {
          setStartNotices((current) => ({
            ...current,
            [originTask]: "Start operation is linked.",
          }));
          navigate.toThread(durable.threadId);
        }
        return;
      }
      if (stillSelected())
        setStartNotices((current) => ({
          ...current,
          [originTask]:
            durable?.error ??
            (value instanceof Error ? value.message : String(value)),
        }));
      await refresh();
      throw new Error(
        durable?.error ??
          (value instanceof Error ? value.message : String(value)),
      );
    }
  }
  function acceptMutation(
    value: Task,
    originTaskId: string,
    originEpoch: string,
    originSelection: number,
  ) {
    setData((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((task) =>
              task.id === value.id ? value : task,
            ),
          }
        : current,
    );
    if (
      selectedTaskRef.current === originTaskId &&
      datasetEpochRef.current === originEpoch &&
      selectionGeneration.current === originSelection
    ) {
      setDraftRevision(value.revision);
      setDraftEpoch(originEpoch);
      setBaseDraftValue(taskDraftValue(value));
      setDraftConflict(false);
    }
  }
  function acceptRepository(
    value: Task["repositoryPreparation"],
    originTaskId: string,
    originEpoch: string,
    originSelection: number,
  ) {
    setData((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((task) =>
              task.id === value.taskId
                ? { ...task, repositoryPreparation: value }
                : task,
            ),
          }
        : current,
    );
    if (
      selected &&
      selectedTaskRef.current === originTaskId &&
      datasetEpochRef.current === originEpoch &&
      selectionGeneration.current === originSelection
    )
      loadRepositoryDraft(
        { ...selected, repositoryPreparation: value },
        originEpoch,
      );
  }
  const enrollmentNames = useMemo(
    () => new Map(data?.enrollments.map((item) => [item.id, item.name]) ?? []),
    [data?.enrollments],
  );
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (data?.tasks ?? []).filter(
      (task) =>
        (filterProject === "all" || task.enrollmentId === filterProject) &&
        (showCompleted || task.status !== "Completed") &&
        (!normalized ||
          `${task.displayId} ${task.title} ${task.description}`
            .toLowerCase()
            .includes(normalized)),
    );
  }, [data?.tasks, filterProject, query, showCompleted]);
  const stageList = showCompleted
    ? normalStatuses
    : normalStatuses.filter((stage) => stage !== "Completed");
  const relationshipOption = (
    task: Task,
    values: string[],
    setValues: (values: string[]) => void,
  ) => (
    <label key={task.id} className="flex gap-2 text-sm">
      <input
        type="checkbox"
        checked={values.includes(task.id)}
        onChange={(event) =>
          setValues(
            event.target.checked
              ? [...values, task.id]
              : values.filter((id) => id !== task.id),
          )
        }
      />
      {task.displayId} — {task.title}
    </label>
  );
  return (
    <div
      ref={board}
      tabIndex={-1}
      className="relative h-full overflow-auto p-4 text-foreground outline-none"
    >
      <h1 className="text-xl font-semibold">Task workspace</h1>
      {data?.backup && (
        <div
          className="my-2 flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm"
          aria-label="Backup health"
        >
          <span role="status">
            {data.backup.state === "healthy" &&
              `Backup healthy · last success ${data.backup.lastSuccessfulAt ?? "unknown"} (${data.backup.dailyArchiveCount} daily)`}
            {data.backup.state === "degraded" &&
              `Backup failed · ${data.backup.error ?? "unknown error"}`}
            {data.backup.state === "not-yet-created" && "No daily backup yet"}
          </span>
          {data.backup.warning && (
            <span className="text-destructive" role="alert">
              {data.backup.warning}
            </span>
          )}
          <Button
            disabled={busy}
            className="ml-auto"
            onClick={(event) => {
              event.preventDefault();
              void run(async () => {
                await rpc.call("retryDailyBackup", null);
              });
            }}
          >
            Retry daily backup
          </Button>
        </div>
      )}
      {data && (
        <details className="my-2 rounded border border-border p-2 text-sm">
          <summary>Restore a dataset archive</summary>
          <p className="mt-2">
            Restoring replaces the entire current dataset — every task,
            description, memory, link, preparation and pending operation — with
            the archive contents. Nothing is merged. Export a fresh backup first
            if the current data still matters.
          </p>
          <form
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                setRestoreMessage("");
                const request = ++restoreGeneration.current;
                const originEpoch = datasetEpochRef.current;
                const path = restorePath;
                const preview = await rpc.call("previewRestore", { path });
                if (
                  request !== restoreGeneration.current ||
                  originEpoch !== datasetEpochRef.current ||
                  preview.current.datasetId !== originEpoch
                )
                  return;
                restorePreviewPath.current = path;
                setRestorePreview(preview);
              });
            }}
          >
            <Input
              aria-label="Archive path"
              className="min-w-64 flex-1"
              placeholder="/absolute/path/to/archive.task-workspace.json"
              value={restorePath}
              onChange={(event) => {
                restoreGeneration.current += 1;
                restorePreviewPath.current = "";
                setRestorePath(event.target.value);
                setRestorePreview(null);
              }}
            />
            <Button type="submit" disabled={busy || !restorePath.trim()}>
              Preview archive
            </Button>
          </form>
          {restorePreview && (
            <div
              className="mt-2 rounded border border-border p-2"
              role="status"
              aria-label="Restore preview"
            >
              <p>
                Archive captured {restorePreview.createdAt} · schema{" "}
                {restorePreview.schemaVersion} · source dataset{" "}
                {restorePreview.source.datasetId} on host{" "}
                {restorePreview.source.hostId}
              </p>
              <p>
                Contains {restorePreview.counts.tasks} tasks,{" "}
                {restorePreview.counts.enrollments} enrollments,{" "}
                {restorePreview.counts.memories} memory files,{" "}
                {restorePreview.counts.records} records.
              </p>
              {restorePreview.warnings.map((warning) => (
                <p key={warning} role="alert" className="text-destructive">
                  {warning}
                </p>
              ))}
              <p>
                Restoring replaces all {restorePreview.current.tasks} current
                tasks with the {restorePreview.counts.tasks} archived tasks.
                Sessions holding pre-restore tokens must reread; restored
                incomplete operations are quarantined for inspection.
              </p>
              <Button
                className="mt-2"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const result = await rpc.call("restoreDataset", {
                      path: restorePreviewPath.current,
                      expectedDigest: restorePreview.digest,
                      currentDatasetEpoch: restorePreview.current.datasetId,
                      confirmReplace: true,
                    });
                    setRestorePreview(null);
                    setRestoreMessage(
                      `Restored ${result.restoredCounts.tasks} tasks; new dataset epoch ${result.datasetEpoch}. Protective copy retained until recovery is confirmed.`,
                    );
                  });
                }}
              >
                Restore dataset
              </Button>
            </div>
          )}
          {restoreMessage && <p role="status">{restoreMessage}</p>}
        </details>
      )}
      {error && (
        <p role="alert" className="my-2 text-destructive">
          {error}
        </p>
      )}
      {data?.discoveryError && <p role="alert">{data.discoveryError}</p>}
      <details
        className="my-3 rounded border border-border p-3"
        open={data?.enrollments.length === 0}
      >
        <summary>Enroll a project</summary>
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const candidate = data?.candidates.find(
                (item) => item.sourceId === source,
              );
              if (!candidate) throw Error("Select a main repository.");
              const enrolled = await rpc.call("enroll", {
                projectId: candidate.projectId,
                sourceId: source,
                prefix,
              });
              setProject(enrolled.id);
              setPrefix("");
            });
          }}
        >
          <select
            aria-label="Main repository"
            className="max-w-full rounded border border-border bg-background p-2"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">Select a BB project and main repository</option>
            {data?.candidates.map((item) => (
              <option key={item.sourceId} value={item.sourceId}>
                {item.name} — {item.repository}
              </option>
            ))}
          </select>
          <Input
            aria-label="Task prefix"
            placeholder="Prefix, e.g. HOUSE"
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            className="w-48"
          />
          <Button disabled={busy || !source || !prefix}>Enroll</Button>
        </form>
      </details>
      <form
        className="my-4 flex max-w-2xl flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const created = await rpc.call("create", {
              enrollmentId: project,
              title,
              description,
            });
            setTitle("");
            setDescription("");
            navigate.toPluginPanel("board", { subPath: created.id });
          });
        }}
      >
        <label>
          Project{" "}
          <select
            aria-label="Capture project"
            className="ml-2 rounded border border-border bg-background p-2"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">Select enrolled project</option>
            {data?.enrollments.map((item) => (
              <option
                key={item.id}
                value={item.id}
                disabled={item.availability !== "available"}
              >
                {item.name} ({item.prefix}) — {item.availability}
              </option>
            ))}
          </select>
        </label>
        <Input
          aria-label="Task title"
          placeholder="What needs doing?"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="Markdown description"
          placeholder="Description (Markdown)"
          className="min-h-20 rounded border border-border bg-background p-2"
          maxLength={65536}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button
          disabled={busy || !project || !title.trim()}
          className="self-start"
        >
          Create Inbox task
        </Button>
      </form>
      <div
        className="my-3 flex flex-wrap items-end gap-3 rounded border border-border p-3"
        aria-label="Board filters"
      >
        <label>
          Project filter{" "}
          <select
            aria-label="Project filter"
            className="block rounded border border-border bg-background p-2"
            value={filterProject}
            onChange={(event) => setFilterProject(event.target.value)}
          >
            <option value="all">All projects</option>
            {data?.enrollments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search{" "}
          <Input
            aria-label="Search tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="flex min-h-10 items-center gap-2">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(event) => setShowCompleted(event.target.checked)}
          />{" "}
          Show Completed
        </label>
      </div>
      {!data && <p role="status">Loading tasks…</p>}
      <div className="flex gap-3 overflow-x-auto pb-4" aria-label="Task board">
        {stageList.map((stage) => (
          <section
            key={stage}
            className="min-h-64 w-64 shrink-0 rounded border border-border bg-card p-3"
          >
            <h2 className="mb-3 font-semibold">{stage}</h2>
            {visible
              .filter((task) => task.status === stage)
              .map((task) => (
                <button
                  key={task.id}
                  className="mb-2 block w-full rounded border border-border p-3 text-left"
                  onClick={() =>
                    navigate.toPluginPanel("board", { subPath: task.id })
                  }
                >
                  <small>
                    {task.displayId} · {enrollmentNames.get(task.enrollmentId)}
                  </small>
                  <p>{task.title}</p>
                  {task.dependencyCycle && (
                    <p className="text-destructive">Dependency cycle</p>
                  )}
                  {task.memoryState !== "healthy" && (
                    <p className="text-destructive">Memory needs recovery</p>
                  )}
                </button>
              ))}
          </section>
        ))}
      </div>
      <section
        className="border-t border-border pt-3"
        aria-label="Blocked tasks"
      >
        <h2 className="font-semibold">Blocked</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {visible
            .filter((task) => task.status === "Blocked")
            .map((task) => (
              <button
                key={task.id}
                className="w-64 rounded border border-border p-3 text-left"
                onClick={() =>
                  navigate.toPluginPanel("board", { subPath: task.id })
                }
              >
                <small>{task.displayId}</small>
                <p>{task.title}</p>
                <p className="text-sm">{task.blockerReason}</p>
              </button>
            ))}
          {!visible.some((task) => task.status === "Blocked") && (
            <p className="text-sm text-muted-foreground">
              No matching blocked tasks.
            </p>
          )}
        </div>
      </section>
      {taskId && data && !selected && (
        <aside
          aria-label="Task details"
          className="absolute inset-y-0 right-0 z-10 w-full max-w-xl border-l border-border bg-background p-5 shadow-xl"
        >
          <Button onClick={() => navigate.toPluginPanel("board")}>
            Back to board
          </Button>
          <p role="alert" className="mt-4">
            Task not found. It may have been removed from this dataset.
          </p>
        </aside>
      )}
      {selected && (
        <aside
          ref={drawer}
          tabIndex={-1}
          role="dialog"
          aria-label="Task details"
          className="absolute inset-y-0 right-0 z-10 w-full max-w-xl overflow-y-auto border-l border-border bg-background p-5 shadow-xl outline-none"
        >
          <Button onClick={() => navigate.toPluginPanel("board")}>
            Back to board
          </Button>
          <p className="mt-4">
            {selected.displayId} · {selected.status}
          </p>
          <p className="text-sm text-muted-foreground">
            Latest change: {selected.attribution} at {selected.attributionAt}
          </p>
          {draftConflict && (
            <div
              role="alert"
              className="my-3 rounded border border-destructive p-3"
            >
              <p>This task changed elsewhere. Your draft is preserved.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => loadDraft(selected, datasetEpoch)}
                >
                  Reread and discard local draft
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDraftRevision(selected.revision);
                    setDraftEpoch(datasetEpoch);
                    setBaseDraftValue(taskDraftValue(selected));
                    setDraftConflict(false);
                  }}
                >
                  Rebase draft on latest revision
                </Button>
              </div>
            </div>
          )}
          <form
            className="mt-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const originSelection = selectionGeneration.current;
              void run(async () => {
                const updated = await rpc.call("updateDetails", {
                  id: selected.id,
                  datasetEpoch: draftEpoch,
                  expectedRevision: draftRevision,
                  title: editTitle,
                  description: editDescription,
                });
                acceptMutation(
                  updated,
                  selected.id,
                  draftEpoch,
                  originSelection,
                );
              });
            }}
          >
            <label>
              Title{" "}
              <Input
                aria-label="Edit title"
                value={editTitle}
                maxLength={200}
                onChange={(event) => setEditTitle(event.target.value)}
              />
            </label>
            <label>
              Description{" "}
              <textarea
                aria-label="Edit Markdown description"
                className="block min-h-32 w-full rounded border border-border bg-background p-2"
                value={editDescription}
                maxLength={65536}
                onChange={(event) => setEditDescription(event.target.value)}
              />
            </label>
            <Button
              disabled={busy || !editTitle.trim()}
              className="justify-self-start"
            >
              Save details
            </Button>
          </form>
          <h3 className="mt-6 font-semibold">Preview</h3>
          <Markdown
            content={safeMarkdown(selected.description || "_No description._")}
          />
          <WayfinderPanel
            key={selected.id}
            task={selected}
            datasetEpoch={datasetEpoch}
          />
          <form
            className="mt-6 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const originSelection = selectionGeneration.current;
              void run(async () => {
                const updated = await rpc.call("setStatus", {
                  id: selected.id,
                  datasetEpoch: draftEpoch,
                  expectedRevision: draftRevision,
                  status: nextStatus,
                  blockerReason:
                    nextStatus === "Blocked" ? blockerReason : null,
                });
                if (
                  selectedTaskRef.current === selected.id &&
                  selectionGeneration.current === originSelection
                ) {
                  setNextStatus(updated.status);
                  setBlockerReason(updated.blockerReason ?? "");
                }
                acceptMutation(
                  updated,
                  selected.id,
                  draftEpoch,
                  originSelection,
                );
              });
            }}
          >
            <h3 className="font-semibold">Manual status</h3>
            <label>
              Move to stage{" "}
              <select
                aria-label="Move to stage"
                className="block rounded border border-border bg-background p-2"
                value={nextStatus}
                onChange={(event) =>
                  setNextStatus(event.target.value as typeof nextStatus)
                }
              >
                {normalStatuses.map((stage) => (
                  <option key={stage}>{stage}</option>
                ))}
                <option>Blocked</option>
              </select>
            </label>
            {nextStatus === "Blocked" && (
              <label>
                Required blocker reason{" "}
                <textarea
                  aria-label="Required blocker reason"
                  className="block min-h-20 w-full rounded border border-border bg-background p-2"
                  value={blockerReason}
                  maxLength={2000}
                  onChange={(event) => setBlockerReason(event.target.value)}
                  required
                />
              </label>
            )}
            {selected.status === "Blocked" && nextStatus !== "Blocked" && (
              <p>
                This explicitly unblocks to {nextStatus}; no previous stage is
                inferred.
              </p>
            )}
            <Button
              disabled={
                busy || (nextStatus === "Blocked" && !blockerReason.trim())
              }
              className="justify-self-start"
            >
              Apply status
            </Button>
          </form>
          <form
            className="mt-6 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const originSelection = selectionGeneration.current;
              void run(async () => {
                const updated = await rpc.call("replaceRelationships", {
                  id: selected.id,
                  datasetEpoch: draftEpoch,
                  expectedRevision: draftRevision,
                  dependencyIds,
                  blockerTaskIds,
                });
                acceptMutation(
                  updated,
                  selected.id,
                  draftEpoch,
                  originSelection,
                );
              });
            }}
          >
            <fieldset>
              <legend className="font-semibold">Depends on</legend>
              {(data?.tasks ?? [])
                .filter((task) => task.id !== selected.id)
                .map((task) =>
                  relationshipOption(task, dependencyIds, setDependencyIds),
                )}
            </fieldset>
            <fieldset>
              <legend className="font-semibold">Blocker references</legend>
              <p className="text-sm text-muted-foreground">
                Context only; these do not change status.
              </p>
              {(data?.tasks ?? [])
                .filter((task) => task.id !== selected.id)
                .map((task) =>
                  relationshipOption(task, blockerTaskIds, setBlockerTaskIds),
                )}
            </fieldset>
            {selected.dependencyCycle && (
              <p role="alert" className="text-destructive">
                This task participates in a dependency cycle. Status and branch
                placement remain manual.
              </p>
            )}
            <Button disabled={busy} className="justify-self-start">
              Save relationships
            </Button>
          </form>
          <form
            className="mt-6 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const paths = pathLines
                .split("\n")
                .filter((line) => line.trim())
                .map((line, index) => {
                  const separator = line.indexOf("|");
                  const label =
                    separator >= 0 ? line.slice(0, separator).trim() : "";
                  const path = (
                    separator >= 0 ? line.slice(separator + 1) : line
                  ).trim();
                  const previous = selected.paths[index];
                  return {
                    ...(previous ? { id: previous.id } : {}),
                    path,
                    label: label || null,
                  };
                });
              const originSelection = selectionGeneration.current;
              void run(async () => {
                const updated = await rpc.call("replacePaths", {
                  id: selected.id,
                  datasetEpoch: draftEpoch,
                  expectedRevision: draftRevision,
                  paths,
                });
                acceptMutation(
                  updated,
                  selected.id,
                  draftEpoch,
                  originSelection,
                );
              });
            }}
          >
            <h3 className="font-semibold">Attached path references</h3>
            <p className="text-sm text-muted-foreground">
              One per line as label | path. Contents are never imported or
              fetched.
            </p>
            <textarea
              aria-label="Attached path references"
              className="min-h-24 rounded border border-border bg-background p-2 font-mono text-sm"
              value={pathLines}
              onChange={(event) => setPathLines(event.target.value)}
            />
            <Button disabled={busy} className="justify-self-start">
              Save paths
            </Button>
          </form>
          <section className="mt-6 grid gap-3 rounded border border-border p-3">
            <h3 className="font-semibold">Repository preparation</h3>
            {repositoryConflict && (
              <div
                role="alert"
                className="rounded border border-destructive p-3"
              >
                <p>
                  Repository preparation changed elsewhere. Your branch draft
                  and its original epoch/revision are preserved.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => loadRepositoryDraft(selected, datasetEpoch)}
                  >
                    Reread and discard repository draft
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const preparation = selected.repositoryPreparation;
                      const serverAction = preparation.parentBranchName
                        ? "associate-stacked"
                        : preparation.branchName
                          ? "associate-independent"
                          : "create-independent";
                      setRepositoryDraftRevision(preparation.revision);
                      setRepositoryDraftEpoch(datasetEpoch);
                      setRepositoryBaseValue(
                        repositoryDraftValue(
                          preparation.environmentId ?? "",
                          preparation.branchName ?? "",
                          preparation.parentBranchName ?? "",
                          serverAction,
                        ),
                      );
                      setRepositoryConflict(false);
                    }}
                  >
                    Rebase repository draft on latest state
                  </Button>
                </div>
              </div>
            )}
            <dl className="grid gap-1 text-sm">
              <div>
                <dt className="font-medium">Project</dt>
                <dd>{selected.repositoryPreparation.projectId}</dd>
              </div>
              <div>
                <dt className="font-medium">Host</dt>
                <dd>{selected.repositoryPreparation.hostId}</dd>
              </div>
              <div>
                <dt className="font-medium">Main repository</dt>
                <dd className="break-all">
                  {selected.repositoryPreparation.repository}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Selected BB environment</dt>
                <dd>
                  {selected.repositoryPreparation.environmentId ??
                    "Not selected"}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Exact task branch</dt>
                <dd>
                  {selected.repositoryPreparation.branchName ?? "Not prepared"}
                </dd>
              </div>
            </dl>
            <div
              role="status"
              className="rounded border border-border p-2 text-sm"
            >
              <p>
                <strong>
                  {selected.repositoryPreparation.observation.state}
                </strong>
              </p>
              <p>{selected.repositoryPreparation.observation.message}</p>
              {selected.repositoryPreparation.observation
                .combinedWorkingCopy && (
                <p>
                  Combined working copy:{" "}
                  {selected.repositoryPreparation.observation
                    .combinedWorkingCopy.hasChanges
                    ? `${selected.repositoryPreparation.observation.combinedWorkingCopy.changeCount} tracked or untracked change(s)`
                    : "no tracked or untracked changes reported"}
                  . Branch preparation neither assigns nor snapshots these
                  bytes.
                </p>
              )}
            </div>
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const originSelection = selectionGeneration.current;
                void run(async () => {
                  const updated = await rpc.call(
                    "selectRepositoryEnvironment",
                    {
                      id: selected.id,
                      datasetEpoch: repositoryDraftEpoch,
                      expectedRepositoryRevision: repositoryDraftRevision,
                      environmentId: repositoryEnvironment,
                    },
                  );
                  acceptRepository(
                    updated,
                    selected.id,
                    repositoryDraftEpoch,
                    originSelection,
                  );
                });
              }}
            >
              <label>
                Reusable main-checkout environment ID{" "}
                <Input
                  aria-label="Repository environment ID"
                  value={repositoryEnvironment}
                  onChange={(event) =>
                    setRepositoryEnvironment(event.target.value)
                  }
                  placeholder="env_..."
                />
              </label>
              <Button
                type="submit"
                variant="outline"
                disabled={
                  busy || repositoryConflict || !repositoryEnvironment.trim()
                }
                className="justify-self-start"
              >
                Select and validate environment
              </Button>
            </form>
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const originSelection = selectionGeneration.current;
                void run(async () => {
                  const updated = await rpc.call("prepareRepository", {
                    id: selected.id,
                    datasetEpoch: repositoryDraftEpoch,
                    expectedRepositoryRevision: repositoryDraftRevision,
                    action: repositoryAction,
                    branchName: repositoryBranch,
                    parentBranchName:
                      repositoryAction.includes("stacked") ||
                      repositoryAction === "restack-existing"
                        ? repositoryParent
                        : null,
                  });
                  acceptRepository(
                    updated,
                    selected.id,
                    repositoryDraftEpoch,
                    originSelection,
                  );
                });
              }}
            >
              <label>
                Explicit action{" "}
                <select
                  aria-label="Repository preparation action"
                  className="block rounded border border-border bg-background p-2"
                  value={repositoryAction}
                  onChange={(event) =>
                    setRepositoryAction(
                      event.target.value as typeof repositoryAction,
                    )
                  }
                >
                  <option value="create-independent">
                    Create new independent branch
                  </option>
                  <option value="associate-independent">
                    Associate existing independent branch
                  </option>
                  <option value="create-stacked">
                    Create new branch above prerequisite
                  </option>
                  <option value="associate-stacked">
                    Associate existing stacked branch
                  </option>
                  <option value="restack-existing">
                    Deliberately move existing branch above prerequisite
                  </option>
                </select>
              </label>
              <label>
                Exact full branch name{" "}
                <Input
                  aria-label="Exact task branch name"
                  value={repositoryBranch}
                  onChange={(event) => setRepositoryBranch(event.target.value)}
                />
              </label>
              {(repositoryAction.includes("stacked") ||
                repositoryAction === "restack-existing") && (
                <label>
                  Exact prerequisite branch name{" "}
                  <Input
                    aria-label="Exact prerequisite branch name"
                    value={repositoryParent}
                    onChange={(event) =>
                      setRepositoryParent(event.target.value)
                    }
                  />
                </label>
              )}
              <p className="text-sm text-muted-foreground">
                Informational task dependencies never alter GitButler stacks.
                This action never commits, applies/unapplies branches, changes
                task status, or starts/restarts a thread.
              </p>
              <Button
                type="submit"
                disabled={
                  busy ||
                  repositoryConflict ||
                  !selected.repositoryPreparation.environmentId ||
                  !repositoryBranch.trim() ||
                  ((repositoryAction.includes("stacked") ||
                    repositoryAction === "restack-existing") &&
                    !repositoryParent.trim())
                }
                className="justify-self-start"
              >
                Prepare repository work
              </Button>
            </form>
            <details>
              <summary>Correct or reassociate enrolled repository</summary>
              {correctionConflict && (
                <div
                  role="alert"
                  className="mt-2 rounded border border-destructive p-3"
                >
                  <p>
                    Enrollment or dataset identity changed elsewhere. Your
                    correction draft is preserved.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() =>
                        selectedEnrollment &&
                        loadCorrectionDraft(
                          selected,
                          selectedEnrollment.revision,
                          datasetEpoch,
                        )
                      }
                    >
                      Reread and discard correction draft
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (!selectedEnrollment) return;
                        setCorrectionDraftRevision(selectedEnrollment.revision);
                        setCorrectionDraftEpoch(datasetEpoch);
                        setCorrectionBaseValue(
                          JSON.stringify([
                            "",
                            selected.repositoryPreparation.environmentId ?? "",
                          ]),
                        );
                        setCorrectionConflict(false);
                      }}
                    >
                      Rebase correction draft on latest state
                    </Button>
                  </div>
                </div>
              )}
              <form
                className="mt-2 grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const candidate = data?.candidates.find(
                      (item) => item.sourceId === correctionSource,
                    );
                    if (!candidate)
                      throw Error(
                        "Select an available replacement repository.",
                      );
                    if (!selectedEnrollment)
                      throw Error("Enrolled project record is unavailable.");
                    const updated = await rpc.call("reassociateEnrollment", {
                      enrollmentId: selectedEnrollment.id,
                      datasetEpoch: correctionDraftEpoch,
                      expectedEnrollmentRevision: correctionDraftRevision,
                      projectId: candidate.projectId,
                      sourceId: candidate.sourceId,
                      environmentId: correctionEnvironment,
                    });
                    setCorrectionDraftRevision(updated.revision);
                    setCorrectionDraftEpoch(correctionDraftEpoch);
                    setCorrectionSource("");
                    setCorrectionBaseValue(
                      JSON.stringify(["", correctionEnvironment]),
                    );
                    setCorrectionConflict(false);
                  });
                }}
              >
                <select
                  aria-label="Replacement main repository"
                  className="rounded border border-border bg-background p-2"
                  value={correctionSource}
                  onChange={(event) => setCorrectionSource(event.target.value)}
                >
                  <option value="">
                    Select replacement project repository
                  </option>
                  {data?.candidates.map((item) => (
                    <option key={item.sourceId} value={item.sourceId}>
                      {item.name} — {item.repository}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label="Replacement environment ID"
                  value={correctionEnvironment}
                  onChange={(event) =>
                    setCorrectionEnvironment(event.target.value)
                  }
                  placeholder="env_..."
                />
                <p className="text-sm text-muted-foreground">
                  Reassociation preserves every task UUID, display ID, number,
                  project prefix, memory record and status. Saved branch names
                  remain exact but must be revalidated in the corrected
                  repository.
                </p>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    busy ||
                    correctionConflict ||
                    !correctionSource ||
                    !correctionEnvironment.trim()
                  }
                  className="justify-self-start"
                >
                  Reassociate without repair
                </Button>
              </form>
            </details>
          </section>
          <section className="mt-6 rounded border border-border p-3">
            <h3 className="font-semibold">Linked BB conversations</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Linking only records durable authorization. It sends nothing and
              never starts, stops, moves, or reconfigures the conversation or
              its repository.
            </p>
            <div className="mt-4 rounded border border-border p-3">
              <h4 className="font-medium">Start a new ordinary conversation</h4>
              <p className="mt-1 text-sm text-muted-foreground">
                The normal BB composer keeps structured input, mentions,
                attachments and execution choices. Task context is appended as a
                separate text block. Discussion does not require branch
                preparation or a status change.
              </p>
              {selectedEnrollment ? (
                <TaskStartComposer
                  key={`${datasetEpoch}:${selected.id}`}
                  task={selected}
                  enrollment={selectedEnrollment}
                  datasetEpoch={datasetEpoch}
                  onSubmit={submitTaskThread}
                />
              ) : (
                <p role="alert">Current enrolled project is unavailable.</p>
              )}
              {startNotices[selected.id] && (
                <p role="status" className="mt-2 text-sm">
                  {startNotices[selected.id]}
                </p>
              )}
              {currentStart && (
                <div className="mt-3 rounded border border-border p-3">
                  <p>
                    Durable start {currentStart.id} · {currentStart.state}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {currentStart.createdAt}. Input digest{" "}
                    {currentStart.inputDigest}. No transcript body is stored in
                    this operation.
                  </p>
                  {currentStart.error && (
                    <p role="alert" className="mt-1 text-sm">
                      {currentStart.error}
                    </p>
                  )}
                  {currentStart.state === "awaiting-link" &&
                    currentStart.threadId && (
                      <Button
                        type="button"
                        className="mt-2"
                        disabled={busy}
                        onClick={() => {
                          const originTask = selected.id;
                          const originEpoch = datasetEpoch;
                          const operationEpoch = currentStart.datasetEpoch;
                          const originSelection = selectionGeneration.current;
                          void runStartRecovery(
                            originTask,
                            originEpoch,
                            originSelection,
                            async () => {
                              const result = await rpc.call("retryStartLink", {
                                id: originTask,
                                operationId: currentStart.id,
                                datasetEpoch: operationEpoch,
                              });
                              if (
                                !isCurrentStartView(
                                  originTask,
                                  originEpoch,
                                  originSelection,
                                )
                              )
                                return;
                              setStartNotices((current) => ({
                                ...current,
                                [originTask]:
                                  result.error ??
                                  `Start operation is ${result.state}.`,
                              }));
                              if (
                                result.state === "linked" &&
                                result.threadId
                              ) {
                                delete startSubmissions.current[originTask];
                                navigate.toThread(result.threadId);
                              }
                              await refresh();
                            },
                          );
                        }}
                      >
                        Retry linking recorded conversation
                      </Button>
                    )}
                  {currentStart.state === "uncertain" && (
                    <div className="mt-3 grid gap-2">
                      <p className="text-sm text-muted-foreground">
                        BB may already have created the conversation. Enter an
                        exact thread ID chosen by a human; title, time and text
                        are never used to guess.
                      </p>
                      <Input
                        aria-label="Exact conversation ID for uncertain start"
                        value={startRecoveryIds[currentStart.id] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          startRecoveryEditGenerations.current[
                            currentStart.id
                          ] =
                            (startRecoveryEditGenerations.current[
                              currentStart.id
                            ] ?? 0) + 1;
                          setStartRecoveryIds((current) => ({
                            ...current,
                            [currentStart.id]: value,
                          }));
                          setStartRecoveryCandidates((current) => ({
                            ...current,
                            [currentStart.id]: undefined,
                          }));
                        }}
                        placeholder="thr_..."
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          busy ||
                          !(startRecoveryIds[currentStart.id] ?? "").trim()
                        }
                        onClick={() => {
                          const originTask = selected.id;
                          const originEpoch = datasetEpoch;
                          const originSelection = selectionGeneration.current;
                          const submittedThreadId = (
                            startRecoveryIds[currentStart.id] ?? ""
                          ).trim();
                          const editGeneration =
                            startRecoveryEditGenerations.current[
                              currentStart.id
                            ] ?? 0;
                          void runStartRecovery(
                            originTask,
                            originEpoch,
                            originSelection,
                            async () => {
                              const candidate = await rpc.call(
                                "inspectThreadCandidate",
                                {
                                  id: originTask,
                                  datasetEpoch: originEpoch,
                                  threadId: submittedThreadId,
                                },
                              );
                              if (
                                !isCurrentStartView(
                                  originTask,
                                  originEpoch,
                                  originSelection,
                                ) ||
                                (
                                  startRecoveryIds[currentStart.id] ?? ""
                                ).trim() !== submittedThreadId ||
                                (startRecoveryEditGenerations.current[
                                  currentStart.id
                                ] ?? 0) !== editGeneration
                              )
                                return;
                              setStartRecoveryCandidates((current) => ({
                                ...current,
                                [currentStart.id]: {
                                  candidate,
                                  datasetEpoch: originEpoch,
                                  threadId: submittedThreadId,
                                  editGeneration,
                                },
                              }));
                            },
                          );
                        }}
                      >
                        Validate exact conversation
                      </Button>
                      {startRecoveryCandidate && (
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            const originTask = selected.id;
                            const originEpoch = datasetEpoch;
                            const operationEpoch = currentStart.datasetEpoch;
                            const originSelection = selectionGeneration.current;
                            const candidate = startRecoveryCandidate;
                            const submittedThreadId = candidate.threadId;
                            const editGeneration =
                              startRecoveryEditGenerations.current[
                                currentStart.id
                              ] ?? 0;
                            void runStartRecovery(
                              originTask,
                              originEpoch,
                              originSelection,
                              async () => {
                                const result = await rpc.call(
                                  "identifyStartThread",
                                  {
                                    id: originTask,
                                    operationId: currentStart.id,
                                    datasetEpoch: operationEpoch,
                                    threadId: candidate.threadId,
                                    expectedCurrentLinkRevision:
                                      candidate.currentLink?.linkRevision ??
                                      null,
                                    reassign: Boolean(
                                      candidate.currentLink &&
                                      candidate.currentLink.taskId !==
                                        originTask,
                                    ),
                                  },
                                );
                                if (
                                  !isCurrentStartView(
                                    originTask,
                                    originEpoch,
                                    originSelection,
                                  ) ||
                                  (
                                    startRecoveryIds[currentStart.id] ?? ""
                                  ).trim() !== submittedThreadId ||
                                  (startRecoveryEditGenerations.current[
                                    currentStart.id
                                  ] ?? 0) !== editGeneration
                                )
                                  return;
                                if (
                                  result.state === "linked" &&
                                  result.threadId
                                ) {
                                  delete startSubmissions.current[originTask];
                                  navigate.toThread(result.threadId);
                                }
                                await refresh();
                              },
                            );
                          }}
                        >
                          {startRecoveryCandidate.currentLink &&
                          startRecoveryCandidate.currentLink.taskId !==
                            selected.id
                            ? `Identify and reassign to ${selected.displayId}`
                            : `Identify and link to ${selected.displayId}`}
                        </Button>
                      )}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => {
                      const originTask = selected.id;
                      const originEpoch = datasetEpoch;
                      const operationEpoch = currentStart.datasetEpoch;
                      const originSelection = selectionGeneration.current;
                      void runStartRecovery(
                        originTask,
                        originEpoch,
                        originSelection,
                        async () => {
                          await rpc.call("abandonStartOperation", {
                            id: originTask,
                            operationId: currentStart.id,
                            datasetEpoch: operationEpoch,
                          });
                          if (
                            !isCurrentStartView(
                              originTask,
                              originEpoch,
                              originSelection,
                            )
                          )
                            return;
                          delete startSubmissions.current[originTask];
                          setStartNotices((current) => ({
                            ...current,
                            [originTask]:
                              "Start operation quarantined. The existing conversation, if any, was not changed. A later composer submission is a separate deliberate attempt.",
                          }));
                          await refresh();
                        },
                      );
                    }}
                  >
                    Abandon and quarantine this start
                  </Button>
                </div>
              )}
            </div>
            <form
              className="mt-3 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const originTask = selected.id;
                const originEpoch = datasetEpoch;
                const originSelection = selectionGeneration.current;
                const submittedThreadId = linkDraft.trim();
                setBusy(true);
                setError("");
                void rpc
                  .call("inspectThreadCandidate", {
                    id: originTask,
                    datasetEpoch: originEpoch,
                    threadId: submittedThreadId,
                  })
                  .then((candidate) => {
                    if (
                      selectedTaskRef.current === originTask &&
                      datasetEpochRef.current === originEpoch &&
                      selectionGeneration.current === originSelection &&
                      (linkDraftsRef.current[originTask] ?? "").trim() ===
                        submittedThreadId
                    )
                      setLinkCandidates((current) => ({
                        ...current,
                        [originTask]: {
                          candidate,
                          datasetEpoch: originEpoch,
                        },
                      }));
                  })
                  .catch(report)
                  .finally(() => setBusy(false));
              }}
            >
              <label>
                Existing BB thread ID{" "}
                <Input
                  aria-label="Existing BB thread ID"
                  value={linkDraft}
                  onChange={(event) => {
                    const value = event.target.value;
                    linkDraftsRef.current[selected.id] = value;
                    setLinkDrafts((current) => ({
                      ...current,
                      [selected.id]: value,
                    }));
                    setLinkCandidates((current) => ({
                      ...current,
                      [selected.id]: undefined,
                    }));
                  }}
                  placeholder="thr_..."
                />
              </label>
              <Button
                type="submit"
                variant="outline"
                disabled={busy || !linkDraft.trim()}
                className="justify-self-start"
              >
                Validate existing thread
              </Button>
            </form>
            {linkCandidate && linkCandidate.threadId === linkDraft.trim() && (
              <div className="mt-3 rounded border border-border p-3">
                <p>
                  {linkCandidate.title ?? linkCandidate.threadId} ·{" "}
                  {linkCandidate.availability} · {linkCandidate.runtimeStatus}
                </p>
                {linkCandidate.environmentMismatch && (
                  <p role="alert" className="mt-1 text-sm">
                    {linkCandidate.environmentMismatch}
                  </p>
                )}
                {linkCandidate.currentLink &&
                  linkCandidate.currentLink.taskId !== selected.id && (
                    <p role="alert" className="mt-1 text-sm">
                      Currently linked to {linkCandidate.currentLink.displayId}.
                      Reassignment is explicit and invalidates revision{" "}
                      {linkCandidate.currentLink.linkRevision}.
                    </p>
                  )}
                <Button
                  type="button"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => {
                    const originTask = selected.id;
                    const originEpoch = datasetEpoch;
                    const originSelection = selectionGeneration.current;
                    const candidate = linkCandidate;
                    void run(async () => {
                      await rpc.call("linkThread", {
                        id: originTask,
                        datasetEpoch: originEpoch,
                        threadId: candidate.threadId,
                        expectedCurrentLinkRevision:
                          candidate.currentLink?.linkRevision ?? null,
                        reassign: Boolean(
                          candidate.currentLink &&
                          candidate.currentLink.taskId !== originTask,
                        ),
                      });
                      if (
                        selectedTaskRef.current === originTask &&
                        datasetEpochRef.current === originEpoch &&
                        selectionGeneration.current === originSelection
                      ) {
                        linkDraftsRef.current[originTask] = "";
                        setLinkDrafts((current) => ({
                          ...current,
                          [originTask]: "",
                        }));
                        setLinkCandidates((current) => ({
                          ...current,
                          [originTask]: undefined,
                        }));
                      }
                    });
                  }}
                >
                  {linkCandidate.currentLink &&
                  linkCandidate.currentLink.taskId !== selected.id
                    ? `Reassign to ${selected.displayId}`
                    : `Link to ${selected.displayId}`}
                </Button>
              </div>
            )}
            <div className="mt-4 grid gap-3">
              {selected.linkedThreads.map((link) => (
                <article
                  key={link.threadId}
                  className="rounded border border-border p-3"
                >
                  <p>
                    {link.lastKnownTitle ?? link.threadId} · {link.availability}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {link.threadId} · authorization revision {link.linkRevision}
                  </p>
                  <p className="mt-1 text-sm">{link.message}</p>
                  {link.environmentMismatch && (
                    <p role="alert" className="mt-1 text-sm">
                      {link.environmentMismatch}
                    </p>
                  )}
                  {threadNotices[
                    `${selected.id}:${link.threadId}:${link.linkRevision}`
                  ] && (
                    <p role="status" className="mt-1 text-sm">
                      {
                        threadNotices[
                          `${selected.id}:${link.threadId}:${link.linkRevision}`
                        ]
                      }
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => navigate.toThread(link.threadId)}
                    >
                      Open conversation
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          rpc.call("refreshThreadLink", {
                            id: selected.id,
                            datasetEpoch,
                            threadId: link.threadId,
                            expectedLinkRevision: link.linkRevision,
                          }),
                        )
                      }
                    >
                      Refresh reference
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || link.availability !== "available"}
                      onClick={() =>
                        (() => {
                          const originTask = selected.id;
                          const originEpoch = datasetEpoch;
                          const originSelection = selectionGeneration.current;
                          void run(async () => {
                            const result = await rpc.call("sendTaskContext", {
                              id: originTask,
                              datasetEpoch: originEpoch,
                              threadId: link.threadId,
                              expectedLinkRevision: link.linkRevision,
                            });
                            if (
                              selectedTaskRef.current === originTask &&
                              datasetEpochRef.current === originEpoch &&
                              selectionGeneration.current === originSelection
                            )
                              setThreadNotices((current) => ({
                                ...current,
                                [`${originTask}:${link.threadId}:${link.linkRevision}`]:
                                  result.message,
                              }));
                          });
                        })()
                      }
                    >
                      Send current task context
                    </Button>
                    {link.runtimeStatus === "idle" && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          (() => {
                            const originTask = selected.id;
                            const originEpoch = datasetEpoch;
                            const originSelection = selectionGeneration.current;
                            void run(async () => {
                              const result = await rpc.call(
                                "releaseIdleThreadRuntime",
                                {
                                  id: originTask,
                                  datasetEpoch: originEpoch,
                                  threadId: link.threadId,
                                  expectedLinkRevision: link.linkRevision,
                                },
                              );
                              if (
                                selectedTaskRef.current === originTask &&
                                datasetEpochRef.current === originEpoch &&
                                selectionGeneration.current === originSelection
                              )
                                setThreadNotices((current) => ({
                                  ...current,
                                  [`${originTask}:${link.threadId}:${link.linkRevision}`]:
                                    result.message,
                                }));
                            });
                          })()
                        }
                      >
                        Release idle runtime (best effort)
                      </Button>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Tool availability is session-bound and cannot be inspected
                    from this reference. Newly started enrolled-project sessions
                    are configured with the narrow tools. On this host, an older
                    provider session can persist without new tools even after an
                    idle release. The verified recovery is BB's normal New
                    thread flow in this enrolled project, followed by linking
                    that new conversation and explicitly sending current task
                    context. Active work is never stopped automatically.
                  </p>
                </article>
              ))}
              {selected.linkedThreads.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No linked conversations.
                </p>
              )}
            </div>
          </section>
          <h3 className="mt-6 font-semibold">Task memory</h3>
          {!memoryView && <p role="status">Reading canonical memory…</p>}
          {memoryDraftConflict && (
            <div
              role="alert"
              className="my-3 rounded border border-destructive p-3"
            >
              <p>
                Canonical memory changed while your draft was dirty. The draft
                and its original dataset/revision/hash token are preserved.
              </p>
              {memoryView?.state === "healthy" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => loadMemoryDraft(memoryView)}
                  >
                    Reread and discard memory draft
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setMemoryDraftToken(memoryView.token);
                      setMemoryBase(memoryView.content);
                      setMemoryDraftConflict(false);
                      setMemoryOperation(null);
                    }}
                  >
                    Rebase draft on latest memory token
                  </Button>
                </div>
              )}
            </div>
          )}
          {memoryView?.state === "healthy" && (
            <>
              <p className="text-sm text-muted-foreground">
                Revision {memoryView.token.memoryRevision} · latest accepted:{" "}
                {memoryView.attribution.kind} via {memoryView.attribution.route}
                {memoryView.attribution.threadId
                  ? ` from ${memoryView.attribution.threadId}`
                  : ""}{" "}
                {memoryView.attribution.at
                  ? ` at ${memoryView.attribution.at}`
                  : " at an unknown legacy acceptance time"}
              </p>
              <form
                className="mt-2 grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!memoryDraftToken) return;
                  const originTask = selected.id;
                  const originSelection = selectionGeneration.current;
                  const originEpoch = memoryDraftToken.datasetEpoch;
                  const submittedContent = memoryDraft;
                  const submittedEditGeneration = memoryEditGeneration.current;
                  void run(async () => {
                    const operation =
                      memoryOperation?.content === submittedContent
                        ? memoryOperation
                        : {
                            id: crypto.randomUUID(),
                            content: submittedContent,
                          };
                    setMemoryOperation(operation);
                    const result = await rpc.call("saveMemory", {
                      id: originTask,
                      operationId: operation.id,
                      token: memoryDraftToken,
                      content: submittedContent,
                    });
                    if (
                      "token" in result &&
                      selectedTaskRef.current === originTask &&
                      datasetEpochRef.current === originEpoch &&
                      selectionGeneration.current === originSelection
                    ) {
                      const accepted: Extract<
                        MemoryView,
                        { state: "healthy" }
                      > = {
                        state: "healthy",
                        content: submittedContent,
                        token: result.token,
                        attribution: result.attribution,
                      };
                      setMemoryView(accepted);
                      if (
                        memoryEditGeneration.current === submittedEditGeneration
                      )
                        loadMemoryDraft(accepted);
                      else {
                        setMemoryBase(submittedContent);
                        setMemoryDraftToken(result.token);
                        setMemoryDraftConflict(false);
                        setMemoryOperation(null);
                      }
                    } else {
                      if (!("token" in result)) setError(result.message);
                      await refreshMemory();
                    }
                  });
                }}
              >
                <label>
                  Canonical Markdown editor{" "}
                  <textarea
                    aria-label="Edit task memory Markdown"
                    className="block min-h-48 w-full rounded border border-border bg-background p-2"
                    value={memoryDraft}
                    disabled={busy}
                    onChange={(event) => {
                      memoryEditGeneration.current += 1;
                      setMemoryDraft(event.target.value);
                      if (
                        memoryOperation &&
                        memoryOperation.content !== event.target.value
                      )
                        setMemoryOperation(null);
                    }}
                  />
                </label>
                <Button
                  disabled={
                    busy ||
                    !memoryDirty ||
                    memoryDraftConflict ||
                    memoryView.state !== "healthy"
                  }
                  className="justify-self-start"
                >
                  Save task memory
                </Button>
              </form>
              <h4 className="mt-3 font-medium">Canonical content</h4>
              <Markdown
                content={safeMarkdown(memoryView.content || "_Empty memory._")}
              />
            </>
          )}
          {memoryView?.state === "pending" && (
            <div role="alert" className="mt-2 rounded border p-3">
              <p>Memory operation {memoryView.operationId} is pending.</p>
              <p>{memoryView.message}</p>
              <Button
                type="button"
                disabled={busy}
                onClick={() => void run(() => refreshMemory())}
              >
                Reconcile durable memory operation
              </Button>
            </div>
          )}
          {memoryView?.state === "conflict" && (
            <div
              role="alert"
              className="mt-2 rounded border border-destructive p-3"
            >
              <p>
                Memory conflict ({memoryView.reason}). External attribution is
                unknown; bytes were preserved.
              </p>
              <p>{memoryView.message}</p>
              {memoryView.operationId && (
                <p>Durable operation: {memoryView.operationId}</p>
              )}
              {memoryView.content !== null && (
                <>
                  <h4 className="mt-3 font-medium">
                    Current canonical external content
                  </h4>
                  <Markdown
                    content={safeMarkdown(
                      memoryView.content || "_Empty external memory._",
                    )}
                  />
                </>
              )}
              {memoryView.allowedActions.includes("accept-external") &&
                memoryView.observedHash && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      (() => {
                        const originTask = selected.id;
                        const originSelection = selectionGeneration.current;
                        const originEpoch =
                          memoryView.committedToken.datasetEpoch;
                        void run(async () => {
                          const result = await rpc.call(
                            "acceptExternalMemory",
                            {
                              id: originTask,
                              operationId: crypto.randomUUID(),
                              token: memoryView.committedToken,
                              observedHash: memoryView.observedHash!,
                            },
                          );
                          if (!("token" in result)) throw Error(result.message);
                          if (
                            selectedTaskRef.current === originTask &&
                            datasetEpochRef.current === originEpoch &&
                            selectionGeneration.current === originSelection
                          )
                            await refreshMemory();
                        });
                      })()
                    }
                  >
                    Accept current external content
                  </Button>
                )}
              {memoryView.allowedActions.includes("restore-known") && (
                <form
                  className="mt-3 grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const originTask = selected.id;
                    const originSelection = selectionGeneration.current;
                    const originEpoch = memoryView.committedToken.datasetEpoch;
                    void run(async () => {
                      const result = await rpc.call("restoreKnownMemory", {
                        id: originTask,
                        operationId: crypto.randomUUID(),
                        token: memoryView.committedToken,
                        observedHash: memoryView.observedHash,
                        content: memoryRestoreKnown,
                      });
                      if (!("token" in result)) throw Error(result.message);
                      if (
                        selectedTaskRef.current === originTask &&
                        datasetEpochRef.current === originEpoch &&
                        selectionGeneration.current === originSelection
                      ) {
                        setMemoryRestoreKnown("");
                        await refreshMemory();
                      }
                    });
                  }}
                >
                  <label>
                    Verified known Markdown bytes{" "}
                    <textarea
                      aria-label="Verified known task memory"
                      className="block min-h-32 w-full rounded border border-border bg-background p-2"
                      value={memoryRestoreKnown}
                      onChange={(event) =>
                        setMemoryRestoreKnown(event.target.value)
                      }
                    />
                  </label>
                  <Button disabled={busy} className="justify-self-start">
                    Restore verified known content
                  </Button>
                </form>
              )}
              {memoryView.allowedActions.length === 0 && (
                <p>
                  This unsafe file shape cannot be replaced through the plugin.
                  Correct the canonical filesystem entry manually, then reread;
                  no target or unknown bytes will be overwritten.
                </p>
              )}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Task workspace",
    icon: "ListTodo",
    path: "board",
    component: Board,
  });
});
