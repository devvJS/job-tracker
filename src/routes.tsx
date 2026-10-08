import { createBrowserRouter, type RouteObject } from "react-router";
import { App } from "./App.tsx";
import { applicationRoutes } from "./features/applications/routes.tsx";
import { contactRoutes } from "./features/contacts/routes.tsx";
import { viewRoutes } from "./features/views/routes.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { NotFound } from "./pages/NotFound.tsx";

/** Every route renders inside the shell, the login page included. */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <App />,
    children: [
      { path: "login", element: <LoginPage /> },
      ...applicationRoutes,
      ...contactRoutes,
      ...viewRoutes,
      { path: "*", element: <NotFound /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes, { basename: "/job-tracker" });
}
