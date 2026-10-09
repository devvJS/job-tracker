import { NavLink } from "react-router";

const LINKS = [
  { to: "/", label: "Board", testId: "nav-board", end: true },
  { to: "/applications/new", label: "New", testId: "nav-new", end: false },
  { to: "/due", label: "Due", testId: "nav-due", end: false },
  { to: "/summary", label: "Summary", testId: "nav-summary", end: false },
  { to: "/contacts", label: "Contacts", testId: "nav-contacts", end: false },
] as const;

/** The signed-in navigation. */
export function Nav() {
  return (
    <nav data-testid="nav" aria-label="Main" className="flex flex-wrap items-center gap-1">
      {LINKS.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          data-testid={link.testId}
          className={({ isActive }) =>
            `rounded px-3 py-1.5 font-mono text-sm ${
              isActive ? "bg-accent-green/10 text-accent-green" : "text-ink/80 hover:text-accent-cyan"
            }`
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
