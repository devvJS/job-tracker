// Live cross-tab sync (spec I). Tabs announce their writes on a BroadcastChannel
// named "job-tracker"; pages listen and refetch. Every page also refetches when
// the tab becomes visible or focused again (throttled), which catches writes by
// the agent and covers browsers without BroadcastChannel. There is no polling.
import { useEffect, useEffectEvent, useState } from "react";

export const CHANNEL_NAME = "job-tracker";

/** What a write announces. `updated_at` is the record's new value, or null for a delete. */
export type SyncMessage = { kind: "application" | "contact"; id: string; updated_at: string | null };
export type SyncKind = SyncMessage["kind"];

/** Visibility refetches run at most once per this many milliseconds. */
export const REFETCH_THROTTLE_MS = 2000;
/**
 * Events this soon after a visibility refetch belong to the same activation: a tab switch fires
 * visibilitychange and focus together, and that is one refetch, not one plus a deferred one.
 */
const SAME_ACTIVATION_MS = 250;

type Listener = (message: SyncMessage) => void;

// One channel per tab, used both to post and to receive. A BroadcastChannel never
// delivers a message to the object that posted it, so a tab never hears its own writes.
let channel: BroadcastChannel | null | undefined;
const listeners = new Set<Listener>();

function isSyncMessage(data: unknown): data is SyncMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  return (
    (m.kind === "application" || m.kind === "contact") &&
    typeof m.id === "string" &&
    (typeof m.updated_at === "string" || m.updated_at === null)
  );
}

/** The tab's channel, created on first use; null where BroadcastChannel is unavailable. */
function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : null;
  } catch {
    channel = null;
  }
  channel?.addEventListener("message", (event: MessageEvent) => {
    if (!isSyncMessage(event.data)) return;
    for (const listener of [...listeners]) listener(event.data);
  });
  return channel;
}

/** Announces a successful write to the other tabs. Does nothing without BroadcastChannel. */
export function publish(message: SyncMessage): void {
  try {
    getChannel()?.postMessage(message);
  } catch {
    // A closed or unavailable channel only costs live updates; visibility refetch still applies.
  }
}

/** Shorthand: announce an application or contact record that a write returned. */
export function publishRecord(kind: SyncKind, record: { id: string; updated_at: string }): void {
  publish({ kind, id: record.id, updated_at: record.updated_at });
}

/** Shorthand: announce a delete. */
export function publishDelete(kind: SyncKind, id: string): void {
  publish({ kind, id, updated_at: null });
}

/** Subscribes to other tabs' messages. Returns the unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  getChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when `a` is a later instant than `b` (both ISO datetimes as the API returns them). */
export function isNewer(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

/** Calls `onMessage` for every other tab's message of `kind`. The latest callback is always used. */
export function useSyncMessages(kind: SyncKind, onMessage: (message: SyncMessage) => void): void {
  const handle = useEffectEvent(onMessage);
  useEffect(
    () =>
      subscribe((message) => {
        if (message.kind === kind) handle(message);
      }),
    [kind],
  );
}

/**
 * Calls `refetch` when the tab becomes visible (visibilitychange) or the window
 * gains focus, at most once per REFETCH_THROTTLE_MS. An event inside the window is
 * deferred to the window's end (one trailing refetch), not dropped, so a quick
 * tab flip still refreshes. The window starts at mount, since the page has just
 * loaded its data then.
 */
export function useRefetchOnVisible(refetch: () => void): void {
  const run = useEffectEvent(refetch);
  useEffect(() => {
    let last = Date.now();
    let afterRefetch = false; // false until this hook has refetched (the window then starts at mount)
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(trailing);
      trailing = undefined;
      last = Date.now();
      afterRefetch = true;
      run();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const sinceLast = Date.now() - last;
      if (sinceLast >= REFETCH_THROTTLE_MS) return fire();
      // Right after a refetch (not the initial load), this is the same activation's second event.
      if (afterRefetch && sinceLast < SAME_ACTIVATION_MS) return;
      trailing ??= setTimeout(fire, REFETCH_THROTTLE_MS - sinceLast);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearTimeout(trailing);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
}

/** For list pages: refetch on any other tab's message of `kind`, and when the tab becomes visible. */
export function useLiveRefetch(kind: SyncKind, refetch: () => void): void {
  useSyncMessages(kind, () => refetch());
  useRefetchOnVisible(refetch);
}

/**
 * For list pages that load in an effect: a key that changes whenever the page should
 * refetch silently (useLiveRefetch's triggers). Add it to the load effect's dependencies.
 */
export function useLiveList(kind: SyncKind): number {
  const [key, setKey] = useState(0);
  useLiveRefetch(kind, () => setKey((k) => k + 1));
  return key;
}
