// Request-body handling for contacts (spec D, input rules): JSON object
// parsing, splitting into known fields and extra, and Zod issue mapping.
import type { z } from "zod";
import type { ErrorDetail } from "../../../shared/errors.ts";
import { SERVER_MANAGED_KEYS } from "../../records.ts";

/** Contact fields a client may write. Everything else is server-managed or goes to `extra`. */
export const CONTACT_WRITABLE_FIELDS = [
  "name",
  "company",
  "role",
  "relationship",
  "linkedin_url",
  "email",
  "last_contact_at",
  "notes",
] as const;

const writable = new Set<string>(CONTACT_WRITABLE_FIELDS);
const serverManaged = new Set<string>(SERVER_MANAGED_KEYS);

/** Splits a contact body: recognized writable fields, unknown keys (for `extra`); server-managed keys are dropped. */
export function splitContactInput(input: Record<string, unknown>): {
  known: Record<string, unknown>;
  extra: Record<string, unknown>;
} {
  const known: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (serverManaged.has(key)) continue;
    if (writable.has(key)) known[key] = value;
    else extra[key] = value;
  }
  return { known, extra };
}

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** Parses a request body that must be a JSON object (not an array, null or a scalar). */
export function parseObjectBody(text: string): BodyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "Request body must be valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Zod issues as envelope details: `[{ path: "linkedin_url", message }]`. */
export function issueDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}
