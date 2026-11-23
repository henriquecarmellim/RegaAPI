import { join, normalize } from "node:path";
import { env } from "./src/env";
import { pruneTelemetry } from "./src/db";
import { tick } from "./src/irrigation";
import { monitorTick } from "./src/alerts";
import { sessionFrom } from "./src/auth";
import { routes, status } from "./src/routes";
import { attachRealtime, broadcastStatus, handleWsUpgrade, wsHandlers } from "./src/realtime";

const PUBLIC = join(import.meta.dir, "public");

async function serveStatic(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const logged = !!sessionFrom(req);
  // "/" é o dashboard (exige login); "/login" é a tela de login.
  if (path === "/") return logged ? file("index.html") : Response.redirect("/login", 302);
  if (path === "/login") return logged ? Response.redirect("/", 302) : file("login.html");
  if (path === "/style.css") return file("style.css");
  return new Response("Not found", { status: 404 });
}

function file(name: string) {
  const full = normalize(join(PUBLIC, name));
  return new Response(Bun.file(full), { headers: { "Cache-Control": "no-store" } });
}

const server = Bun.serve({
  port: env.port,
  hostname: env.host,
  routes: routes as any,
  websocket: wsHandlers as any,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") return handleWsUpgrade(req, srv);
    return serveStatic(req);
  },
  error(e) {
    console.error(e);
    return Response.json({ error: "Erro interno" }, { status: 500 });
  },
});

attachRealtime({ publish: (t, d) => { server.publish(t, d); }, subscriberCount: (t) => server.subscriberCount(t) }, status);

// Encerra regas expiradas mesmo sem telemetria chegando
setInterval(() => tick(), 1000);
// Painel em tempo real: estado a cada 2 s
setInterval(() => broadcastStatus(), 2000);
// Eficácia das regas + alertas (a cada 30 s)
setTimeout(() => monitorTick().then(broadcastStatus).catch(console.error), 5000);
setInterval(() => monitorTick().then(broadcastStatus).catch(console.error), 30_000);
pruneTelemetry();
setInterval(() => pruneTelemetry(), 6 * 3600_000);

console.log(`RegaAPI em http://localhost:${env.port}`);
