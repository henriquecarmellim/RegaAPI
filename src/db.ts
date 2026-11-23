import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env";

if (env.dbPath !== ":memory:") mkdirSync(dirname(env.dbPath), { recursive: true });
export const db = new Database(env.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS telemetry (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  soil_raw     INTEGER NOT NULL,
  soil_percent REAL    NOT NULL,
  water_ok     INTEGER NOT NULL,
  pump_on      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry(created_at);

CREATE TABLE IF NOT EXISTS irrigation_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT    NOT NULL CHECK (trigger IN ('AUTO','MANUAL')),
  planned_sec INTEGER NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('RUNNING','COMPLETED','STOPPED','CANCELLED_NO_WATER')),
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  auto_mode        INTEGER NOT NULL DEFAULT 1,
  min_moisture     REAL    NOT NULL DEFAULT 35,   -- % abaixo do qual a rega automática dispara
  duration_sec     INTEGER NOT NULL DEFAULT 20,
  cooldown_sec     INTEGER NOT NULL DEFAULT 600,  -- intervalo mínimo entre regas automáticas
  max_run_sec      INTEGER NOT NULL DEFAULT 120,  -- limite absoluto de funcionamento da bomba
  dry_raw          INTEGER NOT NULL DEFAULT 3200, -- leitura ADC com sensor no ar/solo seco (0%)
  wet_raw          INTEGER NOT NULL DEFAULT 1200  -- leitura ADC com sensor na água (100%)
);
INSERT OR IGNORE INTO config (id) VALUES (1);

-- Estado atual do dispositivo e da bomba (linha única)
CREATE TABLE IF NOT EXISTS state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen    INTEGER NOT NULL DEFAULT 0,
  pump_until   INTEGER NOT NULL DEFAULT 0,  -- ms epoch; bomba deve ficar ligada até este instante
  event_id     INTEGER                       -- evento RUNNING atual
);
INSERT OR IGNORE INTO state (id) VALUES (1);
`);

// ---- Migrações (idempotentes) para bancos criados em versões anteriores ----
function addColumn(table: string, col: string, def: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn("config", "flow_lpm", "REAL NOT NULL DEFAULT 0");               // vazão da bomba (L/min); 0 = não informado
addColumn("config", "window_enabled", "INTEGER NOT NULL DEFAULT 0");      // janela de horário da rega automática
addColumn("config", "window_start_min", "INTEGER NOT NULL DEFAULT 360");   // minutos desde 00:00 (360 = 06:00)
addColumn("config", "window_end_min", "INTEGER NOT NULL DEFAULT 540");    // 540 = 09:00
addColumn("irrigation_events", "moisture_before", "REAL");
addColumn("irrigation_events", "moisture_after", "REAL");
addColumn("irrigation_events", "effective", "INTEGER");                    // 1 = umidade subiu, 0 = não subiu, NULL = inconclusivo
addColumn("irrigation_events", "checked", "INTEGER NOT NULL DEFAULT 0");
addColumn("state", "auto_paused", "INTEGER NOT NULL DEFAULT 0");          // 1 = rega automática pausada por suspeita de falha

db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(kind, resolved_at);
`);

export interface Config {
  auto_mode: number; min_moisture: number; duration_sec: number; cooldown_sec: number;
  max_run_sec: number; dry_raw: number; wet_raw: number;
  flow_lpm: number; window_enabled: number; window_start_min: number; window_end_min: number;
}
export interface State { last_seen: number; pump_until: number; event_id: number | null; auto_paused: number }
export interface Telemetry {
  id: number; soil_raw: number; soil_percent: number; water_ok: number; pump_on: number; created_at: number;
}
export interface IrrigationEvent {
  id: number; trigger: "AUTO" | "MANUAL"; planned_sec: number;
  status: "RUNNING" | "COMPLETED" | "STOPPED" | "CANCELLED_NO_WATER";
  started_at: number; ended_at: number | null;
  moisture_before: number | null; moisture_after: number | null; effective: number | null; checked: number;
}
export interface Alert { id: number; kind: string; message: string; created_at: number; resolved_at: number | null }

export const getConfig = () => db.query("SELECT * FROM config WHERE id=1").get() as Config & { id: number };
export const getState = () => db.query("SELECT * FROM state WHERE id=1").get() as State & { id: number };
export const latestTelemetry = () =>
  db.query("SELECT * FROM telemetry ORDER BY id DESC LIMIT 1").get() as Telemetry | null;

export function pruneTelemetry(days = 30) {
  db.run("DELETE FROM telemetry WHERE created_at < ?", [Date.now() - days * 86_400_000]);
}
