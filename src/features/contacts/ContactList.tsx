import { Link } from "react-router";
import { type ContactRecord, isHttpUrl } from "../../../shared/schemas.ts";

type Props = {
  items: ContactRecord[];
  editingId: string | null;
  onEdit: (record: ContactRecord) => void;
};

/** The loaded contacts. Rendered only after a successful fetch. */
export function ContactList(props: Props) {
  return (
    <ul data-testid="contact-list" className="space-y-3">
      {props.items.length === 0 && <li className="text-ink/60">No contacts yet. Add one with the form.</li>}
      {props.items.map((c) => (
        <ContactItem key={c.id} contact={c} editing={c.id === props.editingId} onEdit={() => props.onEdit(c)} />
      ))}
    </ul>
  );
}

function ContactItem(props: { contact: ContactRecord; editing: boolean; onEdit: () => void }) {
  const c = props.contact;
  const roleLine = [c.role, c.company].filter((s): s is string => typeof s === "string" && s !== "").join(" · ");
  const applicationIds = c.application_ids ?? [];

  return (
    <li
      data-testid="contact-item"
      data-id={c.id}
      className={`rounded border p-4 ${props.editing ? "border-accent-cyan" : "border-muted/60"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-ink">
            {c.name}
            {c.relationship && (
              <span className="ml-2 rounded border border-accent-green/60 px-2 py-0.5 font-mono text-xs text-accent-green">
                {c.relationship}
              </span>
            )}
          </h3>
          {roleLine !== "" && <p className="text-sm text-ink/80">{roleLine}</p>}
        </div>
        <button
          type="button"
          data-testid="contact-edit"
          onClick={props.onEdit}
          className="rounded border border-muted px-3 py-1 font-mono text-sm text-ink/80 hover:border-accent-cyan hover:text-accent-cyan"
        >
          Edit
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {/* email is free text: only something address-like becomes a mailto link. */}
        {c.email &&
          (/^[^\s@]+@[^\s@]+$/.test(c.email) ? (
            <a href={`mailto:${c.email}`}>{c.email}</a>
          ) : (
            <span className="text-ink/80">{c.email}</span>
          ))}
        {/* Only an http(s) URL becomes a link, so a stored value can never be a javascript: href. */}
        {c.linkedin_url &&
          (isHttpUrl(c.linkedin_url) ? (
            <a href={c.linkedin_url} target="_blank" rel="noreferrer">
              LinkedIn
            </a>
          ) : (
            <span className="text-ink/60">LinkedIn: {c.linkedin_url}</span>
          ))}
        {c.last_contact_at && <span className="text-ink/60">Last contact {c.last_contact_at}</span>}
      </div>
      {c.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-ink/70">{c.notes}</p>}
      {applicationIds.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-3 font-mono text-xs">
          {applicationIds.map((id) => (
            <Link key={id} to={`/applications/${encodeURIComponent(id)}`}>
              {id}
            </Link>
          ))}
        </p>
      )}
    </li>
  );
}
