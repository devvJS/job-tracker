// The GitHub OAuth authorization-code exchange (spec E), through the injected fetch.
import type { Config } from "../config.ts";

/** GitHub could not complete the sign-in. `reason` is for server logs and never holds a secret. */
export class UpstreamError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("GitHub sign-in failed");
    this.name = "UpstreamError";
    this.reason = reason;
  }
}

export function authorizeUrl(config: Config, redirectUri: string, state: string): string {
  const url = new URL(`${config.github.oauthUrl}/login/oauth/authorize`);
  url.searchParams.set("client_id", config.github.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return url.toString();
}

async function send(doFetch: typeof fetch, url: string, init: RequestInit, step: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch {
    throw new UpstreamError(`${step}: network error`);
  }
  if (!res.ok) {
    // Drain the body so the connection can be reused; its content is never used.
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`${step}: HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UpstreamError(`${step}: response is not JSON`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new UpstreamError(`${step}: response is not a JSON object`);
  }
  return body as Record<string, unknown>;
}

/** Exchanges the code for a token, then reads the user's login. Throws UpstreamError on any failure. */
export async function exchangeCodeForLogin(
  config: Config,
  doFetch: typeof fetch,
  code: string,
  redirectUri: string,
): Promise<string> {
  const token = await send(
    doFetch,
    `${config.github.oauthUrl}/login/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    },
    "token exchange",
  );
  const accessToken = token.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new UpstreamError("token exchange: no access_token");
  }

  const user = await send(
    doFetch,
    `${config.github.apiUrl}/user`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "job-tracker",
      },
    },
    "user lookup",
  );
  const login = user.login;
  if (typeof login !== "string" || login === "") {
    throw new UpstreamError("user lookup: no login");
  }
  return login;
}
