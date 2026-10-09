/**
 * Shown while an edit form is open and the record has changed in another tab or by the agent
 * (spec I). Saving the open form is refused by If-Match; `onReload` discards the edits and loads
 * the latest version. Test ids: stale-banner, stale-reload.
 */
export function StaleBanner(props: { onReload: () => void }) {
  return (
    <div
      data-testid="stale-banner"
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded border border-accent-cyan/60 bg-accent-cyan/10 px-4 py-3 text-sm text-ink"
    >
      <span>Updated in another tab or by your agent. This form is based on an older version; load the latest to edit it.</span>
      <button
        type="button"
        data-testid="stale-reload"
        onClick={props.onReload}
        className="rounded border border-accent-cyan px-3 py-1 font-mono text-xs text-accent-cyan hover:bg-accent-cyan/10"
      >
        Load latest (discard my edits)
      </button>
    </div>
  );
}
