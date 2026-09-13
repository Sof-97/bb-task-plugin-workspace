import { useCallback, useEffect, useRef, useState } from "react";
import {
  Markdown,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  Task,
  WayfinderSourceRead,
  WayfinderView,
  rpcContract,
} from "./contract";
import { safeMarkdown } from "./markdown";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

export function WayfinderPanel({
  task,
  datasetEpoch,
}: {
  task: Task;
  datasetEpoch: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const attachment = task.wayfinderAttachment;
  const attachmentRevision = attachment?.revision ?? 0;
  const attachmentIdentity = attachment
    ? `${attachment.projectId}\0${attachment.hostId}\0${attachment.repository}\0${attachment.mapPath}\0${attachment.selectedDirectory}`
    : "";
  const [viewId] = useState(() => crypto.randomUUID());
  const [mapPath, setMapPath] = useState(
    attachment?.mapPath ?? "planning/map.md",
  );
  const [selectedDirectory, setSelectedDirectory] = useState(
    attachment?.selectedDirectory ?? "",
  );
  const [draftBase, setDraftBase] = useState(() => ({
    epoch: datasetEpoch,
    revision: attachmentRevision,
    mapPath: attachment?.mapPath ?? "planning/map.md",
    selectedDirectory: attachment?.selectedDirectory ?? "",
    identity: attachmentIdentity,
  }));
  const [draftConflict, setDraftConflict] = useState(false);
  const [inspection, setInspection] = useState<WayfinderSourceRead | null>(
    null,
  );
  const [view, setView] = useState<WayfinderView | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [staleReason, setStaleReason] = useState("");
  const [degraded, setDegraded] = useState(false);
  const generation = useRef(0);
  const editGeneration = useRef(0);
  const inspectGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const timer = useRef<number | null>(null);
  const previousConnection = useRef(connection);
  const viewRef = useRef<WayfinderView | null>(null);
  viewRef.current = view;
  const draftRef = useRef({
    datasetEpoch,
    mapPath,
    selectedDirectory,
    draftBase,
    attachmentRevision,
    attachmentIdentity,
  });
  draftRef.current = {
    datasetEpoch,
    mapPath,
    selectedDirectory,
    draftBase,
    attachmentRevision,
    attachmentIdentity,
  };
  const draftDirty =
    mapPath !== draftBase.mapPath ||
    selectedDirectory !== draftBase.selectedDirectory;

  const read = useCallback(async () => {
    if (!attachmentIdentity) return;
    const request = ++generation.current;
    try {
      const result = await rpc.call("readWayfinderView", {
        id: task.id,
        datasetEpoch,
        viewId,
      });
      if (request !== generation.current) return;
      setView(result);
      setError("");
      setStaleReason("");
      setDegraded(result.refreshState === "degraded");
      setSelectedPath((current) =>
        current &&
        result.graph.tickets.some((ticket) => ticket.path === current)
          ? current
          : (result.graph.frontier.knownReadyPaths[0] ??
            result.graph.tickets[0]?.path ??
            ""),
      );
    } catch (value) {
      if (request !== generation.current) return;
      const message = value instanceof Error ? value.message : String(value);
      setError(message);
      if (viewRef.current) setStaleReason(message);
    }
  }, [
    attachmentIdentity,
    attachmentRevision,
    datasetEpoch,
    rpc,
    task.id,
    viewId,
  ]);

  const scheduleRead = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void read();
    }, 100);
  }, [read]);

  useEffect(() => {
    if (
      viewRef.current &&
      attachmentIdentity &&
      viewRef.current.attachment.revision !== attachmentRevision
    )
      setStaleReason(
        "Attachment identity changed; this prior generation is retained only until the replacement read completes.",
      );
    if (attachmentIdentity) void read();
    return () => {
      generation.current += 1;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [attachmentIdentity, attachmentRevision, read]);

  useEffect(
    () => () => {
      generation.current += 1;
      inspectGeneration.current += 1;
      saveGeneration.current += 1;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      void rpc.call("closeWayfinderView", { viewId }).catch(() => undefined);
    },
    [rpc, viewId],
  );

  useEffect(() => {
    if (
      draftBase.epoch === datasetEpoch &&
      draftBase.revision === attachmentRevision &&
      draftBase.identity === attachmentIdentity
    )
      return;
    inspectGeneration.current += 1;
    saveGeneration.current += 1;
    setInspection(null);
    if (draftDirty) {
      setDraftConflict(true);
      return;
    }
    const nextMap = attachment?.mapPath ?? "planning/map.md";
    const nextDirectory = attachment?.selectedDirectory ?? "";
    setMapPath(nextMap);
    setSelectedDirectory(nextDirectory);
    setDraftBase({
      epoch: datasetEpoch,
      revision: attachmentRevision,
      mapPath: nextMap,
      selectedDirectory: nextDirectory,
      identity: attachmentIdentity,
    });
    setDraftConflict(false);
    editGeneration.current += 1;
  }, [
    attachment?.mapPath,
    attachment?.selectedDirectory,
    attachmentIdentity,
    attachmentRevision,
    datasetEpoch,
    draftBase,
    draftDirty,
  ]);

  useRealtime("wayfinderChanged", (event) => {
    const payload = event as { viewId: string; kind: string };
    if (payload.viewId !== viewId) return;
    if (payload.kind === "watch-error" || payload.kind === "worker-exit")
      setDegraded(true);
    scheduleRead();
  });

  useEffect(() => {
    if (
      previousConnection.current !== "connected" &&
      connection === "connected"
    )
      scheduleRead();
    previousConnection.current = connection;
  }, [connection, scheduleRead]);

  useEffect(() => {
    const refresh = () => scheduleRead();
    const visible = () =>
      document.visibilityState === "visible" && scheduleRead();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [scheduleRead]);

  useEffect(() => {
    if (!degraded) return;
    const poll = window.setInterval(
      () => document.visibilityState === "visible" && scheduleRead(),
      5000,
    );
    return () => window.clearInterval(poll);
  }, [degraded, scheduleRead]);

  const selected = view?.graph.tickets.find(
    (ticket) => ticket.path === selectedPath,
  );

  async function inspect() {
    const request = ++inspectGeneration.current;
    const edit = editGeneration.current;
    const input = { mapPath, selectedDirectory };
    const epoch = datasetEpoch;
    setBusy(true);
    setError("");
    try {
      const result = await rpc.call("inspectWayfinderSource", {
        id: task.id,
        datasetEpoch,
        mapPath: input.mapPath,
        selectedDirectory: input.selectedDirectory || null,
      });
      const current = draftRef.current;
      if (
        request !== inspectGeneration.current ||
        edit !== editGeneration.current ||
        current.datasetEpoch !== epoch ||
        current.mapPath !== input.mapPath ||
        current.selectedDirectory !== input.selectedDirectory
      )
        return;
      setInspection(result);
      if (result.selectedDirectory) {
        setSelectedDirectory(result.selectedDirectory);
        editGeneration.current += 1;
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (request === inspectGeneration.current) setBusy(false);
    }
  }

  async function save() {
    if (draftConflict) return;
    const request = ++saveGeneration.current;
    const edit = editGeneration.current;
    const input = { mapPath, selectedDirectory };
    const base = draftBase;
    setBusy(true);
    setError("");
    try {
      const saved = await rpc.call("saveWayfinderAttachment", {
        id: task.id,
        datasetEpoch: base.epoch,
        expectedAttachmentRevision: base.revision,
        mapPath: input.mapPath,
        selectedDirectory: input.selectedDirectory || null,
      });
      const current = draftRef.current;
      if (
        request !== saveGeneration.current ||
        edit !== editGeneration.current ||
        current.datasetEpoch !== base.epoch ||
        current.mapPath !== input.mapPath ||
        current.selectedDirectory !== input.selectedDirectory
      )
        return;
      setDraftBase({
        epoch: base.epoch,
        revision: saved.revision,
        mapPath: saved.mapPath,
        selectedDirectory: saved.selectedDirectory,
        identity: `${saved.projectId}\0${saved.hostId}\0${saved.repository}\0${saved.mapPath}\0${saved.selectedDirectory}`,
      });
      setDraftConflict(false);
      setInspection(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (request === saveGeneration.current) setBusy(false);
    }
  }

  const editMapPath = (value: string) => {
    editGeneration.current += 1;
    inspectGeneration.current += 1;
    setInspection(null);
    setBusy(false);
    setMapPath(value);
  };
  const editSelectedDirectory = (value: string) => {
    editGeneration.current += 1;
    inspectGeneration.current += 1;
    setInspection(null);
    setBusy(false);
    setSelectedDirectory(value);
  };
  const acceptLatestAttachment = (retainDraft: boolean) => {
    inspectGeneration.current += 1;
    saveGeneration.current += 1;
    editGeneration.current += 1;
    const nextMap = attachment?.mapPath ?? "planning/map.md";
    const nextDirectory = attachment?.selectedDirectory ?? "";
    if (!retainDraft) {
      setMapPath(nextMap);
      setSelectedDirectory(nextDirectory);
    }
    setDraftBase({
      epoch: datasetEpoch,
      revision: attachmentRevision,
      mapPath: retainDraft ? mapPath : nextMap,
      selectedDirectory: retainDraft ? selectedDirectory : nextDirectory,
      identity: attachmentIdentity,
    });
    setDraftConflict(false);
    setInspection(null);
  };

  return (
    <section
      className="mt-6 grid gap-3 rounded border border-border p-3"
      aria-label="Wayfinder"
    >
      <h3 className="font-semibold">Local Wayfinder</h3>
      <p className="text-sm text-muted-foreground">
        Reads the combined working copy only. It never fetches links, imports
        files, changes branches, or updates ticket status.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          Repository-relative map path
          <Input
            aria-label="Wayfinder map path"
            value={mapPath}
            onChange={(event) => editMapPath(event.target.value)}
          />
        </label>
        <label>
          Explicit sibling tickets directory
          {inspection?.candidates.length ? (
            <select
              aria-label="Wayfinder tickets directory"
              className="block w-full rounded border border-border bg-background p-2"
              value={selectedDirectory}
              onChange={(event) => editSelectedDirectory(event.target.value)}
            >
              <option value="">Select one directory</option>
              {inspection.candidates.map((candidate) => (
                <option key={candidate}>{candidate}</option>
              ))}
            </select>
          ) : (
            <Input
              aria-label="Wayfinder tickets directory"
              value={selectedDirectory}
              onChange={(event) => editSelectedDirectory(event.target.value)}
              placeholder="planning/tickets"
            />
          )}
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !mapPath.trim()}
          onClick={() => void inspect()}
        >
          Inspect source
        </Button>
        <Button
          type="button"
          disabled={
            busy ||
            draftConflict ||
            !mapPath.trim() ||
            (inspection?.status === "selection-required" && !selectedDirectory)
          }
          onClick={() => void save()}
        >
          Attach source
        </Button>
        {attachmentIdentity && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={scheduleRead}
          >
            Refresh
          </Button>
        )}
      </div>
      {draftConflict && (
        <div role="alert" className="rounded border border-border p-2 text-sm">
          <p>
            The saved Wayfinder attachment changed while this draft was open.
            Reread it or explicitly rebase this draft before saving.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => acceptLatestAttachment(false)}
            >
              Reread attachment
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => acceptLatestAttachment(true)}
            >
              Rebase draft
            </Button>
          </div>
        </div>
      )}
      {inspection && (
        <div role="status" className="rounded border border-border p-2 text-sm">
          <p>
            {inspection.status}: {inspection.tickets.length} ticket source(s)
            observed.
          </p>
          {inspection.status === "selection-required" && (
            <p>Both sibling candidates exist; select one explicitly.</p>
          )}
          {inspection.diagnostics.map((item, index) => (
            <p key={`${item.code}-${index}`}>
              {item.code}: {item.message}
            </p>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {view && (
        <>
          <div
            role="status"
            className="rounded border border-border p-2 text-sm"
          >
            <p>
              <strong>{view.workspaceLabel}</strong> · {view.environmentId} ·{" "}
              {view.branchName}
            </p>
            <p>
              Scanned {view.scanTime}; source revision{" "}
              <code>{view.sourceRevision.slice(0, 12)}</code>; refresh{" "}
              {degraded ? "degraded" : view.refreshState}.
            </p>
            {staleReason && (
              <p className="text-destructive">
                Stale preview retained from {view.scanTime}: {staleReason}
              </p>
            )}
            <p>
              {view.graph.frontier.complete
                ? `Complete frontier: ${view.graph.frontier.knownReadyPaths.length} ready.`
                : `Incomplete discovery; known-component readiness only: ${view.graph.frontier.knownReadyPaths.length} locally ready.`}
            </p>
            {view.graph.diagnostics.length > 0 && (
              <ul
                aria-label="Wayfinder source diagnostics"
                className="mt-2 list-disc pl-5 text-destructive"
              >
                {view.graph.diagnostics.map((item, index) => (
                  <li key={`${item.code}-${item.path ?? "global"}-${index}`}>
                    {item.code}: {item.message}
                    {item.path ? ` (${item.path})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div>
              <h4 className="font-medium">Tickets</h4>
              <ul aria-label="Wayfinder tickets" className="mt-2 grid gap-1">
                {view.graph.tickets
                  .filter((ticket) => ticket.scope !== "out-of-scope")
                  .map((ticket) => (
                    <li key={ticket.path}>
                      <button
                        type="button"
                        className={`w-full rounded border p-2 text-left ${ticket.path === selectedPath ? "border-primary" : "border-border"}`}
                        onClick={() => setSelectedPath(ticket.path)}
                      >
                        <span className="font-medium">
                          {ticket.id}. {ticket.title}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {ticket.status} · {ticket.type ?? "unknown type"} ·{" "}
                          {ticket.scope}
                          {view.graph.frontier.knownReadyPaths.includes(
                            ticket.path,
                          )
                            ? " · frontier-ready"
                            : ""}
                          {ticket.consistent ? "" : " · inspect"}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
              {view.graph.outOfScope.length > 0 && (
                <>
                  <h4 className="mt-3 font-medium">Out of scope</h4>
                  <ul
                    aria-label="Out-of-scope Wayfinder tickets"
                    className="mt-2 grid gap-1"
                  >
                    {view.graph.tickets
                      .filter((ticket) => ticket.scope === "out-of-scope")
                      .map((ticket) => (
                        <li key={ticket.path}>
                          <button
                            type="button"
                            className="w-full rounded border border-border p-2 text-left"
                            onClick={() => setSelectedPath(ticket.path)}
                          >
                            <span className="font-medium">
                              {ticket.id}. {ticket.title}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {ticket.status} · out-of-scope
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </div>
            <article
              aria-label="Selected Wayfinder ticket"
              className="min-w-0 rounded border border-border p-3"
            >
              {selected ? (
                <>
                  <h4 className="font-semibold">{selected.title}</h4>
                  <p className="break-all text-xs text-muted-foreground">
                    {selected.path}
                  </p>
                  {selected.questionMarkdown && (
                    <>
                      <h5 className="mt-3 font-medium">Question</h5>
                      <Markdown
                        content={safeMarkdown(selected.questionMarkdown)}
                      />
                    </>
                  )}
                  {selected.answerMarkdown && (
                    <>
                      <h5 className="mt-3 font-medium">Answer</h5>
                      <Markdown
                        content={safeMarkdown(selected.answerMarkdown)}
                      />
                    </>
                  )}
                  {selected.diagnostics.length > 0 && (
                    <ul
                      aria-label="Ticket diagnostics"
                      className="mt-3 list-disc pl-5 text-sm"
                    >
                      {selected.diagnostics.map((item, index) => (
                        <li key={`${item.code}-${index}`}>
                          {item.code}: {item.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.references.length > 0 && (
                    <>
                      <h5 className="mt-3 font-medium">Markdown references</h5>
                      <ul className="list-disc pl-5 text-sm">
                        {selected.references.map((reference, index) => (
                          <li key={`${reference.destination}-${index}`}>
                            {reference.classification === "local" &&
                            reference.identity &&
                            view.graph.tickets.some(
                              (ticket) => ticket.path === reference.identity,
                            ) ? (
                              <button
                                type="button"
                                className="underline"
                                onClick={() =>
                                  setSelectedPath(reference.identity!)
                                }
                              >
                                {reference.label || reference.destination} →{" "}
                                {reference.identity}
                                {reference.fragment
                                  ? `#${reference.fragment}`
                                  : ""}
                              </button>
                            ) : (
                              <>
                                {reference.label || reference.destination} →{" "}
                                {reference.identity ?? reference.destination}
                                {reference.fragment
                                  ? `#${reference.fragment}`
                                  : ""}
                              </>
                            )}{" "}
                            ({reference.classification})
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <p>Select a ticket.</p>
              )}
            </article>
          </div>
          <details>
            <summary>Dependency graph and map context</summary>
            <div className="mt-2 grid gap-3 text-sm">
              <section aria-label="Wayfinder graph">
                <h4 className="font-medium">Edges</h4>
                <ul className="list-disc pl-5">
                  {view.graph.edges.map((edge, index) => (
                    <li key={`${edge.sourcePath}-${index}`}>
                      {edge.sourcePath} →{" "}
                      {edge.targetPath ?? edge.navigationTarget ?? edge.raw} (
                      {edge.resolution})
                    </li>
                  ))}
                </ul>
                <h4 className="mt-2 font-medium">
                  Strongly connected components
                </h4>
                <ul className="list-disc pl-5">
                  {view.graph.sccs.map((component, index) => (
                    <li key={index}>
                      {component.paths.join(" → ")}
                      {component.cyclic ? " (cycle)" : ""}
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-label="Wayfinder map sections">
                <h4 className="font-medium">{view.graph.map.title}</h4>
                {view.graph.map.sections.map((section, index) => (
                  <div key={`${section.heading}-${index}`} className="mt-2">
                    <h5 className="font-medium">{section.heading}</h5>
                    <Markdown content={safeMarkdown(section.markdown)} />
                  </div>
                ))}
              </section>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
