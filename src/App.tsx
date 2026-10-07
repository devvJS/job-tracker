import { Link, Outlet } from "react-router";

/** The layout every route renders inside. F2 adds the nav, the signed-in user and sign out. */
export function App() {
  return (
    <div data-testid="app-shell" className="flex min-h-screen flex-col bg-charcoal text-ink">
      <header className="border-b border-muted/40 px-6 py-4">
        <Link to="/" className="font-mono text-lg font-bold text-accent-green hover:text-accent-cyan">
          job-tracker
        </Link>
      </header>
      <main className="flex-1 px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
