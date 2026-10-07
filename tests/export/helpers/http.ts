import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Serves a fetch-style handler over local HTTP, so a child process can reach the fake. */
export async function serveFetch(getFetch: () => typeof fetch): Promise<{ url: string; server: Server; stop: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${req.url ?? "/"}`;
      const method = req.method ?? "GET";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks).toString("utf8");
      getFetch()(url, { method, headers, body })
        .then(async (r) => {
          const text = await r.text();
          res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json" });
          res.end(text);
        })
        .catch((e: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: String(e) }));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
