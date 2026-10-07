import { type FormEvent, useState } from "react";
import { CLIENT_EVENT_TYPES, STATUSES } from "../../../shared/schemas.ts";
import { ErrorBanner } from "../../components/ErrorBanner.tsx";
import { inputClass, labelClass } from "./ApplicationForm.tsx";
import { type EventResponse, detailsOf, postEvent } from "./applications-api.ts";

type Values = { type: string; note: string; status: string; next_action: string; next_action_due: string };

const EMPTY: Values = { type: "note", note: "", status: "", next_action: "", next_action_due: "" };

/**
 * Logs an event, optionally moving the status and setting the next action.
 * Empty optional fields are left out, so they leave the record unchanged.
 */
export function EventForm(props: { applicationId: string; currentStatus: string; onLogged: (res: EventResponse) => void }) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const details = detailsOf(error);

  const set = (field: keyof Values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { type: values.type };
    if (values.note.trim() !== "") body.note = values.note.trim();
    if (values.status !== "") body.status = values.status;
    if (values.next_action.trim() !== "") body.next_action = values.next_action.trim();
    if (values.next_action_due !== "") body.next_action_due = values.next_action_due;
    setBusy(true);
    setError(null);
    try {
      const res = await postEvent(props.applicationId, body);
      setValues(EMPTY);
      props.onLogged(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form data-testid="event-form" onSubmit={submit} className="space-y-3 rounded border border-muted/60 p-4">
      <h3 className="text-sm font-bold text-accent-green">Log an event</h3>
      <ErrorBanner error={error} />
      {details.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-red-200">
          {details.map((d) => (
            <li key={`${d.path}:${d.message}`}>
              <span className="font-mono">{d.path}</span>: {d.message}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Type
          <select name="type" value={values.type} onChange={set("type")} className={inputClass}>
            {CLIENT_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Move status to
          <select name="status" value={values.status} onChange={set("status")} className={inputClass}>
            <option value="">(no change: {props.currentStatus})</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Next action
          <input name="next_action" value={values.next_action} onChange={set("next_action")} className={inputClass} />
        </label>
        <label className={labelClass}>
          Next action due
          <input
            name="next_action_due"
            type="date"
            value={values.next_action_due}
            onChange={set("next_action_due")}
            className={inputClass}
          />
        </label>
      </div>
      <label className={labelClass}>
        Note
        <textarea name="note" rows={3} value={values.note} onChange={set("note")} className={inputClass} />
      </label>
      <button
        type="submit"
        data-testid="event-submit"
        disabled={busy}
        className="rounded bg-accent-cyan px-4 py-2 font-mono text-sm font-bold text-charcoal hover:bg-accent-green disabled:opacity-50"
      >
        {busy ? "Logging…" : "Log event"}
      </button>
    </form>
  );
}
