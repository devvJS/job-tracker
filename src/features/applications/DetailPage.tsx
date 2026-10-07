import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ApplicationRecord, EventRecord } from "../../../shared/schemas.ts";
import { ErrorBanner } from "../../components/ErrorBanner.tsx";
import { ApiError } from "../../lib/api.ts";
import { ApplicationForm } from "./ApplicationForm.tsx";
import {
  type FormValues,
  deleteApplication,
  formValuesOf,
  getApplication,
  patchApplication,
  patchBody,
  recordOf,
} from "./applications-api.ts";
import { EventForm } from "./EventForm.tsx";

type Loaded = { id: string; record: ApplicationRecord | null; error: unknown };

/** Field groups in source-spec section 3 order. Any other key on the record is shown under "Other fields". */
const GROUPS: { title: string; fields: string[] }[] = [
  {
    title: "Identity and posting",
    fields: ["company", "role_title", "posting_url", "job_id", "posting_status", "posting_verified_at", "jd_snapshot_path", "jd_snapshot"],
  },
  {
    title: "Where",
    fields: ["work_arrangement", "location", "detroit_metro", "onsite_requirement", "remote_scope", "move_timing_ok"],
  },
  { title: "Compensation", fields: ["comp_min", "comp_max", "comp_source", "meets_floor", "equity_bonus_notes"] },
  { title: "Classification", fields: ["track", "company_archetype", "company_stage", "industry", "mission_interest"] },
  { title: "Fit", fields: ["fit"] },
  { title: "How it was found", fields: ["source", "source_detail", "connection", "referral", "contact_ids"] },
  {
    title: "Pipeline",
    fields: ["status", "priority", "next_action", "next_action_due", "follow_up_date", "discovered_at", "applied_at", "closed_at", "closed_reason"],
  },
  { title: "Materials", fields: ["materials"] },
  { title: "Notes", fields: ["notes", "project_thread_url"] },
  { title: "Bookkeeping", fields: ["id", "created_at", "updated_at", "updated_by"] },
];

const NOT_FIELDS = new Set(["events", "contacts"]);
const KNOWN = new Set(GROUPS.flatMap((g) => g.fields));
const URL_FIELDS = new Set(["posting_url", "project_thread_url"]);

/** /applications/:id: every field, the event timeline, logging events, editing and hard delete. */
export function DetailPage() {
  const id = useParams().id ?? "";
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The form values the open edit started from (null when the edit form is closed). The PATCH sends only
  // the fields changed from these, so a write made meanwhile (an event setting next_action, say) is not
  // reverted, and the form stays mounted across such writes, keeping what was typed. If-Match still comes
  // from the latest record.
  const [editBase, setEditBase] = useState<FormValues | null>(null);
  const editing = editBase !== null;
  const [editError, setEditError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    getApplication(id).then(
      (record) => {
        if (active) setLoaded({ id, record, error: null });
      },
      (error: unknown) => {
        if (active) setLoaded({ id, record: null, error });
      },
    );
    return () => {
      active = false;
    };
  }, [id]);

  const current = loaded?.id === id ? loaded : null;
  if (current === null) return <p className="text-ink/60">Loading…</p>;
  if (current.record === null) return <ErrorBanner error={current.error} />;
  const record = current.record;

  /** Every write returns the record; it is the new If-Match. */
  const replace = (next: ApplicationRecord) => setLoaded({ id, record: next, error: null });

  const save = async (values: FormValues) => {
    const body = patchBody(values, editBase ?? formValuesOf(record));
    if (Object.keys(body).length === 0) {
      setEditBase(null);
      return;
    }
    setBusy(true);
    setEditError(null);
    try {
      replace(await patchApplication(record, body));
      setEditBase(null);
      setConflict(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        // Refused: the record changed elsewhere. Show the latest version; the stale edit is dropped.
        setConflict(true);
        setEditBase(null);
        const latest = recordOf(err);
        if (latest) replace(latest);
        else getApplication(id).then(replace, setActionError);
      } else {
        setEditError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Permanently delete ${record.company}, ${record.role_title}? Events and contact links go too.`)) {
      return;
    }
    setActionError(null);
    try {
      await deleteApplication(record.id);
      navigate("/");
    } catch (err) {
      setActionError(err);
    }
  };

  const extraKeys = Object.keys(record).filter((k) => !KNOWN.has(k) && !NOT_FIELDS.has(k));

  return (
    <article data-testid="app-detail" data-id={record.id} className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-ink/50">
            <Link to="/">Board</Link> / {record.id}
          </p>
          <h1 className="mt-1 text-2xl font-bold text-accent-green">{record.company}</h1>
          <p className="text-lg">{record.role_title}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            data-testid="detail-status"
            className="rounded border border-accent-cyan/60 px-3 py-1 font-mono text-sm text-accent-cyan"
          >
            {record.status}
          </span>
          <button
            type="button"
            data-testid="edit-button"
            onClick={() => {
              setEditError(null);
              setEditBase(editing ? null : formValuesOf(record));
            }}
            className="rounded border border-muted px-3 py-1 font-mono text-sm hover:border-accent-green hover:text-accent-green"
          >
            {editing ? "Close edit" : "Edit"}
          </button>
          <button
            type="button"
            data-testid="delete-button"
            onClick={remove}
            className="rounded border border-red-500/60 px-3 py-1 font-mono text-sm text-red-300 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      </header>

      {conflict && (
        <div
          data-testid="conflict-banner"
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded border border-yellow-400/60 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-100"
        >
          <span>
            This application changed elsewhere after you opened it, so your edit was not saved. The latest version is
            shown below; make the edit again if it still applies.
          </span>
          <button type="button" onClick={() => setConflict(false)} className="font-mono text-xs underline">
            Dismiss
          </button>
        </div>
      )}

      <ErrorBanner error={actionError} />

      {editBase !== null && (
        <ApplicationForm
          title="Edit application"
          initial={editBase}
          submitLabel="Save"
          busy={busy}
          error={editError}
          onSubmit={save}
          onCancel={() => setEditBase(null)}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <FieldGroup key={group.title} title={group.title} fields={group.fields} record={record} />
          ))}
          {extraKeys.length > 0 && <FieldGroup title="Other fields" fields={extraKeys} record={record} />}
        </div>

        <div className="space-y-4">
          <EventForm
            applicationId={record.id}
            currentStatus={record.status}
            onLogged={(res) => replace(res.record)}
          />
          <Timeline events={record.events ?? []} />
        </div>
      </div>
    </article>
  );
}

function FieldGroup(props: { title: string; fields: string[]; record: ApplicationRecord }) {
  return (
    <section className="rounded border border-muted/60">
      <h2 className="border-b border-muted/60 px-4 py-2 text-xs uppercase tracking-wide text-accent-cyan">{props.title}</h2>
      <dl className="divide-y divide-muted/30">
        {props.fields.map((field) => (
          <div key={field} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-3 px-4 py-2 text-sm">
            <dt className="font-mono text-xs text-ink/60">{field}</dt>
            <dd data-testid={`detail-field-${field}`} className="min-w-0 break-words">
              <FieldValue field={field} record={props.record} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function FieldValue({ field, record }: { field: string; record: ApplicationRecord }) {
  const value = record[field];
  if (field === "contact_ids") {
    const linked = record.contacts ?? [];
    if (linked.length === 0) return <Empty />;
    return (
      <ul>
        {linked.map((c) => (
          <li key={c.id}>
            <Link to="/contacts">{c.name}</Link>
            {c.company ? <span className="text-ink/60"> · {c.company}</span> : null}
            {c.relationship ? <span className="text-ink/60"> · {c.relationship}</span> : null}
          </li>
        ))}
      </ul>
    );
  }
  if (URL_FIELDS.has(field) && typeof value === "string") {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="break-all">
        {value}
      </a>
    );
  }
  if (field === "jd_snapshot" && typeof value === "string") {
    return <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-sans text-xs">{value}</pre>;
  }
  return <Value value={value} />;
}

function Empty() {
  return <span className="text-ink/40">—</span>;
}

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <Empty />;
  if (typeof value === "boolean") return <>{value ? "yes" : "no"}</>;
  if (typeof value === "number") return <>{Number.isInteger(value) && Math.abs(value) >= 1000 ? value.toLocaleString("en-US") : value}</>;
  if (typeof value === "string") return <span className="whitespace-pre-wrap">{value}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty />;
    if (value.every((v) => typeof v !== "object" || v === null)) return <>{value.map(String).join(", ")}</>;
    return (
      <ul className="space-y-1">
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <Empty />;
    return (
      <dl className="space-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="font-mono text-xs text-ink/60">{k}:</dt>
            <dd className="min-w-0">
              <Value value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <>{String(value)}</>;
}

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function Timeline({ events }: { events: EventRecord[] }) {
  // The API returns events oldest first; the timeline shows the newest first.
  const newestFirst = [...events].reverse();
  return (
    <section className="rounded border border-muted/60">
      <h2 className="border-b border-muted/60 px-4 py-2 text-xs uppercase tracking-wide text-accent-cyan">Timeline</h2>
      <ol data-testid="event-list" className="divide-y divide-muted/30">
        {newestFirst.map((e) => (
          <li key={e.id} data-testid="event-item" data-type={e.type} className="px-4 py-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-bold text-accent-green">{e.type}</span>
              <time dateTime={e.at} className="font-mono text-xs text-ink/50">
                {when.format(new Date(e.at))} · {e.by}
              </time>
            </div>
            {e.note && <p className="mt-1 whitespace-pre-wrap text-ink/90">{e.note}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
