import { useState } from "react";
import type { Me } from "../lib/session.ts";
import { signOut } from "../lib/session.ts";

/** The signed-in login and the sign-out button. */
export function UserMenu(props: { me: Me | null; onError: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false);

  const onSignOut = async () => {
    setBusy(true);
    try {
      await signOut();
    } catch (error) {
      setBusy(false);
      props.onError(error);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {props.me && (
        <span data-testid="user-login" className="font-mono text-sm text-accent-cyan">
          {props.me.login}
        </span>
      )}
      <button
        type="button"
        data-testid="signout"
        onClick={onSignOut}
        disabled={busy}
        className="rounded border border-muted px-3 py-1 font-mono text-sm text-ink/80 hover:border-accent-cyan hover:text-accent-cyan disabled:opacity-50"
      >
        Sign out
      </button>
    </div>
  );
}
