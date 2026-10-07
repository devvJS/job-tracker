import type { RouteObject } from "react-router";
import { BoardPage } from "./BoardPage.tsx";
import { DetailPage } from "./DetailPage.tsx";
import { NewApplicationPage } from "./NewApplicationPage.tsx";

/** The board is the index route; the create form and the detail page sit under /applications. */
export const applicationRoutes: RouteObject[] = [
  { index: true, element: <BoardPage /> },
  { path: "applications/new", element: <NewApplicationPage /> },
  { path: "applications/:id", element: <DetailPage /> },
];
