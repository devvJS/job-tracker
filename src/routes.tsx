import { createBrowserRouter, type RouteObject } from "react-router";
import { App } from "./App.tsx";
import { applicationRoutes } from "./features/applications/routes.tsx";
import { contactRoutes } from "./features/contacts/routes.tsx";
import { viewRoutes } from "./features/views/routes.tsx";

function NotFound() {
  return (
    <section>
      <h1 className="text-xl font-bold">Not found</h1>
      <p className="mt-2 text-ink/70">There is no page at this address.</p>
    </section>
  );
}

/** Every feature route renders inside the shell. */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <App />,
    children: [...applicationRoutes, ...contactRoutes, ...viewRoutes, { path: "*", element: <NotFound /> }],
  },
];

export function createRouter() {
  return createBrowserRouter(routes, { basename: "/job-tracker" });
}
