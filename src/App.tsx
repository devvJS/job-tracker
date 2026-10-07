import { useState } from "react";
import { Link, Outlet, useMatch } from "react-router";
import { ErrorBanner } from "./components/ErrorBanner.tsx";
import { Nav } from "./components/Nav.tsx";
import { UserMenu } from "./components/UserMenu.tsx";
import { ApiError } from "./lib/api.ts";
import { useMe } from "./lib/session.ts";

/** The layout every route renders inside, the login page included. */
export function App() {
  const onLogin = useMatch("/login") !== null;

  return (
    <div data-testid="app-shell" className="flex min-h-screen flex-col bg-charcoal text-ink">
      {onLogin ? <SignedOutHeader /> : <SignedInHeader />}
      <main className="flex-1 px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="font-mono text-lg font-bold text-accent-green hover:text-accent-cyan">
      job-tracker
    </Link>
  );
}

function SignedOutHeader() {
  return (
    <header className="border-b border-muted/40 px-6 py-4">
      <span className="font-mono text-lg font-bold text-accent-green">job-tracker</span>
    </header>
  );
}

function SignedInHeader() {
  const { me, error: meError } = useMe();
  const [actionError, setActionError] = useState<unknown>(null);
  // A 401 is already on its way to the login page, so it gets no banner.
  const loadError = meError instanceof ApiError && meError.status === 401 ? null : meError;
  const error = actionError ?? loadError;

  return (
    <header className="border-b border-muted/40 px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6">
          <Brand />
          <Nav />
        </div>
        <UserMenu me={me} onError={setActionError} />
      </div>
      {error !== null && (
        <div className="mt-3">
          <ErrorBanner error={error} />
        </div>
      )}
    </header>
  );
}
