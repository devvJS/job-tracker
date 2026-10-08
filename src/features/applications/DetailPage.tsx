import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ApplicationRecord, EventRecord } from "../../../shared/schemas.ts";
import { ErrorBanner } from "../../components/ErrorBanner.tsx";
import { ApiError } from "../../lib/api.ts";
import { isNewer, useRefetchOnVisible, useSyncMessages } from "../../lib/record-sync.ts";
import { StaleBanner } from "../../lib/StaleBanner.tsx";
import { ApplicationForm } from "./ApplicationForm.tsx";
import {
  type FormValues,
  deleteApplication,
  formValuesOf,
  getApplication,
  patchApplication,
  patchBody,
  postEvent,
  recordOf,
} from "./applications-api.ts";
import { EventForm } from "./EventForm.tsx";

/**
 * The page's record and edit state, for one id. `record` is what the page shows and the
 * If-Match source. `editBase` holds the form values the open edit started from (null when
 * the form is closed): the PATCH sends only fields changed from these, so the form stays
 * mounted, keeping what was typed, across this tab's own writes. `editBaseUpdatedAt` is the
 * record's updated_at when the edit started. `stale` means another tab or the agent changed the
 * record while the form is open (spec I); a stale form's save sends If-Match = editBaseUpdatedAt,
 * so it is refused (412) even if this tab's own event has since refreshed `record`.
 */
type DetailState = {
  id: string;
  record: ApplicationRecord | null;
  loadError: unknown;
  deleted: boolean;
  editBase: FormValues | null;
  editBaseUpdatedAt: string | null;
  stale: boolean;
};

type DetailAction =
  /** First load for an id (success or failure): a fresh state. */
  | { type: "loaded"; id: string; record: ApplicationRecord }
  | { type: "loadFailed"; id: string; error: unknown }
  /** This tab's own write returned the record: take it (the new If-Match), keep any open form. */
  | { type: "own"; id: string; record: ApplicationRecord }
  /** A background refetch: newer replaces silently, or marks an open form stale. */
  | { type: "remote"; id: string; record: ApplicationRecord }
  /**
   * Someone else's change landed while this tab's own write was in flight, and the own write's
   * result (already applied) includes it: nothing to show, but an open form is now stale.
   */
  | { type: "remoteSeen"; id: string }
  /** The latest record on purpose (stale-reload, or a 412 body): replace it and close the form. */
  | { type: "latest"; id: string; record: ApplicationRecord }
  | { type: "edit"; id: string; base: FormValues | null }
  | { type: "deleted"; id: string };

const fresh = (id: string, record: ApplicationRecord | null, loadError: unknown): DetailState => ({
  id,
  record,
  loadError,
  deleted: false,
  editBase: null,
  editBaseUpdatedAt: null,
  stale: false,
});

function detailReducer(state: DetailState, action: DetailAction): DetailState {
  if (action.type === "loaded") return fresh(action.id, action.record, null);
  if (action.type === "loadFailed") return fresh(action.id, null, action.error);
  if (action.id !== state.id) return state;
  switch (action.type) {
    case "own":
      return { ...state, record: action.record };
    case "remote":
      // No record yet (the first load failed), or it was deleted and the id now exists again: start over.
      if (state.record === null || state.deleted) return fresh(action.id, action.record, null);
      if (!isNewer(action.record.updated_at, state.record.updated_at)) return state;
      return state.editBase !== null ? { ...state, stale: true } : { ...state, record: action.record, stale: false };
    case "remoteSeen":
      return state.editBase !== null ? { ...state, stale: true } : state;
    case "latest":
      return { ...state, record: action.record, editBase: null, editBaseUpdatedAt: null, stale: false };
    case "edit":
      return action.base === null
        ? { ...state, editBase: null, editBaseUpdatedAt: null, stale: false }
        : { ...state, editBase: action.base, editBaseUpdatedAt: state.record?.updated_at ?? null };
    case "deleted":
      return state.record === null ? state : { ...state, deleted: true, editBase: null, stale: false };
  }
}

const DELETED_ELSEWHERE = new Error("This application was deleted in another tab or by your agent.");

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

/** /applications/:id: every field, the event timeline, logging events, editing and hard delete. Live-synced (spec I). */
export function DetailPage() {
  const id = useParams().id ?? "";
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(detailReducer, fresh("", null, null));
  const [editError, setEditError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  // This tab's writes in flight. A background refetch that lands during one is not applied at
  // once: it may carry the write's own result before the write returns (not someone else's
  // change), or someone else's change that the write's result will then include. It is buffered
  // and reconciled once the last own write has returned (see reconcile).
  const ownWrites = useRef(0);
  const buffered = useRef<ApplicationRecord | null>(null);
  /** updated_at values this tab's own writes produced, for this id. */
  const ownVersions = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    buffered.current = null;
    ownVersions.current.clear();
    getApplication(id).then(
      (record) => {
        if (active) dispatch({ type: "loaded", id, record });
      },
      (error: unknown) => {
        if (active) dispatch({ type: "loadFailed", id, error });
      },
    );
    return () => {
      active = false;
    };
  }, [id]);

  const current = state.id === id ? state : null;

  /** Silent background refetch: another tab's message, or the tab becoming visible. */
  const refetch = () => {
    const forId = id;
    getApplication(forId).then(
      (record) => {
        if (ownWrites.current === 0) dispatch({ type: "remote", id: forId, record });
        else if (buffered.current === null || isNewer(record.updated_at, buffered.current.updated_at)) {
          buffered.current = record;
        }
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 404) dispatch({ type: "deleted", id: forId });
        else setActionError(error);
      },
    );
  };

  useSyncMessages("application", (message) => {
    if (message.id !== id) return;
    if (message.updated_at === null) dispatch({ type: "deleted", id });
    else if (current?.record && isNewer(message.updated_at, current.record.updated_at)) refetch();
  });
  useRefetchOnVisible(refetch);

  if (current === null) return <p className="text-ink/60">Loading…</p>;
  if (current.record === null) return <ErrorBanner error={current.loadError} />;
  if (current.deleted) {
    return (
      <section className="mx-auto max-w-5xl space-y-4">
        <ErrorBanner error={DELETED_ELSEWHERE} />
        <Link to="/" className="font-mono text-sm">
          Back to the board
        </Link>
      </section>
    );
  }
  const record = current.record;
  const editBase = current.editBase;
  const editing = editBase !== null;

  /**
   * After the last in-flight own write has returned and its result is applied (`result`, or null
   * if it failed): settles a refetch buffered meanwhile. One of this tab's own versions is
   * ignored. Someone else's version that the result already includes (not newer than it) leaves
   * the record alone but marks an open form stale. Anything else goes through `remote`.
   */
  function reconcile(result: ApplicationRecord | null) {
    if (ownWrites.current > 0) return;
    const pending = buffered.current;
    buffered.current = null;
    if (pending === null || ownVersions.current.has(pending.updated_at)) return;
    if (result !== null && !isNewer(pending.updated_at, result.updated_at)) dispatch({ type: "remoteSeen", id });
    else dispatch({ type: "remote", id, record: pending });
  }

  /** Runs one of this tab's writes: `apply` dispatches its result, then buffered refetches are reconciled. */
  async function own<T>(
    write: () => Promise<T>,
    resultOf: (value: T) => ApplicationRecord | null,
    apply: (value: T) => void,
  ): Promise<T> {
    ownWrites.current += 1;
    let value: T;
    try {
      value = await write();
    } catch (err) {
      ownWrites.current -= 1;
      reconcile(null);
      throw err;
    }
    ownWrites.current -= 1;
    const result = resultOf(value);
    if (result !== null) ownVersions.current.add(result.updated_at);
    apply(value);
    reconcile(result);
    return value;
  }

  const closeEdit = () => {
    const wasStale = current.stale;
    dispatch({ type: "edit", id, base: null });
    // The page kept the old version while the form was open; show the latest now.
    if (wasStale) refetch();
  };

  const reloadLatest = () => {
    setEditError(null);
    getApplication(id).then(
      (latest) => dispatch({ type: "latest", id, record: latest }),
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 404) dispatch({ type: "deleted", id });
        else setActionError(error);
      },
    );
  };

  const save = async (values: FormValues) => {
    const body = patchBody(values, editBase ?? formValuesOf(record));
    if (Object.keys(body).length === 0) {
      closeEdit();
      return;
    }
    setBusy(true);
    setEditError(null);
    try {
      // If-Match: the latest version this tab knows, unless the form is stale; then the version the
      // edit started from, so the server refuses it even if an own event has refreshed `record`.
      const ifMatch = current.stale && current.editBaseUpdatedAt !== null ? current.editBaseUpdatedAt : record.updated_at;
      await own(
        () => patchApplication(id, ifMatch, body),
        (updated) => updated,
        (updated) => dispatch({ type: "latest", id, record: updated }),
      );
      setConflict(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        // Refused: the record changed elsewhere. Show the latest version; the stale edit is dropped.
        setConflict(true);
        const latest = recordOf(err);
        if (latest) dispatch({ type: "latest", id, record: latest });
        else {
          dispatch({ type: "edit", id, base: null });
          refetch();
        }
      } else {
        setEditError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const logEvent = async (body: Record<string, unknown>) => {
    await own(
      () => postEvent(id, body),
      (res) => res.record,
      (res) => dispatch({ type: "own", id, record: res.record }),
    );
  };

  const remove = async () => {
    if (!window.confirm(`Permanently delete ${record.company}, ${record.role_title}? Events and contact links go too.`)) {
      return;
    }
    setActionError(null);
    try {
      await own(
        () => deleteApplication(record.id),
        () => null,
        () => navigate("/"),
      );
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
              if (editing) closeEdit();
              else dispatch({ type: "edit", id, base: formValuesOf(record) });
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

      {current.stale && <StaleBanner onReload={reloadLatest} />}

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
          onCancel={closeEdit}
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
          <EventForm currentStatus={record.status} onSubmit={logEvent} />
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
