import {
  CAPTURE_API_VERSION,
  CAPTURE_BODY_LIMIT,
  type CaptureAcceptedResult,
  type CaptureProjectsResult,
} from "./capture";

/**
 * Reference behavior for a future local capture client (ticket 10): visible
 * project preselection, one durable request identity per explicit submission,
 * exact-payload explicit retries and no offline queue or automatic resubmission.
 * Transport is injected so the semantics are deterministically testable; it is
 * not a shipped Raycast or CLI client.
 */

export type CaptureProjectRow = CaptureProjectsResult["projects"][number];

export type CaptureClientContext = {
  /** The client's own explicit current-project context, if it has one. */
  currentProjectId: string | null;
  /** Last project a confirmed capture succeeded for, local to this client. */
  lastSuccessfulProjectId: string | null;
};

export type CaptureSelection =
  | {
      kind: "preselected";
      projectId: string;
      source: "current" | "last-successful";
    }
  | { kind: "requires-selection" };

/**
 * Preselect the explicit current project when it is enrolled, otherwise the
 * last successfully used capture project, otherwise require an explicit
 * selection — even when exactly one project exists. An unavailable
 * preselection is never silently replaced.
 */
export function selectCaptureProject(
  projects: readonly CaptureProjectRow[],
  context: CaptureClientContext,
): CaptureSelection {
  if (context.currentProjectId) {
    const current = projects.find(
      (project) => project.projectId === context.currentProjectId,
    );
    if (current)
      return {
        kind: "preselected",
        projectId: current.projectId,
        source: "current",
      };
  }
  if (context.lastSuccessfulProjectId) {
    const previous = projects.find(
      (project) => project.projectId === context.lastSuccessfulProjectId,
    );
    if (previous)
      return {
        kind: "preselected",
        projectId: previous.projectId,
        source: "last-successful",
      };
  }
  return { kind: "requires-selection" };
}

export type CaptureDraft = {
  projectId: string;
  title: string;
  description?: string;
};

/** One durable request identity per explicit submission. */
export type CaptureSubmissionState = {
  requestId: string;
  datasetEpoch: string;
  projectId: string;
  title: string;
  description: string;
};

export function createCaptureSubmission(
  draft: CaptureDraft,
  datasetEpoch: string,
  newRequestId: () => string,
): CaptureSubmissionState {
  return {
    requestId: newRequestId(),
    datasetEpoch,
    projectId: draft.projectId,
    title: draft.title.trim(),
    description: draft.description ?? "",
  };
}

/** The exact body of one submission: identical bytes on every retry. */
export function captureSubmissionBody(
  submission: CaptureSubmissionState,
): string {
  return JSON.stringify({
    requestId: submission.requestId,
    datasetEpoch: submission.datasetEpoch,
    projectId: submission.projectId,
    title: submission.title,
    ...(submission.description ? { description: submission.description } : {}),
  });
}

export type CaptureHttpResult =
  | { ok: true; status: number; result: CaptureAcceptedResult }
  | {
      ok: false;
      status: number;
      error: {
        code: string;
        message: string;
        field?: string;
        retryable: boolean;
      };
      requestId?: string;
    };

export type CaptureTransport = (
  method: "GET" | "POST",
  path: string,
  body: string | null,
) => Promise<{ status: number; json: unknown }>;

const transportFailure: CaptureHttpResult = {
  ok: false,
  status: 0,
  error: {
    code: "TRANSPORT_FAILURE",
    message:
      "No application response arrived. Keep the draft and request identity; retry explicitly instead of resubmitting edited text.",
    retryable: true,
  },
};

/**
 * Submit once. Never retries automatically and never replaces the request ID
 * or epoch: a lost or failed response keeps the draft and the exact submission
 * for an explicit retry.
 */
export async function submitCaptureOnce(
  transport: CaptureTransport,
  submission: CaptureSubmissionState,
): Promise<CaptureHttpResult> {
  try {
    const response = await transport(
      "POST",
      "/capture/v1/tasks",
      captureSubmissionBody(submission),
    );
    const value = response.json as
      | CaptureAcceptedResult
      | {
          error: {
            code: string;
            message: string;
            field?: string;
            retryable: boolean;
          };
          requestId?: string;
        };
    if (
      value &&
      typeof value === "object" &&
      "error" in (value as Record<string, unknown>)
    ) {
      const failure = value as {
        error: {
          code: string;
          message: string;
          field?: string;
          retryable: boolean;
        };
        requestId?: string;
      };
      return {
        ok: false,
        status: response.status,
        error: failure.error,
        requestId: failure.requestId,
      };
    }
    return {
      ok: true,
      status: response.status,
      result: value as CaptureAcceptedResult,
    };
  } catch {
    return transportFailure;
  }
}

/** Explicit retry: the same request identity and exact normalized payload. */
export async function retryCaptureExplicitly(
  transport: CaptureTransport,
  submission: CaptureSubmissionState,
): Promise<CaptureHttpResult> {
  return submitCaptureOnce(transport, submission);
}

/** The client records the last-successful selection only after confirmed success. */
export function recordCaptureSuccess(
  context: CaptureClientContext,
  submission: CaptureSubmissionState,
): CaptureClientContext {
  return { ...context, lastSuccessfulProjectId: submission.projectId };
}

export const captureClientLimits = {
  apiVersion: CAPTURE_API_VERSION,
  bodyBytes: CAPTURE_BODY_LIMIT,
};
