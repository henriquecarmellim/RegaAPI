import { test, expect } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.ESP32_TOKEN = "t"; process.env.SESSION_SECRET = "s";
process.env.ADMIN_USER = "u"; process.env.ADMIN_PASS = "p";

const auth = await import("../src/auth");
const rt = await import("../src/realtime");
const { status } = await import("../src/routes");

test("broadcastStatus publica o estado no tópico 'rega'", () => {
  const got: [string, string][] = [];
  rt.attachRealtime({ publish: (t, d) => { got.push([t, d]); }, subscriberCount: () => 1 }, () => ({ hello: 1 }));
  rt.broadcastStatus();
  expect(got.length).toBe(1);
  expect(got[0]![0]).toBe("rega");
  expect(JSON.parse(got[0]![1])).toEqual({ type: "status", data: { hello: 1 } });
});

test("WebSocket: recusa sem sessão e envia o estado ao conectar e em cada broadcast", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") return rt.handleWsUpgrade(req, srv);
      return new Response("no", { status: 404 });
    },
    websocket: rt.wsHandlers as any,
  });
  rt.attachRealtime({ publish: (t, d) => { server.publish(t, d); }, subscriberCount: (t) => server.subscriberCount(t) }, status);
  const url = `ws://localhost:${server.port}/ws`;

  const denied = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => { ws.close(); resolve(false); };
    ws.onerror = () => resolve(true);
    ws.onclose = () => resolve(true);
  });
  expect(denied).toBe(true);

  const token = auth.createSession("u");
  const msgs: any[] = [];
  const ws = new WebSocket(url, { headers: { cookie: `rega_session=${token}` } } as any);
  ws.onmessage = (ev) => { msgs.push(JSON.parse(String(ev.data))); };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = (e) => reject(e); });
  await new Promise((r) => setTimeout(r, 150));
  rt.broadcastStatus();
  await new Promise((r) => setTimeout(r, 150));
  ws.close();
  server.stop(true);

  expect(msgs.length).toBeGreaterThanOrEqual(2);
  expect(msgs[0].type).toBe("status");
  expect(msgs[0].data).toHaveProperty("config");
  expect(msgs[0].data).toHaveProperty("pump");
});
