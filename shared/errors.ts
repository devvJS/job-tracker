// The API error envelope (spec D), shared by the server and the UI.

export const ERROR_CODES = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  412: "precondition_failed",
  415: "unsupported_media_type",
  428: "precondition_required",
  429: "rate_limited",
  500: "internal",
} as const;

export type ErrorStatus = keyof typeof ERROR_CODES;
export type ErrorCode = (typeof ERROR_CODES)[ErrorStatus];

/** One validation problem: `path` is dotted, e.g. "fit.total". */
export type ErrorDetail = { path: string; message: string };

export type ErrorEnvelope = {
  error: { code: string; message: string; details?: unknown };
  /** 409 and 412 carry the full current record. */
  record?: unknown;
};

export function errorEnvelope(code: string, message: string, details?: unknown): ErrorEnvelope {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

/** The envelope code for an HTTP status; unknown 4xx map to bad_request, everything else to internal. */
export function errorCodeFor(status: number): string {
  if (status in ERROR_CODES) return ERROR_CODES[status as ErrorStatus];
  return status >= 400 && status < 500 ? "bad_request" : "internal";
}
