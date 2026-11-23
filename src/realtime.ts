import { sessionFrom } from "./auth";

/**
 * Tempo real: o servidor empurra o estado do painel pelo WebSocket (/ws).
 * O ESP32 continua usando HTTP; este módulo só cuida do painel.
 */
export const TOPIC = "rega";

export interface Hub {
  publish(topic: string, data: string): void;
  subscriberCount(topic: string): number;
}
let hub: Hub | null = null;
let snapshot: (() => unknown) | null = null;

/** Liga o módulo ao servidor Bun e à função que monta o estado atual. */
export function attachRealtime(h: Hub, snap: () => unknown) {
  hub = h;
  snapshot = snap;
}

/** Envia o estado atual aos painéis conectados. Sem ninguém conectado, não gasta CPU. */
export function broadcastStatus() {
  if (!hub || !snapshot) return;
  if (hub.subscriberCount(TOPIC) === 0) return;
  hub.publish(TOPIC, JSON.stringify({ type: "status", data: snapshot() }));
}

/** Upgrade do /ws: só com sessão válida. */
export function handleWsUpgrade(req: Request, server: { upgrade(req: Request): boolean }): Response | undefined {
  if (!sessionFrom(req)) return new Response("Não autenticado", { status: 401 });
  if (server.upgrade(req)) return undefined;
  return new Response("Upgrade necessário", { status: 400 });
}

export const wsHandlers = {
  open(ws: { subscribe(topic: string): void; send(data: string): unknown }) {
    ws.subscribe(TOPIC);
    if (snapshot) ws.send(JSON.stringify({ type: "status", data: snapshot() }));
  },
  message() {},
  close() {},
};
