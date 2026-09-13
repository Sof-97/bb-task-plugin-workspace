import { createHash } from "node:crypto";
import { canonicalJson } from "./archive";

/**
 * Pure contract pieces of the versioned quick-capture HTTP interface
 * (`capture/v1/*`): payload validation, canonical dedup hashing, creation
 * receipts and bounded body reading. Route orchestration lives in server.ts.
 */

export const CAPTURE_API_VERSION = 1;
export const CAPTURE_BODY_LIMIT = 80 * 1024;
export const CAPTURE_TITLE_LIMIT = 300;
export const CAPTURE_DESCRIPTION_LIMIT = 64 * 1024;

/** Stable error codes carried by every plugin-shaped capture failure. */
export type CaptureErrorCode =
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_ID_CONFLICT"
  | "DATASET_CHANGED"
  | "PROJECT_NOT_ENROLLED"
  | "PROJECT_UNAVAILABLE"
  | "CAPTURE_PENDING"
  | "STORAGE_UNAVAILABLE"
  | "RECOVERY_REQUIRED"
  | "UNAUTHORIZED";

export class CaptureHttpError extends Error {
  readonly code: CaptureErrorCode;
  readonly httpStatus: CaptureHttpStatus;
  readonly field: string | null;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(
    code: CaptureErrorCode,
    httpStatus: CaptureHttpStatus,
    message: string,
    options: {
      field?: string | null;
      retryable?: boolean;
      requestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "CaptureHttpError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.field = options.field ?? null;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId ?? null;
  }
}

export const CAPTURE_REQUEST_STATE = {
  allocated: "allocated",
  accepted: "accepted",
  recoveryRequired: "recovery-required",
} as const;
export type CaptureRequestState =
  (typeof CAPTURE_REQUEST_STATE)[keyof typeof CAPTURE_REQUEST_STATE];

/** HTTP statuses the capture interface uses for shaped JSON errors. */
export type CaptureHttpStatus = 400 | 401 | 409 | 413 | 503;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEWLINE = /[\n\r\u2028\u2029\u0085]/;
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export type CaptureSubmission = {
  requestId: string;
  datasetEpoch: string;
  projectId: string;
  title: string;
  description: string;
};

function failure(
  requestId: string | null,
  code: CaptureErrorCode,
  status: CaptureHttpStatus,
  message: string,
  field?: string,
  retryable = false,
): never {
  throw new CaptureHttpError(code, status, message, {
    field: field ?? null,
    retryable,
    requestId,
  });
}

/**
 * Validate and normalize one capture submission. Unknown fields, wrong types
 * and oversized or unusable values fail before any task is allocated. Diagnostics
 * never echo submitted content or the token.
 */
export function parseCaptureSubmission(value: unknown): CaptureSubmission {
  if (!plainObject(value))
    failure(null, "VALIDATION_ERROR", 400, "Body must be a JSON object.");
  const record = value;
  const rawRequestId = record.requestId;
  const validRequestId =
    typeof rawRequestId === "string" && UUID.test(rawRequestId)
      ? rawRequestId
      : null;
  if (!validRequestId)
    failure(
      null,
      "VALIDATION_ERROR",
      400,
      "requestId must be a client-generated UUID.",
      "requestId",
    );
  const allowed = [
    "requestId",
    "datasetEpoch",
    "projectId",
    "title",
    "description",
  ];
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      failure(
        validRequestId,
        "VALIDATION_ERROR",
        400,
        "Unknown field in capture submission.",
        key,
      );
  const datasetEpoch = record.datasetEpoch;
  if (typeof datasetEpoch !== "string" || !UUID.test(datasetEpoch))
    failure(
      validRequestId,
      "VALIDATION_ERROR",
      400,
      "datasetEpoch must be a UUID.",
      "datasetEpoch",
    );
  const projectId = record.projectId;
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    projectId.length > 200
  )
    failure(
      validRequestId,
      "VALIDATION_ERROR",
      400,
      "projectId must be a nonempty string.",
      "projectId",
    );
  const rawTitle = record.title;
  if (typeof rawTitle !== "string")
    failure(
      validRequestId,
      "VALIDATION_ERROR",
      400,
      "title must be a string.",
      "title",
    );
  const title = rawTitle.trim();
  if (title.length === 0)
    failure(
      validRequestId,
      "VALIDATION_ERROR",
      400,
      "Title must not be empty.",
      "title",
    );
  if (NEWLINE.test(title))
    failure(
      validRequestId,
      "VALIDATION_ERROR",
      400,
      "Title must be a single line.",
      "title",
    );
  if ([...title].length > CAPTURE_TITLE_LIMIT)
    failure(
      validRequestId,
      "VALIDATION_ERROR",
      400,
      `Title exceeds ${CAPTURE_TITLE_LIMIT} Unicode code points.`,
      "title",
    );
  let description: string;
  if (record.description === undefined) {
    description = "";
  } else {
    const rawDescription = record.description;
    if (typeof rawDescription !== "string")
      failure(
        validRequestId,
        "VALIDATION_ERROR",
        400,
        "description must be a string.",
        "description",
      );
    description = rawDescription;
    if (Buffer.byteLength(description, "utf8") > CAPTURE_DESCRIPTION_LIMIT)
      failure(
        validRequestId,
        "VALIDATION_ERROR",
        400,
        `Description exceeds ${CAPTURE_DESCRIPTION_LIMIT} UTF-8 bytes.`,
        "description",
      );
  }
  return {
    requestId: validRequestId,
    datasetEpoch,
    projectId,
    title,
    description,
  };
}

/** Fixed-field canonical encoding: JSON property order never affects equality. */
export function canonicalCapturePayload(submission: {
  projectId: string;
  title: string;
  description: string;
}): string {
  return canonicalJson({
    projectId: submission.projectId,
    title: submission.title,
    description: submission.description,
  });
}

export function capturePayloadHash(submission: {
  projectId: string;
  title: string;
  description: string;
}): string {
  return createHash("sha256")
    .update(Buffer.from(canonicalCapturePayload(submission), "utf8"))
    .digest("hex");
}

export type CaptureReceipt = {
  taskUuid: string;
  displayId: string;
  projectId: string;
  status: "Inbox";
  createdAt: string;
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Strict receipt parse for durable records; null means unusable record data. */
export function parseCaptureReceipt(value: unknown): CaptureReceipt | null {
  if (!plainObject(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.taskUuid !== "string" ||
    !UUID.test(receipt.taskUuid) ||
    typeof receipt.displayId !== "string" ||
    receipt.displayId.length === 0 ||
    receipt.displayId.length > 64 ||
    typeof receipt.projectId !== "string" ||
    receipt.projectId.length === 0 ||
    receipt.projectId.length > 200 ||
    receipt.status !== "Inbox" ||
    typeof receipt.createdAt !== "string" ||
    !INSTANT.test(receipt.createdAt)
  )
    return null;
  return {
    taskUuid: receipt.taskUuid,
    displayId: receipt.displayId,
    projectId: receipt.projectId,
    status: "Inbox",
    createdAt: receipt.createdAt,
  };
}

export type CaptureProjectsResult = {
  apiVersion: 1;
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

export type CaptureAcceptedResult = {
  apiVersion: 1;
  datasetEpoch: string;
  requestId: string;
  replayed: boolean;
  receipt: CaptureReceipt;
};

/** Bounded request-body read: whole body must fit before any parsing. */
export async function readCaptureBody(
  request: Request,
  limit = CAPTURE_BODY_LIMIT,
): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size >= 0 && size > limit)
      return { ok: false };
  }
  if (!request.body) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, bytes: Buffer.concat(chunks, total) };
}

/** Parse one bounded body into a submission, throwing shaped HTTP errors. */
export async function readCaptureSubmission(
  request: Request,
): Promise<CaptureSubmission> {
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (contentType !== "application/json")
    failure(
      null,
      "VALIDATION_ERROR",
      400,
      "Capture submissions must use the application/json content type.",
      "content-type",
    );
  const body = await readCaptureBody(request);
  if (!body.ok)
    failure(
      null,
      "PAYLOAD_TOO_LARGE",
      413,
      `Capture body exceeds the ${CAPTURE_BODY_LIMIT} byte limit; it was not truncated.`,
    );
  const bytes: Buffer = body.ok ? body.bytes : Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    failure(
      null,
      "VALIDATION_ERROR",
      400,
      "Capture body must be valid UTF-8 JSON.",
    );
  }
  return parseCaptureSubmission(parsed);
}

/** One plugin-shaped JSON error envelope; never carries tokens or submitted content. */
export function captureErrorBody(error: CaptureHttpError): {
  error: {
    code: CaptureErrorCode;
    message: string;
    field?: string;
    retryable: boolean;
  };
  requestId?: string;
} {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
      retryable: error.retryable,
    },
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}
/** Stable HTTP status for each capture error code. */
export function captureErrorStatus(
  code: CaptureErrorCode,
): 400 | 401 | 409 | 413 | 503 {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "REQUEST_ID_CONFLICT":
    case "DATASET_CHANGED":
    case "PROJECT_NOT_ENROLLED":
    case "PROJECT_UNAVAILABLE":
    case "RECOVERY_REQUIRED":
      return 409;
    case "CAPTURE_PENDING":
    case "STORAGE_UNAVAILABLE":
      return 503;
    case "UNAUTHORIZED":
      return 401;
  }
}
