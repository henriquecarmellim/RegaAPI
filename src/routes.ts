import { db, getConfig, getState, latestTelemetry } from "./db";
import {
  COOKIE, checkCredentials, createSession, deviceAuthorized, loginAllowed, sessionCookie, sessionFrom,
} from "./auth";
import {
  autoAllowed, command, ingestTelemetry, isOnline, isRunning, rawToPercent, resumeAuto, startIrrigation,
  stopIrrigation, tick,
} from "./irrigation";
import { activeAlerts, evaluateAlerts, recentAlerts } from "./alerts";
import { broadcastStatus } from "./realtime";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers });
const err = (status: number, error: string) => json({ error }, status);

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch { return null; }
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Envolve rotas que exigem sessão de usuário. */
const authed = (fn: (req: Request) => Response | Promise<Response>) => (req: Request) =>
  sessionFrom(req) ? fn(req) : err(401, "Não autenticado");

export function status() {
  tick();
  const cfg = getConfig(), s = getState(), tel = latestTelemetry();
  const cmd = command();
  return {
    device_online: isOnline(),
    last_seen: s.last_seen || null,
    sensors: tel && {
      soil_raw: tel.soil_raw,
      soil_percent: tel.soil_percent,
      water_ok: !!tel.water_ok,
      updated_at: tel.created_at,
    },
    pump: { on: isRunning(), remaining_sec: cmd.remaining_sec },
    auto: { enabled: !!cfg.auto_mode, paused: !!s.auto_paused, allowed_now: autoAllowed() },
    alerts: activeAlerts(),
    config: publicConfig(),
  };
}

const publicConfig = () => {
  const { id, ...c } = getConfig() as any;
  return { ...c, auto_mode: !!c.auto_mode, window_enabled: !!c.window_enabled };
};

const RANGES: Record<string, number> = { "1h": 3600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

/** Segundos reais e litros estimados de uma rega. */
function withUsage(ev: any, flow: number, now = Date.now()) {
  const end = ev.ended_at ?? (ev.status === "RUNNING" ? now : ev.started_at);
  const actual_sec = Math.max(0, Math.round((end - ev.started_at) / 1000));
  return { ...ev, actual_sec, liters: flow > 0 ? Math.round((actual_sec / 60) * flow * 100) / 100 : null };
}

function usageSince(since: number, flow: number, now = Date.now()) {
  const r = db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) AS ms
     FROM irrigation_events WHERE started_at >= ? AND status != 'CANCELLED_NO_WATER'`,
  ).get(now, since) as { n: number; ms: number };
  const sec = Math.round(r.ms / 1000);
  return { count: r.n, seconds: sec, liters: flow > 0 ? Math.round((sec / 60) * flow * 100) / 100 : null };
}

const clampLimit = (v: string | null, def: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
};

export const routes = {
  "/api/health": { GET: () => json({ ok: true }) },

  // ---------- Autenticação ----------
  "/api/auth/login": {
    POST: async (req: Request) => {
      const ip = req.headers.get("x-forwarded-for") ?? "local";
      if (!loginAllowed(ip)) return err(429, "Muitas tentativas. Aguarde 1 minuto.");
      const b = await body(req);
      if (typeof b?.username !== "string" || typeof b?.password !== "string") return err(400, "Informe usuário e senha.");
      if (!checkCredentials(b.username, b.password)) return err(401, "Credenciais inválidas.");
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(createSession(b.username)) });
    },
  },
  "/api/auth/logout": {
    POST: () => json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }),
  },
  "/api/auth/me": {
    GET: (req: Request) => {
      const s = sessionFrom(req);
      return s ? json({ authenticated: true, user: s.u }) : err(401, "Não autenticado");
    },
  },

  // ---------- ESP32 ----------
  "/api/device/telemetry": {
    POST: async (req: Request) => {
      if (!deviceAuthorized(req)) return err(401, "Token do dispositivo inválido");
      const b = await body(req);
      if (!b || !isInt(b.soil_raw, 0, 4095) || typeof b.water_ok !== "boolean")
        return err(400, "Esperado { soil_raw: 0-4095, water_ok: boolean, pump_on?: boolean }");
      const cmd = ingestTelemetry({ soil_raw: b.soil_raw, water_ok: b.water_ok, pump_on: b.pump_on === true });
      broadcastStatus();
      return json(cmd);
    },
  },

  // ---------- Dashboard ----------
  "/api/status": { GET: authed(() => json(status())) },

  "/api/telemetry/history": {
    GET: authed((req) => {
      const u = new URL(req.url);
      const limit = clampLimit(u.searchParams.get("limit"), 100, 1000);
      const since = Number(u.searchParams.get("since")) || 0;
      const rows = db.query(
        `SELECT id, soil_raw, soil_percent, water_ok, pump_on, created_at
         FROM telemetry WHERE created_at >= ? ORDER BY id DESC LIMIT ?`,
      ).all(since, limit) as any[];
      return json(rows.reverse().map((r) => ({ ...r, water_ok: !!r.water_ok, pump_on: !!r.pump_on })));
    }),
  },

  "/api/irrigation/start": {
    POST: authed(async (req) => {
      const b = await body(req);
      const cfg = getConfig();
      let dur: number | undefined;
      if (b?.duration_sec !== undefined) {
        if (!isInt(b.duration_sec, 1, cfg.max_run_sec)) return err(400, `duration_sec deve ser 1-${cfg.max_run_sec}`);
        dur = b.duration_sec;
      }
      const r = startIrrigation("MANUAL", dur);
      broadcastStatus();
      if (r.ok) return json({ ok: true, event_id: r.eventId, duration_sec: r.durationSec }, 201);
      const msg = {
        NO_WATER: "Reservatório sem água (boia desligada). Rega bloqueada.",
        OFFLINE: "ESP32 offline. Não é possível acionar a bomba.",
        ALREADY_RUNNING: "A bomba já está em funcionamento.",
      }[r.reason];
      return json({ error: msg, reason: r.reason }, 409);
    }),
  },
  "/api/irrigation/stop": {
    POST: authed(() => { const was = stopIrrigation(); broadcastStatus(); return json({ ok: true, was_running: was }); }),
  },
  "/api/irrigation/history": {
    GET: authed((req) => {
      const limit = clampLimit(new URL(req.url).searchParams.get("limit"), 20, 200);
      const flow = getConfig().flow_lpm;
      return json((db.query("SELECT * FROM irrigation_events ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((e) => withUsage(e, flow)));
    }),
  },
  "/api/irrigation/resume": {
    POST: authed(async () => { resumeAuto(); await evaluateAlerts(); broadcastStatus(); return json({ ok: true }); }),
  },

  "/api/chart": {
    GET: authed((req) => {
      const range = new URL(req.url).searchParams.get("range") ?? "24h";
      const span = RANGES[range];
      if (!span) return err(400, "range deve ser 1h, 24h ou 7d");
      const now = Date.now(), since = now - span, bucket = Math.floor(span / 240);
      const points = (db.query(
        `SELECT (created_at / ?1) * ?1 AS t, AVG(soil_percent) AS soil_percent,
                MIN(water_ok) AS water_ok, MAX(pump_on) AS pump_on
         FROM telemetry WHERE created_at >= ?2 GROUP BY created_at / ?1 ORDER BY t`,
      ).all(bucket, since) as any[]).map((p) => ({ ...p, soil_percent: Math.round(p.soil_percent * 10) / 10, water_ok: !!p.water_ok, pump_on: !!p.pump_on }));
      const events = db.query(
        `SELECT id, trigger, started_at, ended_at, planned_sec, status, effective FROM irrigation_events
         WHERE started_at >= ? ORDER BY id`,
      ).all(since);
      return json({ range, since, now, bucket_ms: bucket, min_moisture: getConfig().min_moisture, points, events });
    }),
  },

  "/api/stats": {
    GET: authed(() => {
      const flow = getConfig().flow_lpm, now = Date.now();
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      return json({
        flow_lpm: flow,
        today: usageSince(midnight.getTime(), flow, now),
        last_7d: usageSince(now - 7 * 86_400_000, flow, now),
      });
    }),
  },

  "/api/alerts": {
    GET: authed(() => json({ active: activeAlerts(), recent: recentAlerts(20) })),
  },

  "/api/config": {
    GET: authed(() => json(publicConfig())),
    PUT: authed(async (req) => {
      const b = await body(req);
      if (!b) return err(400, "JSON inválido");
      const n = { ...getConfig(), ...b } as any;
      const isBool = (v: unknown) => v === true || v === false || v === 0 || v === 1;
      const ok =
        isBool(n.auto_mode) && isBool(n.window_enabled) &&
        typeof n.min_moisture === "number" && n.min_moisture >= 0 && n.min_moisture <= 100 &&
        isInt(n.max_run_sec, 1, 600) &&
        isInt(n.duration_sec, 1, n.max_run_sec) &&
        isInt(n.cooldown_sec, 0, 86_400) &&
        isInt(n.dry_raw, 0, 4095) && isInt(n.wet_raw, 0, 4095) && n.dry_raw > n.wet_raw &&
        typeof n.flow_lpm === "number" && n.flow_lpm >= 0 && n.flow_lpm <= 100 &&
        isInt(n.window_start_min, 0, 1439) && isInt(n.window_end_min, 0, 1439);
      if (!ok) return err(400, "Valores inválidos (dry_raw deve ser maior que wet_raw; duration_sec ≤ max_run_sec; horários 0–1439 min).");
      db.run(
        `UPDATE config SET auto_mode=?, min_moisture=?, duration_sec=?, cooldown_sec=?, max_run_sec=?, dry_raw=?, wet_raw=?,
           flow_lpm=?, window_enabled=?, window_start_min=?, window_end_min=? WHERE id=1`,
        [n.auto_mode ? 1 : 0, n.min_moisture, n.duration_sec, n.cooldown_sec, n.max_run_sec, n.dry_raw, n.wet_raw,
         n.flow_lpm, n.window_enabled ? 1 : 0, n.window_start_min, n.window_end_min],
      );
      broadcastStatus();
      return json({ ok: true });
    }),
  },
};
export { rawToPercent };
