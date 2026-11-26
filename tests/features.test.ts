import { test, expect, beforeEach } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.ESP32_TOKEN = "t"; process.env.SESSION_SECRET = "s";
process.env.ADMIN_USER = "u"; process.env.ADMIN_PASS = "p";

const { db } = await import("../src/db");
const irr = await import("../src/irrigation");
const al = await import("../src/alerts");


const tel = (raw: number, water: boolean, now: number) =>
  irr.ingestTelemetry({ soil_raw: raw, water_ok: water, pump_on: false }, now);
const rowsOf = (kind: string) => db.query("SELECT * FROM alerts WHERE kind=?").all(kind) as any[];

beforeEach(() => {
  for (const t of ["telemetry", "irrigation_events", "alerts"]) db.run(`DELETE FROM ${t}`);
  db.run("UPDATE state SET last_seen=0, pump_until=0, event_id=NULL, auto_paused=0");
  db.run(`UPDATE config SET auto_mode=1, min_moisture=35, duration_sec=20, cooldown_sec=600, max_run_sec=120,
          window_enabled=0, window_start_min=360, window_end_min=540, flow_lpm=0`);
});

const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m).getTime();

// ---------- Janela de horário ----------
test("janela normal 06:00–09:00", () => {
  const w = { window_enabled: 1, window_start_min: 360, window_end_min: 540 };
  expect(irr.inWindow(w, new Date(at(5, 59)))).toBe(false);
  expect(irr.inWindow(w, new Date(at(6, 0)))).toBe(true);
  expect(irr.inWindow(w, new Date(at(8, 59)))).toBe(true);
  expect(irr.inWindow(w, new Date(at(9, 0)))).toBe(false);
});

test("janela que cruza a meia-noite 22:00–05:00", () => {
  const w = { window_enabled: 1, window_start_min: 1320, window_end_min: 300 };
  expect(irr.inWindow(w, new Date(at(23)))).toBe(true);
  expect(irr.inWindow(w, new Date(at(2)))).toBe(true);
  expect(irr.inWindow(w, new Date(at(12)))).toBe(false);
});

test("janela desligada libera sempre", () => {
  expect(irr.inWindow({ window_enabled: 0, window_start_min: 0, window_end_min: 1 }, new Date(at(12)))).toBe(true);
});

test("fora da janela não rega sozinho, mas manual funciona; ESP32 recebe auto_mode=false", () => {
  db.run("UPDATE config SET window_enabled=1, window_start_min=360, window_end_min=540");
  const noon = at(12);
  const cmd = tel(3000, true, noon);
  expect(cmd.pump).toBe(false);
  expect(cmd.auto_mode).toBe(false);
  expect(irr.startIrrigation("MANUAL", 5, noon).ok).toBe(true);
  db.run("DELETE FROM irrigation_events"); db.run("UPDATE state SET pump_until=0, event_id=NULL");
  const morning = at(7);
  const c2 = tel(3000, true, morning);
  expect(c2.auto_mode).toBe(true);
  expect(c2.pump).toBe(true);
});

// ---------- Eficácia / bomba com defeito ----------
/** Roda uma rega automática; as leituras seguintes mostram a umidade informada. */
const seedRows = (raw: number, n: number, from: number) => {
  for (let i = 0; i < n; i++)
    db.run("INSERT INTO telemetry (soil_raw, soil_percent, water_ok, pump_on, created_at) VALUES (?,?,1,0,?)",
      [raw, irr.rawToPercent(raw, 3200, 1200), from + i * 3000]);
};
/** Seco por ~27 s antes (mediana seca), rega, depois 9 leituras pós-rega com rawAfter (mediana acompanha). */
function cycle(t0: number, rawAfter: number) {
  seedRows(3000, 9, t0 - 27_000);
  const cmd = tel(3000, true, t0);                 // ~10% => dispara
  expect(cmd.pump).toBe(true);
  irr.tick(t0 + 21_000);                           // conclui
  for (let i = 0; i < 9; i++) tel(rawAfter, true, t0 + 30_000 + i * 3000);
  irr.checkEffectiveness(t0 + 21_000 + irr.SETTLE_MS + 1);
}

test("rega eficaz é marcada como eficaz", () => {
  cycle(1_000_000, 1500);                          // sobe para ~85%
  const ev = db.query("SELECT * FROM irrigation_events").get() as any;
  expect(ev.checked).toBe(1);
  expect(ev.effective).toBe(1);
  expect(ev.moisture_after).toBeGreaterThan(ev.moisture_before + 3);
});

test("3 regas seguidas sem efeito pausam o automático e abrem alerta", async () => {
  for (let i = 0; i < 3; i++) cycle(1_000_000 + i * 1_000_000, 3000);   // umidade não sobe
  expect(db.query("SELECT COUNT(*) c FROM irrigation_events WHERE effective=0").get()).toEqual({ c: 3 });
  expect((irr as any).autoAllowed(9_000_000)).toBe(false);
  expect(tel(3000, true, 9_000_000).pump).toBe(false);                   // não rega mais
  expect(tel(3000, true, 9_000_001).auto_mode).toBe(false);              // ESP32 também é avisado
  await al.evaluateAlerts(9_000_000);
  expect(rowsOf("PUMP_FAULT").length).toBe(1);
});

test("2 falhas não pausam; uma rega eficaz zera a sequência", () => {
  cycle(1_000_000, 3000); cycle(2_000_000, 3000);
  expect(irr.autoAllowed(3_000_000)).toBe(true);
  cycle(3_000_000, 1500);
  cycle(4_000_000, 3000); cycle(5_000_000, 3000);
  expect(irr.autoAllowed(6_000_000)).toBe(true);
});

test("retomar libera o automático e resolve o alerta", async () => {
  db.run("UPDATE state SET auto_paused=1");
  await al.evaluateAlerts(1000);
  expect(rowsOf("PUMP_FAULT").length).toBe(1);
  irr.resumeAuto();
  await al.evaluateAlerts(2000);
  expect(rowsOf("PUMP_FAULT")[0].resolved_at).toBe(2000);
});

test("solo já úmido antes da rega = inconclusivo (não conta como falha)", () => {
  db.run("UPDATE config SET min_moisture=95");
  cycle(1_000_000, 1500);                                                 // antes ~10%? força: reescreve before
  db.run("UPDATE irrigation_events SET effective=NULL, checked=0, moisture_before=90");
  irr.checkEffectiveness(10_000_000);
  expect((db.query("SELECT effective FROM irrigation_events").get() as any).effective).toBeNull();
});

// ---------- Alertas ----------
test("ESP32 offline: alerta uma única vez, e resolve ao voltar", async () => {
  tel(2000, true, 1_000_000);
  await al.evaluateAlerts(1_000_000 + 4 * 60_000);
  expect(rowsOf("DEVICE_OFFLINE").length).toBe(0);
  await al.evaluateAlerts(1_000_000 + 6 * 60_000);
  await al.evaluateAlerts(1_000_000 + 7 * 60_000);                        // repetição não duplica
  expect(rowsOf("DEVICE_OFFLINE").length).toBe(1);
  tel(2000, true, 1_000_000 + 8 * 60_000);
  await al.evaluateAlerts(1_000_000 + 8 * 60_000);
  expect(rowsOf("DEVICE_OFFLINE")[0].resolved_at).not.toBeNull();
});

test("nunca conectou => sem alerta de offline", async () => {
  await al.evaluateAlerts(99_999_999);
  expect(rowsOf("DEVICE_OFFLINE").length).toBe(0);
});

test("reservatório sem água >10 min gera alerta; volta a ter água resolve", async () => {
  tel(2000, true, 1_000_000);
  tel(2000, false, 1_000_000 + 60_000);
  await al.evaluateAlerts(1_000_000 + 5 * 60_000);
  expect(rowsOf("NO_WATER").length).toBe(0);
  tel(2000, false, 1_000_000 + 12 * 60_000);
  await al.evaluateAlerts(1_000_000 + 12 * 60_000);
  expect(rowsOf("NO_WATER").length).toBe(1);
  tel(2000, true, 1_000_000 + 13 * 60_000);
  await al.evaluateAlerts(1_000_000 + 13 * 60_000);
  expect(rowsOf("NO_WATER")[0].resolved_at).not.toBeNull();
});

test("leitura no extremo do ADC não gera alerta de sensor com defeito", async () => {
  tel(4095, true, 1_000_000);
  await al.evaluateAlerts(1_000_000);
  expect(rowsOf("SENSOR_FAULT").length).toBe(0);
});

test("solo seco por 3 h gera alerta", async () => {
  db.run("UPDATE config SET auto_mode=1");
  const t0 = 1_000_000;
  for (let i = 0; i <= 36; i++) irr.ingestTelemetry({ soil_raw: 3100, water_ok: false, pump_on: false }, t0 + i * 5 * 60_000);
  await al.evaluateAlerts(t0 + 36 * 5 * 60_000);
  expect(rowsOf("DRY_LONG").length).toBe(1);
});

test("rega em excesso (>=10 em 24h) gera alerta", async () => {
  for (let i = 0; i < 10; i++)
    db.run("INSERT INTO irrigation_events (trigger,planned_sec,status,started_at,ended_at) VALUES ('AUTO',5,'COMPLETED',?,?)", [1_000_000 + i, 1_005_000 + i]);
  tel(2000, true, 1_100_000);
  await al.evaluateAlerts(1_100_000);
  expect(rowsOf("EXCESS_WATERING").length).toBe(1);
});


// ---------- Normalização da umidade ----------
test("pico isolado de sensor não dispara rega nem alerta de defeito", () => {
  seedRows(1500, 8, 1_000_000);                              // úmido
  const spike = tel(3900, true, 1_030_000);                  // um pico "seco" de uma leitura
  expect(spike.pump).toBe(false);
  expect(irr.sensorFault(irr.smoothedRaw(4095))).toBe(false); // pico de defeito isolado não conta
  const last = db.query("SELECT soil_percent FROM telemetry ORDER BY id DESC LIMIT 1").get() as any;
  expect(last.soil_percent).toBeGreaterThan(60);             // exibição continua úmida
});

test("mudança real de umidade aparece depois da janela da mediana", () => {
  seedRows(3000, 9, 1_000_000);                              // seco
  for (let i = 0; i < 9; i++) db.run("INSERT INTO telemetry (soil_raw, soil_percent, water_ok, pump_on, created_at) VALUES (1500,85,1,0,?)", [2_000_000 + i * 3000]);
  expect(irr.smoothedRaw(1500)).toBe(1500);
});
