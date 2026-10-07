// URL paths shared by the app factory and the auth code.

export const BASE_PATH = "/job-tracker";
export const API_PATH = `${BASE_PATH}/api`;
export const AUTH_PATH = `${API_PATH}/auth`;
export const LOGIN_PAGE_PATH = `${BASE_PATH}/login`;
export const HOME_PATH = `${BASE_PATH}/`;
export const HEALTHZ_PATH = `${BASE_PATH}/healthz`;
export const OAUTH_CALLBACK_PATH = `${AUTH_PATH}/callback`;

export function isApiPath(path: string): boolean {
  return path === API_PATH || path.startsWith(`${API_PATH}/`);
}

/** The /api/auth prefix (exempt from the 415 check). A sibling such as /api/authx is not under it. */
export function isAuthPath(path: string): boolean {
  return path === AUTH_PATH || path.startsWith(`${AUTH_PATH}/`);
}

/**
 * The auth routes that need no credentials: login, callback and logout. `me` is not listed: it
 * goes through the auth middleware like any other API route and reports who authenticated.
 */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  `${AUTH_PATH}/login`,
  OAUTH_CALLBACK_PATH,
  `${AUTH_PATH}/logout`,
]);

/** A path whose last segment contains a dot names a file (asset), never an SPA route. */
export function looksLikeFile(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".");
}
