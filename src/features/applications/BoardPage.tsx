import { useEffect, useState } from "react";
import { Link } from "react-router";
import { type ApplicationRecord, STATUSES, TRACKS, WORK_ARRANGEMENTS } from "../../../shared/schemas.ts";
import { ErrorBanner } from "../../components/ErrorBanner.tsx";
import { useLiveList } from "../../lib/record-sync.ts";
import { type BoardFilters, NO_FILTERS, filterQuery, listApplications } from "./applications-api.ts";

type Loaded = { query: string; items: ApplicationRecord[] | null; error: unknown };

const controlClass =
  "rounded border border-muted bg-charcoal px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent-cyan focus:outline-none";

/** The board: one column per status in pipeline order, filtered on the server. */
export function BoardPage() {
  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Changes to refetch silently: another tab's application write, or the tab becoming visible.
  const refreshKey = useLiveList("application");
  const query = filterQuery(filters);

  useEffect(() => {
    let active = true;
    listApplications(query).then(
      (res) => {
        if (active) setLoaded({ query, items: res.items, error: null });
      },
      (error: unknown) => {
        if (active) setLoaded({ query, items: null, error });
      },
    );
    return () => {
      active = false;
    };
  }, [query, refreshKey]);

  const set = <K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const loading = loaded === null || loaded.query !== query;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-bold">Pipeline</h1>
        <Link to="/applications/new" className="font-mono text-sm">
          + New application
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded border border-muted/60 p-3 font-mono text-xs">
        <input
          data-testid="filter-q"
          type="search"
          placeholder="Search company or role"
          aria-label="Search company or role"
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
          className={`${controlClass} w-56 font-sans`}
        />
        <select
          data-testid="filter-work-arrangement"
          aria-label="Work arrangement"
          value={filters.work_arrangement}
          onChange={(e) => set("work_arrangement", e.target.value)}
          className={controlClass}
        >
          <option value="">Any arrangement</option>
          {WORK_ARRANGEMENTS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <select
          data-testid="filter-track"
          aria-label="Track"
          value={filters.track}
          onChange={(e) => set("track", e.target.value)}
          className={controlClass}
        >
          <option value="">Any track</option>
          {TRACKS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Check testId="filter-detroit-metro" label="Detroit metro" checked={filters.detroit_metro} onChange={(v) => set("detroit_metro", v)} />
        <Check testId="filter-meets-floor" label="Meets floor" checked={filters.meets_floor} onChange={(v) => set("meets_floor", v)} />
        <Check testId="filter-min-fit-80" label="Fit ≥ 80" checked={filters.min_fit_80} onChange={(v) => set("min_fit_80", v)} />
        {loading && <span className="text-ink/50">Loading…</span>}
      </div>

      {loaded?.error != null && <ErrorBanner error={loaded.error} />}

      {loaded?.items && (
        <>
          {loaded.items.length === 0 && (
            <p data-testid="board-empty" className="rounded border border-dashed border-muted p-6 text-center text-ink/70">
              {query === "" ? "No applications yet. Add the first one." : "No applications match these filters."}
            </p>
          )}
          <div data-testid="board" className="flex gap-3 overflow-x-auto pb-3">
            {STATUSES.map((status) => (
              <Column key={status} status={status} items={loaded.items!.filter((a) => a.status === status)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Check(props: { testId: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-ink/80">
      <input
        data-testid={props.testId}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="accent-accent-green"
      />
      {props.label}
    </label>
  );
}

function Column(props: { status: string; items: ApplicationRecord[] }) {
  return (
    <div data-testid={`board-column-${props.status}`} className="w-64 shrink-0 rounded border border-muted/60 bg-white/[0.02]">
      <h2 className="flex items-center justify-between border-b border-muted/60 px-3 py-2 text-xs uppercase tracking-wide text-accent-cyan">
        {props.status}
        <span className="text-ink/50">{props.items.length}</span>
      </h2>
      <ul className="space-y-2 p-2">
        {props.items.map((a) => (
          <li key={a.id}>
            <Card app={a} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function Card({ app }: { app: ApplicationRecord }) {
  const top = app.comp_max ?? app.comp_min;
  const fit = typeof app.fit?.total === "number" ? app.fit.total : null;
  return (
    <Link
      to={`/applications/${encodeURIComponent(app.id)}`}
      data-testid="app-card"
      data-id={app.id}
      className="block rounded border border-muted/60 bg-charcoal p-3 text-ink hover:border-accent-green hover:text-ink"
    >
      <p className="font-mono text-sm font-bold text-accent-green">{app.company}</p>
      <p className="text-sm">{app.role_title}</p>
      <p className="mt-1 text-xs text-ink/60">
        {app.work_arrangement}
        {app.location ? ` · ${app.location}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px]">
        {top !== null && (
          <span className={app.meets_floor ? "text-accent-green" : "text-ink/60"}>{usd.format(top)}</span>
        )}
        {fit !== null && <span className={fit >= 80 ? "text-accent-cyan" : "text-ink/60"}>fit {fit}</span>}
        {app.next_action_due && <span className="text-ink/60">due {app.next_action_due}</span>}
      </div>
    </Link>
  );
}
