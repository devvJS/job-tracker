// A fake GitHub for e2e, run as its own process (node e2e/support/fake-github.ts).
// OAuth:  GET  /login/oauth/authorize       -> 302 back to redirect_uri with code and state
//         POST /login/oauth/access_token    -> {access_token}
// API:    GET  /user                        -> {login}
// Control: POST /__control/login {"login": "mallory"} makes the NEXT authorize issue a code for
//          that login (one shot); afterwards it reverts to the default, devvJS.
//         GET  /__health                    -> 200
import { createServer, type IncomingMessage } from "node:http";

const PORT = Number(process.env.FAKE_GITHUB_PORT ?? Number(process.env.E2E_PORT ?? 4300) + 1);
const DEFAULT_LOGIN = "devvJS";

let nextLogin: string | null = null;
let counter = 0;
const codes = new Map<string, string>(); // code -> login
const tokens = new Map<string, string>(); // token -> login

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/__health") return send(200, { ok: true });

  if (req.method === "POST" && url.pathname === "/__control/login") {
    const parsed = JSON.parse((await readBody(req)) || "{}") as { login?: string };
    nextLogin = parsed.login ?? null;
    return send(200, { next: nextLogin });
  }

  if (req.method === "GET" && url.pathname === "/login/oauth/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!redirectUri || !state) return send(400, { error: "missing redirect_uri or state" });
    const code = `code-${++counter}`;
    codes.set(code, nextLogin ?? DEFAULT_LOGIN);
    nextLogin = null;
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
    const body = JSON.parse((await readBody(req)) || "{}") as { code?: string };
    const login = body.code ? codes.get(body.code) : undefined;
    if (!login || !body.code) return send(200, { error: "bad_verification_code" });
    codes.delete(body.code);
    const token = `fake-token-${++counter}`;
    tokens.set(token, login);
    return send(200, { access_token: token, token_type: "bearer", scope: "read:user" });
  }

  if (req.method === "GET" && url.pathname === "/user") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const login = tokens.get(token);
    if (!login) return send(401, { message: "Bad credentials" });
    return send(200, { login, id: 4242 });
  }

  return send(404, { message: "not found" });
});

server.listen(PORT, () => console.log(`fake github listening on ${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
