import { type FormEvent, useState } from "react";
import { RELATIONSHIPS } from "../../../shared/schemas.ts";
import { type ContactFormValues, EMPTY_VALUES, type FormField } from "./contacts-api.ts";

type Props = {
  /** Prefilled values when editing; empty when adding. */
  initial: ContactFormValues | null;
  editing: boolean;
  busy: boolean;
  onSubmit: (values: ContactFormValues) => void;
  onCancel: () => void;
};

const inputClass =
  "mt-1 w-full rounded border border-muted bg-charcoal px-3 py-2 text-ink placeholder:text-muted focus:border-accent-cyan focus:outline-none";
const labelClass = "block text-xs uppercase tracking-wide text-ink/70";

/** Add or edit a contact. Field names match the API's. */
export function ContactForm(props: Props) {
  const [values, setValues] = useState<ContactFormValues>(props.initial ?? EMPTY_VALUES);

  const set = (field: FormField) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onSubmit(values);
  };

  return (
    // noValidate: the API is the validator. Browser checks would block saving values the API
    // accepts (a free-text email, for example), and the page reports a blank name itself.
    <form data-testid="contact-form" onSubmit={submit} noValidate className="space-y-4 rounded border border-muted/60 p-5">
      <h2 className="text-lg font-bold text-accent-green">{props.editing ? "Edit contact" : "Add a contact"}</h2>

      <label className={labelClass}>
        Name
        <input name="name" required value={values.name} onChange={set("name")} className={inputClass} />
      </label>
      <label className={labelClass}>
        Company
        <input name="company" value={values.company} onChange={set("company")} className={inputClass} />
      </label>
      <label className={labelClass}>
        Role
        <input name="role" value={values.role} onChange={set("role")} className={inputClass} />
      </label>
      <label className={labelClass}>
        Relationship
        <select name="relationship" value={values.relationship} onChange={set("relationship")} className={inputClass}>
          <option value="">(none)</option>
          {RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        LinkedIn URL
        <input
          name="linkedin_url"
          type="url"
          placeholder="https://www.linkedin.com/in/..."
          value={values.linkedin_url}
          onChange={set("linkedin_url")}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Email
        <input name="email" type="text" inputMode="email" value={values.email} onChange={set("email")} className={inputClass} />
      </label>
      <label className={labelClass}>
        Last contact
        <input
          name="last_contact_at"
          type="date"
          value={values.last_contact_at}
          onChange={set("last_contact_at")}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Notes
        <textarea name="notes" rows={3} value={values.notes} onChange={set("notes")} className={inputClass} />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          data-testid="contact-submit"
          disabled={props.busy}
          className="rounded border border-accent-green px-4 py-2 font-mono text-accent-green hover:bg-accent-green hover:text-charcoal disabled:opacity-50"
        >
          {props.editing ? "Save changes" : "Add contact"}
        </button>
        {props.editing && (
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.busy}
            className="rounded border border-muted px-4 py-2 font-mono text-ink/80 hover:border-accent-cyan hover:text-accent-cyan disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
