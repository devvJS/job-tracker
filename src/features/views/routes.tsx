import type { RouteObject } from "react-router";
import { DuePage } from "./DuePage.tsx";
import { SummaryPage } from "./SummaryPage.tsx";

export const viewRoutes: RouteObject[] = [
  { path: "due", element: <DuePage /> },
  { path: "summary", element: <SummaryPage /> },
];
