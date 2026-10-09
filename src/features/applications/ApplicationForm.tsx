import { type FormEvent, type ReactNode, useState } from "react";
import { PRIORITIES, SOURCES, STATUSES, TRACKS, WORK_ARRANGEMENTS } from "../../../shared/schemas.ts";
import { errorMessage } from "../../components/ErrorBanner.tsx";
import { type FormField, type FormValues, detailsOf } from "./applications-api.ts";

type Props = {
  title: string;
  initial: FormValues;
  submitLabel: string;
  busy: boolean;
  /** The last failed submit, shown as form-error (with field details for a 400). */
  error: unknown;
  /** Extra content inside form-error, e.g. a link to the record a 409 names. */
  errorExtra?: ReactNode;
  onSubmit: (values: FormValues) => void;
  onCancel?: () => void;
};

export const inputClass =
  "mt-1 w-full rounded border border-muted bg-charcoal px-3 py-2 font-sans text-sm normal-case tracking-normal text-ink placeholder:text-muted focus:border-accent-cyan focus:outline-none";
export const labelClass = "block text-xs uppercase tracking-wide text-ink/70";

/** Create or edit an application. Field names match the API's (spec H). */
export function ApplicationForm(props: Props) {
  const [values, setValues] = useState<FormValues>(props.initial);
  const details = detailsOf(props.error);

  const set = (field: FormField) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onSubmit(values);
  };

  const text = (field: FormField, label: string, opts: { required?: boolean; type?: string; placeholder?: string } = {}) => (
    <label className={labelClass}>
      {label}
      <input
        name={field}
        type={opts.type ?? "text"}
        required={opts.required}
        placeholder={opts.placeholder}
        value={values[field]}
        onChange={set(field)}
        className={inputClass}
      />
    </label>
  );

  const select = (field: FormField, label: string, options: readonly string[], required = false) => (
    <label className={labelClass}>
      {label}
      <select name={field} required={required} value={values[field]} onChange={set(field)} className={inputClass}>
        {!required && <option value="">(none)</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form data-testid="app-form" onSubmit={submit} noValidate className="space-y-5 rounded border border-muted/60 p-5">
      <h2 className="text-lg font-bold text-accent-green">{props.title}</h2>

      {props.error !== null && props.error !== undefined && (
        <div
          data-testid="form-error"
          role="alert"
          className="rounded border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          <p>{errorMessage(props.error)}</p>
          {details.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {details.map((d) => (
                <li key={`${d.path}:${d.message}`}>
                  <span className="font-mono">{d.path}</span>: {d.message}
                </li>
              ))}
            </ul>
          )}
          {props.errorExtra}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {text("company", "Company", { required: true })}
        {text("role_title", "Role title", { required: true })}
        {select("work_arrangement", "Work arrangement", WORK_ARRANGEMENTS, true)}
        {select("status", "Status", STATUSES, true)}
        {text("posting_url", "Posting URL", { type: "url", placeholder: "https://" })}
        {text("location", "Location", { placeholder: "Dearborn, MI" })}
        {text("comp_min", "Comp min (USD/yr)", { type: "number" })}
        {text("comp_max", "Comp max (USD/yr)", { type: "number" })}
        {select("track", "Track", TRACKS)}
        {select("source", "Source", SOURCES)}
        {select("priority", "Priority", PRIORITIES)}
        {text("next_action", "Next action")}
        {text("next_action_due", "Next action due", { type: "date" })}
        {text("follow_up_date", "Follow-up date", { type: "date" })}
      </div>

      <label className={labelClass}>
        Notes
        <textarea name="notes" rows={4} value={values.notes} onChange={set("notes")} className={inputClass} />
      </label>

      <div className="flex gap-3">
        <button
          type="submit"
          data-testid="app-form-submit"
          disabled={props.busy}
          className="rounded bg-accent-green px-4 py-2 font-mono text-sm font-bold text-charcoal hover:bg-accent-cyan disabled:opacity-50"
        >
          {props.busy ? "Saving…" : props.submitLabel}
        </button>
        {props.onCancel && (
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded border border-muted px-4 py-2 font-mono text-sm text-ink/80 hover:text-accent-cyan"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
