// The signed-in user, from GET /api/auth/me, and sign out.
import { useEffect, useState } from "react";
import { LOGIN_URL, api } from "./api.ts";

export type Me = { login: string; via: "session" | "agent" };

export type MeState = { me: Me | null; error: unknown };

/** Loads the current user once. A 401 sends the browser to the login page (see api()). */
export function useMe(): MeState {
  const [state, setState] = useState<MeState>({ me: null, error: null });

  useEffect(() => {
    let active = true;
    api<Me>("/auth/me").then(
      (me) => {
        if (active) setState({ me, error: null });
      },
      (error: unknown) => {
        if (active) setState({ me: null, error });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return state;
}

/** Ends the session, then loads the login page. */
export async function signOut(): Promise<void> {
  await api<void>("/auth/logout", { method: "POST" });
  window.location.assign(LOGIN_URL);
}
