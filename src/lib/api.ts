// The JSON API client every page uses (spec B). Paths are relative to /job-tracker/api.
import { errorCodeFor } from "../../shared/errors.ts";

export const API_BASE = "/job-tracker/api";
export const LOGIN_URL = "/job-tracker/login";

/** A failed API call. `code` comes from the error envelope; `body` is the parsed response body. */
export class ApiError extends Error {
  status: number;
  code: string;
  body: unknown;

  constructor(message: string, status: number, code: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type ApiInit = { method?: string; body?: unknown; headers?: Record<string, string> };

function envelopeOf(body: unknown): { code?: unknown; message?: unknown } | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = (body as { error: unknown }).error;
  return typeof error === "object" && error !== null ? (error as { code?: unknown; message?: unknown }) : undefined;
}

function goToLogin(): void {
  if (window.location.pathname !== LOGIN_URL) window.location.assign(LOGIN_URL);
}

/**
 * Calls the API with JSON in and out and same-origin credentials. Resolves with the parsed body
 * (undefined for an empty one, such as a 204). Rejects with ApiError on a non-2xx response or a
 * network failure. On 401 it also navigates to the login page.
 */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Could not reach the server", 0, "network_error", undefined);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  let parseFailed = false;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (!res.ok) {
    if (res.status === 401) goToLogin();
    const envelope = envelopeOf(parsed);
    const code = typeof envelope?.code === "string" ? envelope.code : errorCodeFor(res.status);
    const message =
      typeof envelope?.message === "string" && envelope.message !== ""
        ? envelope.message
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, code, parseFailed ? text : parsed);
  }

  if (parseFailed) {
    throw new ApiError("The server sent a response that is not JSON", res.status, "bad_response", text);
  }
  return parsed as T;
}
