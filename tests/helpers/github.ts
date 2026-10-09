// A fake GitHub for API tests: a `fetch` that answers the OAuth token exchange and GET /user,
// records every call, and can be told to fail in each way the callback must survive.
import { testConfig } from "./config.ts";

export type FailureMode =
  | "token-network-error"
  | "token-http-500"
  | "token-no-access-token" // 200 with {error: ...}, which is how GitHub reports a bad code
  | "token-not-json"
  | "user-network-error"
  | "user-http-401"
  | "user-http-500"
  | "user-no-login"
  | "user-not-json";

export type RecordedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
};

/** Strings that appear only in failure responses; the callback must never echo them. */
export const LEAKY_UPSTREAM_TEXT = "upstream-leak-marker-9f8e7d";
export const FAKE_ACCESS_TOKEN = "gho_fake_access_token_0123456789";

export type FakeGithub = {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** The login GET /user reports. Mutable. */
  login: string;
  /** Set to make the next requests fail; null for success. Mutable. */
  failure: FailureMode | null;
  tokenCalls(): RecordedCall[];
  userCalls(): RecordedCall[];
};

export function createFakeGithub(
  opts: { login?: string; failure?: FailureMode | null; oauthUrl?: string; apiUrl?: string } = {},
): FakeGithub {
  const defaults = testConfig().github;
  const oauthUrl = opts.oauthUrl ?? defaults.oauthUrl;
  const apiUrl = opts.apiUrl ?? defaults.apiUrl;
  const calls: RecordedCall[] = [];

  const state: FakeGithub = {
    calls,
    login: opts.login ?? "devvJS",
    failure: opts.failure ?? null,
    tokenCalls: () => calls.filter((c) => c.url === `${oauthUrl}/login/oauth/access_token`),
    userCalls: () => calls.filter((c) => c.url === `${apiUrl}/user`),
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : undefined;
      const url = req ? req.url : String(input instanceof URL ? input.href : input);
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(req?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      let body: string | undefined;
      if (typeof init?.body === "string") body = init.body;
      else if (init?.body instanceof URLSearchParams) body = init.body.toString();
      else if (req && method !== "GET") body = await req.clone().text();
      calls.push({ method, url, headers, body });

      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
      const f = state.failure;

      if (url === `${oauthUrl}/login/oauth/access_token` && method === "POST") {
        if (f === "token-network-error") throw new TypeError(`fetch failed ${LEAKY_UPSTREAM_TEXT}`);
        if (f === "token-http-500") return json({ message: LEAKY_UPSTREAM_TEXT }, 500);
        if (f === "token-no-access-token") {
          return json({ error: "bad_verification_code", error_description: LEAKY_UPSTREAM_TEXT });
        }
        if (f === "token-not-json") return new Response(`<html>${LEAKY_UPSTREAM_TEXT}</html>`, { status: 200 });
        return json({ access_token: FAKE_ACCESS_TOKEN, token_type: "bearer", scope: "read:user" });
      }
      if (url === `${apiUrl}/user` && method === "GET") {
        if (f === "user-network-error") throw new TypeError(`fetch failed ${LEAKY_UPSTREAM_TEXT}`);
        if (f === "user-http-401") return json({ message: LEAKY_UPSTREAM_TEXT }, 401);
        if (f === "user-http-500") return json({ message: LEAKY_UPSTREAM_TEXT }, 500);
        if (f === "user-no-login") return json({ id: 1, name: LEAKY_UPSTREAM_TEXT });
        if (f === "user-not-json") return new Response(`<html>${LEAKY_UPSTREAM_TEXT}</html>`, { status: 200 });
        return json({ login: state.login, id: 4242 });
      }
      throw new Error(`fake github: unexpected ${method} ${url}`);
    },
  };
  return state;
}
