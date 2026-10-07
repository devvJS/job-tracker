import type { RouteObject } from "react-router";
import { ContactsPage } from "./ContactsPage.tsx";

export const contactRoutes: RouteObject[] = [{ path: "contacts", element: <ContactsPage /> }];
