import { createServer, IncomingMessage, Server, ServerResponse } from "http";

/** Tiny liveness endpoint for worker services (Docker / Kubernetes probes). */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function startHealthServer(
  service: string,
  port: number,
  extra: () => Record<string, unknown> = () => ({}),
  handler?: RouteHandler, // optional extra routes; return true if the request was handled
): Server {
  const server = createServer(async (req, res) => {
    if (handler && (await handler(req, res).catch(() => false))) return;
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service, ...extra() }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, "0.0.0.0");
  return server;
}

/** Hosts hand out "name:port" (private networking) or a full URL; accept both. */
export function normalizeUrl(u: string): string {
  const t = u.replace(/\/$/, "");
  return t.includes("://") ? t : `http://${t}`;
}
