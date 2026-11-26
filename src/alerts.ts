import { db, getConfig, getState, latestTelemetry, type Alert } from "./db";
import { checkEffectiveness, isOnline, sensorFault, tick } from "./irrigation";

export const OFFLINE_ALERT_AFTER_MS = 5 * 60_000;
export const NO_WATER_ALERT_AFTER_MS = 10 * 60_000;
export const DRY_ALERT_AFTER_MS = 3 * 3600_000;
export const EXCESS_EVENTS_24H = 10;

export const ALERT_TITLES: Record<string, string> = {
  DEVICE_OFFLINE: "ESP32 offline",
  NO_WATER: "Reservatório sem água",
  SENSOR_FAULT: "Sensor de umidade com defeito",
  PUMP_FAULT: "Rega automática pausada (bomba/mangueira com suspeita de falha)",
  DRY_LONG: "Solo seco há horas",
  EXCESS_WATERING: "Rega acima do normal",
};

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Abre o alerta (uma vez) se a condição surgiu; marca como resolvido quando ela some. */
async function setAlert(kind: string, active: boolean, detail: string, now: number) {
  const open = db.query("SELECT * FROM alerts WHERE kind=? AND resolved_at IS NULL").get(kind) as Alert | null;
  if (active && !open) {
    const message = `${ALERT_TITLES[kind]} — ${detail}`;
    db.run("INSERT INTO alerts (kind, message, created_at) VALUES (?,?,?)", [kind, message, now]);
    console.log(`[ALERTA] ⚠️ ${message}`);
  } else if (!active && open) {
    db.run("UPDATE alerts SET resolved_at=? WHERE id=?", [now, open.id]);
    console.log(`[ALERTA] ✅ Resolvido: ${ALERT_TITLES[kind]} (${fmtTime(now)})`);
  }
}

export async function evaluateAlerts(now = Date.now()) {
  const s = getState();
  const cfg = getConfig();
  const tel = latestTelemetry();
  const online = isOnline(now);

  // Só alerta sobre o dispositivo depois que ele já se conectou ao menos uma vez
  await setAlert("DEVICE_OFFLINE", s.last_seen > 0 && now - s.last_seen > OFFLINE_ALERT_AFTER_MS,
    `sem dados desde ${s.last_seen ? fmtTime(s.last_seen) : "—"}`, now);

  // Alertas baseados em leitura só valem com o dispositivo online (senão o dado é velho)
  let noWater = false;
  if (online && tel && !tel.water_ok) {
    const r = db.query("SELECT MAX(created_at) AS m FROM telemetry WHERE water_ok=1").get() as { m: number | null };
    const since = r.m ?? (db.query("SELECT MIN(created_at) AS m FROM telemetry").get() as { m: number }).m;
    noWater = now - since >= NO_WATER_ALERT_AFTER_MS;
  }
  await setAlert("NO_WATER", noWater, "a boia indica nível baixo; a bomba está bloqueada", now);

  await setAlert("SENSOR_FAULT", false,
    "leitura nos extremos do ADC (sensor solto ou em curto)", now);

  await setAlert("PUMP_FAULT", !!s.auto_paused,
    "3 regas seguidas não elevaram a umidade. Verifique bomba, mangueira e sensor e toque em “Retomar” no painel", now);

  let dry = false;
  if (online && cfg.auto_mode) {
    const r = db.query(
      "SELECT MAX(soil_percent) AS mx, MIN(created_at) AS first FROM telemetry WHERE created_at >= ?",
    ).get(now - DRY_ALERT_AFTER_MS) as { mx: number | null; first: number | null };
    dry = r.mx !== null && r.first !== null && r.mx < cfg.min_moisture &&
      now - r.first >= DRY_ALERT_AFTER_MS - 5 * 60_000;
  }
  await setAlert("DRY_LONG", dry, `a umidade ficou abaixo de ${cfg.min_moisture}% nas últimas 3 h`, now);

  const n = (db.query("SELECT COUNT(*) AS c FROM irrigation_events WHERE started_at >= ?").get(now - 86_400_000) as { c: number }).c;
  await setAlert("EXCESS_WATERING", n >= EXCESS_EVENTS_24H, `${n} regas nas últimas 24 h`, now);
}

/** Rotina periódica de monitoramento (a cada 30 s). */
export async function monitorTick(now = Date.now()) {
  tick(now);
  checkEffectiveness(now);
  await evaluateAlerts(now);
}

export const activeAlerts = () =>
  db.query("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC").all() as Alert[];
export const recentAlerts = (limit = 20) =>
  db.query("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit) as Alert[];
