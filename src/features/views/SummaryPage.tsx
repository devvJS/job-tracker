import { useEffect, useState } from "react";
import { STATUSES } from "../../../shared/schemas.ts";
import { ErrorBanner } from "../../components/ErrorBanner.tsx";
import { useLiveList } from "../../lib/record-sync.ts";
import { type SourceRow, type SummaryResponse, getSummary } from "./views-api.ts";

/** /summary: the weekly counts, the current status breakdown and the all-time source table. */
export function SummaryPage() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Changes to refetch silently: another tab's application write, or the tab becoming visible (spec I).
  const refreshKey = useLiveList("application");

  useEffect(() => {
    let active = true;
    getSummary().then(
      (res) => {
        if (!active) return;
        setData(res);
        setError(null);
      },
      (err: unknown) => {
        if (!active) return;
        setData(null);
        setError(err);
      },
    );
    return () => {
      active = false;
    };
  }, [refreshKey]);

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-xl font-bold text-accent-green">Summary</h1>

      {error !== null && <ErrorBanner error={error} />}
      {error === null && data === null && <p className="text-ink/60">Loading…</p>}

      {data && (
        <div data-testid="summary" className="space-y-8">
          <div>
            <p className="font-mono text-xs text-ink/60">
              Window <span className="text-accent-cyan">{data.from}</span> to{" "}
              <span className="text-accent-cyan">{data.to}</span>
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-3">
              <Count testId="summary-applied" label="Applied" value={data.applied} />
              <Count testId="summary-responses" label="Responses" value={data.responses} />
              <Count testId="summary-interviews" label="Interviews" value={data.interviews} />
            </dl>
          </div>

          <div>
            <h2 className="font-mono text-sm uppercase tracking-wide text-accent-cyan">By status (current)</h2>
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {STATUSES.map((status) => (
                <li
                  key={status}
                  className="flex items-center justify-between rounded border border-muted/60 px-3 py-2 font-mono text-xs"
                >
                  <span className="text-ink/80">{status}</span>
                  <span className="text-ink">{data.by_status[status] ?? 0}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="font-mono text-sm uppercase tracking-wide text-accent-cyan">By source (all time, applied)</h2>
            {data.by_source.length === 0 ? (
              <p className="mt-3 text-sm text-ink/60">No applications have been sent yet.</p>
            ) : (
              <SourceTable rows={data.by_source} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Count(props: { testId: string; label: string; value: number }) {
  return (
    <div className="rounded border border-muted/60 p-4">
      <dt className="font-mono text-xs uppercase tracking-wide text-ink/60">{props.label}</dt>
      <dd data-testid={props.testId} className="mt-1 font-mono text-3xl font-bold text-accent-green">
        {props.value}
      </dd>
    </div>
  );
}

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

function SourceTable({ rows }: { rows: SourceRow[] }) {
  const cell = "px-3 py-2 text-right";
  return (
    <table className="mt-3 w-full border-collapse font-mono text-sm">
      <thead>
        <tr className="border-b border-muted/60 text-xs uppercase tracking-wide text-ink/60">
          <th className="px-3 py-2 text-left font-normal">Source</th>
          <th className={`${cell} font-normal`}>Applied</th>
          <th className={`${cell} font-normal`}>Responded</th>
          <th className={`${cell} font-normal`}>Interviewed</th>
          <th className={`${cell} font-normal`}>Response rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.source} data-testid="summary-source-row" data-source={row.source} className="border-b border-muted/30">
            <td className="px-3 py-2 text-left text-accent-green">{row.source}</td>
            <td className={cell}>{row.applied}</td>
            <td className={cell}>{row.responded}</td>
            <td className={cell}>{row.interviewed}</td>
            <td className={`${cell} text-accent-cyan`}>{percent.format(row.response_rate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
