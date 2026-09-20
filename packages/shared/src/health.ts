import { createServer, Server } from "http";

/** Tiny liveness endpoint for worker services (Docker / Kubernetes probes). */
export function startHealthServer(service: string, port: number, extra: () => Record<string, unknown> = () => ({})): Server {
  const server = createServer((req, res) => {
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
