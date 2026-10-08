import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ErrorBanner } from "../../components/ErrorBanner.tsx";
import { useLiveList } from "../../lib/record-sync.ts";
import { type DueItem, type DueResponse, dueQuery, getDue, localToday } from "./views-api.ts";

type Loaded = { query: string; data: DueResponse | null; error: unknown };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** /due: open applications whose next action or follow-up is due on or before the chosen date. */
export function DuePage() {
  // null = the server's default date (today in the tracker's timezone).
  const [date, setDate] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const query = dueQuery(date);
  // Changes to refetch silently: another tab's application write, or the tab becoming visible (spec I).
  const refreshKey = useLiveList("application");

  useEffect(() => {
    let active = true;
    getDue(query).then(
      (data) => {
        if (active) setLoaded({ query, data, error: null });
      },
      (error: unknown) => {
        if (active) setLoaded({ query, data: null, error });
      },
    );
    return () => {
      active = false;
    };
  }, [query, refreshKey]);

  // Only the result for the date currently asked for is shown.
  const current = loaded !== null && loaded.query === query ? loaded : null;
  const shownDate = date ?? current?.data?.date ?? localToday();

  const onDateChange = (value: string) => {
    // A cleared input goes back to today; a partial value is not a date yet.
    if (value === "") setDate(null);
    else if (DATE_RE.test(value)) setDate(value);
  };

  return (
    <section className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-bold text-accent-green">Due</h1>
        <label className="flex items-center gap-2 font-mono text-xs text-ink/80">
          Due on or before
          <input
            data-testid="due-date"
            type="date"
            value={shownDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="rounded border border-muted bg-charcoal px-3 py-1.5 text-sm text-ink focus:border-accent-cyan focus:outline-none [color-scheme:dark]"
          />
        </label>
      </div>

      {current === null && <p className="text-ink/60">Loading…</p>}

      {current?.error != null && <ErrorBanner error={current.error} />}

      {current?.data && (
        <>
          {current.data.items.length === 0 && (
            <p data-testid="due-empty" className="rounded border border-dashed border-muted p-6 text-center text-ink/70">
              Nothing due on or before {current.data.date}.
            </p>
          )}
          <ul data-testid="due-list" className="space-y-2">
            {current.data.items.map((item) => (
              <li key={item.id}>
                <DueRow item={item} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function DueRow({ item }: { item: DueItem }) {
  return (
    <Link
      to={`/applications/${encodeURIComponent(item.id)}`}
      data-testid="due-item"
      data-id={item.id}
      data-overdue={item.overdue ? "true" : "false"}
      className={`block rounded border bg-charcoal p-3 text-ink hover:text-ink ${
        item.overdue ? "border-red-500/60 hover:border-red-400" : "border-muted/60 hover:border-accent-green"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-sm font-bold text-accent-green">{item.company}</p>
        <p className="font-mono text-xs">
          <span className={item.overdue ? "text-red-300" : "text-accent-cyan"}>
            {item.overdue ? "overdue" : "due"} {item.due_on}
          </span>
        </p>
      </div>
      <p className="text-sm">{item.role_title}</p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink/70">
        <span className="font-mono uppercase tracking-wide text-accent-cyan/80">{item.status}</span>
        <span>
          Next: {item.next_action ?? <span className="text-ink/50">no next action</span>}
          {item.next_action_due && <span className="text-ink/50"> (by {item.next_action_due})</span>}
        </span>
        {item.follow_up_date && <span>Follow up {item.follow_up_date}</span>}
      </div>
    </Link>
  );
}
