import { useEffect, useState } from "react";
import type { ContactRecord } from "../../../shared/schemas.ts";
import { ErrorBanner } from "../../components/ErrorBanner.tsx";
import { ApiError } from "../../lib/api.ts";
import { ContactForm } from "./ContactForm.tsx";
import { ContactList } from "./ContactList.tsx";
import { type ContactFormValues, createContact, listContacts, updateContact, upsertContact, valuesOf } from "./contacts-api.ts";

type Detail = { path: string; message: string };

/** Validation details from a 400 envelope, if any. */
function detailsOf(error: unknown): Detail[] {
  if (!(error instanceof ApiError) || error.status !== 400) return [];
  const details = (error.body as { error?: { details?: unknown } } | undefined)?.error?.details;
  if (!Array.isArray(details)) return [];
  return details.filter(
    (d): d is Detail => typeof d === "object" && d !== null && typeof d.path === "string" && typeof d.message === "string",
  );
}

/** The current record a 409 or 412 body carries. */
function recordOf(error: ApiError): ContactRecord | null {
  const record = (error.body as { record?: unknown } | undefined)?.record;
  return typeof record === "object" && record !== null && typeof (record as { id?: unknown }).id === "string"
    ? (record as ContactRecord)
    : null;
}

/** /contacts: the contact list and the add/edit form on one page. */
export function ContactsPage() {
  const [items, setItems] = useState<ContactRecord[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<ContactRecord | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    listContacts().then(
      (list) => {
        if (!active) return;
        setItems(list.items);
        setLoadError(null);
      },
      (error: unknown) => {
        if (!active) return;
        setItems(null);
        setLoadError(error);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const reload = () => {
    setLoadError(null);
    setReloadKey((k) => k + 1);
  };

  const startEdit = (record: ContactRecord) => {
    setEditing(record);
    setFormError(null);
    setFormKey((k) => k + 1);
  };

  const resetForm = () => {
    setEditing(null);
    setFormError(null);
    setFormKey((k) => k + 1);
  };

  const submit = async (values: ContactFormValues) => {
    // A blank name would be dropped from the PATCH body (or rejected on create), so it is
    // refused here with a clear message and nothing is sent.
    if (values.name.trim() === "") {
      setFormError(new Error("Name is required. Enter a name before saving."));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const record = editing ? await updateContact(editing, values) : await createContact(values);
      if (items === null) reload();
      else setItems(upsertContact(items, record));
      resetForm();
    } catch (error) {
      if (error instanceof ApiError && error.status === 412 && editing) {
        // Someone else changed it. Show the latest version in the list and keep the user's
        // edits in the form; saving again uses the new updated_at and overwrites deliberately.
        const current = recordOf(error);
        if (current) {
          setEditing(current);
          setItems((prev) => (prev === null ? prev : upsertContact(prev, current)));
        }
        setFormError(
          new Error(
            "This contact was changed elsewhere since you opened it. The list shows the latest version; save again to overwrite it with your edits.",
          ),
        );
      } else {
        setFormError(error);
      }
    } finally {
      setBusy(false);
    }
  };

  const details = detailsOf(formError);

  return (
    <section className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-bold text-accent-green">Contacts</h1>

      <div className="mt-6 grid gap-8 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-3 lg:sticky lg:top-6 lg:self-start">
          {formError !== null && (
            <div className="space-y-2">
              <ErrorBanner error={formError} />
              {details.length > 0 && (
                <ul className="list-inside list-disc text-sm text-red-200">
                  {details.map((d) => (
                    <li key={`${d.path}:${d.message}`}>
                      <span className="font-mono">{d.path}</span>: {d.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <ContactForm
            key={`${editing?.id ?? "new"}:${formKey}`}
            initial={editing ? valuesOf(editing) : null}
            editing={editing !== null}
            busy={busy}
            onSubmit={submit}
            onCancel={resetForm}
          />
        </div>

        <div>
          {loadError !== null ? (
            <div className="space-y-3">
              <ErrorBanner error={loadError} />
              <button
                type="button"
                onClick={reload}
                className="rounded border border-muted px-3 py-1 font-mono text-sm text-ink/80 hover:border-accent-cyan hover:text-accent-cyan"
              >
                Retry
              </button>
            </div>
          ) : items === null ? (
            <p className="text-ink/60">Loading contacts…</p>
          ) : (
            <ContactList items={items} editingId={editing?.id ?? null} onEdit={startEdit} />
          )}
        </div>
      </div>
    </section>
  );
}
