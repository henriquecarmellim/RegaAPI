import { db, getConfig, getState, latestTelemetry, type Config, type IrrigationEvent } from "./db";

/** Dispositivo sem enviar telemetria por mais que isso é considerado offline. */
export const OFFLINE_AFTER_MS = 30_000;

/** Tempo após a rega para o solo absorver antes de medir se a umidade subiu. */
export const SETTLE_MS = 90_000;
/** Subida mínima (pontos percentuais) para considerar a rega eficaz. */
export const MIN_RISE = 3;
/** Regas ineficazes seguidas que pausam o modo automático. */
export const FAULT_STREAK = 3;
/** Se o solo já estava acima disso antes da rega, a medição é inconclusiva (não há como subir). */
export const MAX_BEFORE_FOR_CHECK = 80;

export const isOnline = (now = Date.now()) => now - getState().last_seen < OFFLINE_AFTER_MS;

/** Leitura nos extremos do ADC = sensor desconectado/em curto. Nunca regar com base nela. */
export const sensorFault = (raw: number) => raw <= 50 || raw >= 4090;

/** Número de leituras usadas na mediana: remove picos e oscilações curtas do sensor. */
export const SMOOTH_N = 9;

/** Mediana das últimas N leituras brutas, incluindo a atual. Chamar ANTES de gravar a leitura atual. */
export function smoothedRaw(current: number, n = SMOOTH_N): number {
  const rows = db.query("SELECT soil_raw FROM telemetry ORDER BY id DESC LIMIT ?").all(n - 1) as { soil_raw: number }[];
  const vals = [current, ...rows.map((r) => r.soil_raw)].sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]!;
}

/** Converte leitura ADC bruta em % (0 = seco, 100 = encharcado). Sensores capacitivos: valor alto = seco. */
export function rawToPercent(raw: number, dry: number, wet: number): number {
  if (dry === wet) return 0;
  const pct = ((dry - raw) / (dry - wet)) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/** Minutos desde 00:00 no fuso do servidor. */
const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Janela de horário da rega automática. Aceita janelas que cruzam a meia-noite (ex.: 22:00–05:00). */
export function inWindow(cfg: Pick<Config, "window_enabled" | "window_start_min" | "window_end_min">, d = new Date()) {
  if (!cfg.window_enabled) return true;
  const m = minutesOfDay(d), a = cfg.window_start_min, b = cfg.window_end_min;
  if (a === b) return true;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** A rega automática está liberada agora? (ligada, não pausada por falha e dentro da janela) */
export function autoAllowed(now = Date.now()) {
  const cfg = getConfig();
  return !!cfg.auto_mode && !getState().auto_paused && inWindow(cfg, new Date(now));
}

export function isRunning(now = Date.now()) {
  const s = getState();
  return s.event_id !== null && s.pump_until > now;
}

function finish(status: IrrigationEvent["status"], now: number) {
  const s = getState();
  if (s.event_id === null) return;
  db.run("UPDATE irrigation_events SET status=?, ended_at=? WHERE id=? AND status='RUNNING'", [status, now, s.event_id]);
  db.run("UPDATE state SET pump_until=0, event_id=NULL WHERE id=1");
}

export type StartResult =
  | { ok: true; eventId: number; durationSec: number }
  | { ok: false; reason: "NO_WATER" | "OFFLINE" | "ALREADY_RUNNING" };

export function startIrrigation(trigger: "AUTO" | "MANUAL", requestedSec?: number, now = Date.now()): StartResult {
  const cfg = getConfig();
  tick(now);
  if (isRunning(now)) return { ok: false, reason: "ALREADY_RUNNING" };
  if (!isOnline(now)) return { ok: false, reason: "OFFLINE" };
  if (!latestTelemetry()?.water_ok) return { ok: false, reason: "NO_WATER" };

  const durationSec = Math.min(requestedSec ?? cfg.duration_sec, cfg.max_run_sec);
  const r = db.run(
    "INSERT INTO irrigation_events (trigger, planned_sec, status, started_at, moisture_before) VALUES (?,?, 'RUNNING', ?, ?)",
    [trigger, durationSec, now, latestTelemetry()?.soil_percent ?? null],
  );
  const eventId = Number(r.lastInsertRowid);
  db.run("UPDATE state SET pump_until=?, event_id=? WHERE id=1", [now + durationSec * 1000, eventId]);
  return { ok: true, eventId, durationSec };
}

export function stopIrrigation(now = Date.now()): boolean {
  const was = getState().event_id !== null;
  finish("STOPPED", now);
  return was;
}

/** Fecha regas expiradas e corta a bomba se faltar água. Chamado a cada segundo e a cada telemetria. */
export function tick(now = Date.now()) {
  const s = getState();
  if (s.event_id === null) return;
  const tel = latestTelemetry();
  if (tel && !tel.water_ok) return finish("CANCELLED_NO_WATER", now);
  if (s.pump_until <= now) finish("COMPLETED", now);
}

export interface TelemetryInput { soil_raw: number; water_ok: boolean; pump_on: boolean }

/** Grava a leitura, avalia a rega automática e devolve o comando para o ESP32. */
export function ingestTelemetry(input: TelemetryInput, now = Date.now()) {
  const cfg = getConfig();
  const smooth = smoothedRaw(input.soil_raw);          // mediana: base para % e para decisões
  const percent = rawToPercent(smooth, cfg.dry_raw, cfg.wet_raw);
  db.run(
    "INSERT INTO telemetry (soil_raw, soil_percent, water_ok, pump_on, created_at) VALUES (?,?,?,?,?)",
    [input.soil_raw, percent, input.water_ok ? 1 : 0, input.pump_on ? 1 : 0, now],
  );
  db.run("UPDATE state SET last_seen=? WHERE id=1", [now]);
  tick(now);

  if (autoAllowed(now) && !sensorFault(smooth) && !isRunning(now) && percent < cfg.min_moisture && input.water_ok) {
    const last = db.query(
      "SELECT started_at FROM irrigation_events WHERE trigger='AUTO' ORDER BY id DESC LIMIT 1",
    ).get() as { started_at: number } | null;
    if (!last || now - last.started_at >= cfg.cooldown_sec * 1000) startIrrigation("AUTO", undefined, now);
  }

  return command(now);
}

/** Comando que o ESP32 deve obedecer. O firmware ainda aplica seus próprios limites de segurança. */
export function command(now = Date.now()) {
  const cfg = getConfig();
  const s = getState();
  const remaining = s.event_id !== null ? Math.max(0, Math.ceil((s.pump_until - now) / 1000)) : 0;
  // O ESP32 guarda esta configuração em flash para continuar regando sozinho se o servidor cair.
  return {
    pump: remaining > 0,
    remaining_sec: remaining,
    max_run_sec: cfg.max_run_sec,
    // Efetivo: vira false fora da janela ou com a rega pausada. O firmware já guarda este campo, então o
    // modo autônomo do ESP32 respeita a mesma regra sem alteração no firmware.
    auto_mode: autoAllowed(now),
    auto_paused: !!s.auto_paused,
    min_moisture: cfg.min_moisture,
    duration_sec: cfg.duration_sec,
    cooldown_sec: cfg.cooldown_sec,
    dry_raw: cfg.dry_raw,
    wet_raw: cfg.wet_raw,
  };
}

/**
 * Mede se cada rega concluída realmente elevou a umidade. Depois de FAULT_STREAK regas seguidas sem efeito
 * (bomba entupida/sem água na mangueira/sensor solto), pausa a rega automática. Uma rega eficaz (ex.: manual
 * depois do conserto) retira a pausa.
 */
export function checkEffectiveness(now = Date.now(), settleMs = SETTLE_MS) {
  const pending = db.query(
    "SELECT * FROM irrigation_events WHERE status='COMPLETED' AND checked=0 AND ended_at + ? <= ? ORDER BY id",
  ).all(settleMs, now) as IrrigationEvent[];

  for (const ev of pending) {
    const after = db.query(
      "SELECT MAX(soil_percent) AS m FROM telemetry WHERE created_at >= ? AND created_at <= ?",
    ).get(ev.ended_at!, now) as { m: number | null };
    const before = ev.moisture_before;
    let effective: number | null = null;
    if (after.m !== null && before !== null && before < MAX_BEFORE_FOR_CHECK) {
      effective = after.m - before >= MIN_RISE ? 1 : 0;
    }
    db.run("UPDATE irrigation_events SET checked=1, moisture_after=?, effective=? WHERE id=?", [after.m, effective, ev.id]);

    if (effective === 1) db.run("UPDATE state SET auto_paused=0 WHERE id=1");
    if (effective === 0) {
      const last = db.query(
        "SELECT effective FROM irrigation_events WHERE checked=1 AND effective IS NOT NULL ORDER BY id DESC LIMIT ?",
      ).all(FAULT_STREAK) as { effective: number }[];
      if (last.length === FAULT_STREAK && last.every((e) => e.effective === 0)) {
        db.run("UPDATE state SET auto_paused=1 WHERE id=1");
      }
    }
  }
  return pending.length;
}

/** Retoma manualmente a rega automática depois de uma pausa por falha. */
export function resumeAuto() {
  db.run("UPDATE state SET auto_paused=0 WHERE id=1");
}
