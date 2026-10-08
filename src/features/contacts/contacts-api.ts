// Contacts API calls for the UI, through the shared api() client.
import type { ContactRecord } from "../../../shared/schemas.ts";
import { api } from "../../lib/api.ts";
import { publishRecord } from "../../lib/record-sync.ts";

export type ContactList = { items: ContactRecord[]; count: number };

/** The writable fields the form edits, as the API names them. */
export const FORM_FIELDS = ["name", "company", "role", "relationship", "linkedin_url", "email", "last_contact_at", "notes"] as const;
export type FormField = (typeof FORM_FIELDS)[number];
export type ContactFormValues = Record<FormField, string>;

export const EMPTY_VALUES: ContactFormValues = {
  name: "",
  company: "",
  role: "",
  relationship: "",
  linkedin_url: "",
  email: "",
  last_contact_at: "",
  notes: "",
};

export function valuesOf(record: ContactRecord): ContactFormValues {
  const values = { ...EMPTY_VALUES };
  for (const field of FORM_FIELDS) {
    const v = record[field];
    values[field] = typeof v === "string" ? v : "";
  }
  return values;
}

/**
 * The request body for the form's values. Text is trimmed. On create, empty
 * fields are left out; on edit they are sent as null, which clears them.
 */
export function bodyOf(values: ContactFormValues, mode: "create" | "edit"): Record<string, string | null> {
  const body: Record<string, string | null> = {};
  for (const field of FORM_FIELDS) {
    const v = values[field].trim();
    if (v !== "") body[field] = v;
    else if (mode === "edit" && field !== "name") body[field] = null;
  }
  return body;
}

export function listContacts(): Promise<ContactList> {
  return api<ContactList>("/contacts");
}

// Every successful write is announced to the other tabs (spec I).

export async function createContact(values: ContactFormValues): Promise<ContactRecord> {
  const record = await api<ContactRecord>("/contacts", { method: "POST", body: bodyOf(values, "create") });
  publishRecord("contact", record);
  return record;
}

/** PATCHes with the record's updated_at as If-Match, exactly as the API returned it. */
export async function updateContact(record: ContactRecord, values: ContactFormValues): Promise<ContactRecord> {
  const updated = await api<ContactRecord>(`/contacts/${encodeURIComponent(record.id)}`, {
    method: "PATCH",
    body: bodyOf(values, "edit"),
    headers: { "If-Match": record.updated_at },
  });
  publishRecord("contact", updated);
  return updated;
}

/** Sorted like the API sorts: by name (case-insensitive), then name, then id. */
export function sortContacts(items: ContactRecord[]): ContactRecord[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...items].sort(
    (a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.name, b.name) || cmp(a.id, b.id),
  );
}

/** Replaces the record with the same id, or adds it, keeping the list sorted. */
export function upsertContact(items: ContactRecord[], record: ContactRecord): ContactRecord[] {
  return sortContacts([...items.filter((c) => c.id !== record.id), record]);
}
