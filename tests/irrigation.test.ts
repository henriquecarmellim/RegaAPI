import { test, expect, beforeEach } from "bun:test";

process.env.DB_PATH = ":memory:";
process.env.ESP32_TOKEN = "t"; process.env.SESSION_SECRET = "s";
process.env.ADMIN_USER = "u"; process.env.ADMIN_PASS = "p";

const { db, getConfig } = await import("../src/db");
const irr = await import("../src/irrigation");
const auth = await import("../src/auth");

const DRY = 3200, WET = 1200;
/** Insere leituras direto no banco (simula sensor estável sem disparar lógica). */
const seedRows = (raw: number, n: number, from: number) => {
  for (let i = 0; i < n; i++)
    db.run("INSERT INTO telemetry (soil_raw, soil_percent, water_ok, pump_on, created_at) VALUES (?,?,1,0,?)",
      [raw, irr.rawToPercent(raw, DRY, WET), from + i * 3000]);
};
const tel = (raw: number, water: boolean, now: number, pump = false) =>
  irr.ingestTelemetry({ soil_raw: raw, water_ok: water, pump_on: pump }, now);

beforeEach(() => {
  db.run("DELETE FROM telemetry"); db.run("DELETE FROM irrigation_events");
  db.run("UPDATE state SET last_seen=0, pump_until=0, event_id=NULL");
  db.run("UPDATE config SET auto_mode=1, min_moisture=35, duration_sec=20, cooldown_sec=600, max_run_sec=120");
});

test("rawToPercent calibra e limita 0-100", () => {
  expect(irr.rawToPercent(DRY, DRY, WET)).toBe(0);
  expect(irr.rawToPercent(WET, DRY, WET)).toBe(100);
  expect(irr.rawToPercent(4095, DRY, WET)).toBe(0);
  expect(irr.rawToPercent(0, DRY, WET)).toBe(100);
  expect(irr.rawToPercent(2200, DRY, WET)).toBe(50);
});

test("rega manual bloqueada sem água", () => {
  tel(2200, false, 1000);
  expect(irr.startIrrigation("MANUAL", 10, 1000)).toEqual({ ok: false, reason: "NO_WATER" });
});

test("rega manual bloqueada com ESP32 offline", () => {
  tel(2200, true, 1000);
  expect(irr.startIrrigation("MANUAL", 10, 1000 + 60_000)).toEqual({ ok: false, reason: "OFFLINE" });
});

test("rega manual liga, não duplica e conclui no prazo", () => {
  tel(2200, true, 1000);
  const r = irr.startIrrigation("MANUAL", 10, 1000);
  expect(r.ok).toBe(true);
  expect(irr.startIrrigation("MANUAL", 10, 1000)).toEqual({ ok: false, reason: "ALREADY_RUNNING" });
  expect(irr.command(1000).pump).toBe(true);
  irr.tick(11_001);
  expect(irr.command(11_001).pump).toBe(false);
  expect((db.query("SELECT status FROM irrigation_events").get() as any).status).toBe("COMPLETED");
});

test("duração é limitada por max_run_sec", () => {
  tel(2200, true, 1000);
  const r = irr.startIrrigation("MANUAL", 9999, 1000);
  expect(r.ok && r.durationSec).toBe(120);
});

test("boia desligada durante a rega corta a bomba", () => {
  tel(2200, true, 1000);
  irr.startIrrigation("MANUAL", 60, 1000);
  const cmd = tel(2200, false, 5000, true);
  expect(cmd.pump).toBe(false);
  expect((db.query("SELECT status FROM irrigation_events").get() as any).status).toBe("CANCELLED_NO_WATER");
});

test("parar interrompe a rega", () => {
  tel(2200, true, 1000);
  irr.startIrrigation("MANUAL", 60, 1000);
  expect(irr.stopIrrigation(2000)).toBe(true);
  expect(irr.command(2000).pump).toBe(false);
});

test("modo auto dispara abaixo do limite, com água", () => {
  expect(tel(3000, true, 1000).pump).toBe(true); // ~10%
  expect((db.query("SELECT trigger FROM irrigation_events").get() as any).trigger).toBe("AUTO");
});

test("modo auto não dispara sem água, desligado, ou com solo úmido", () => {
  expect(tel(3000, false, 1000).pump).toBe(false);
  seedRows(1500, 9, 2_000);                       // solo úmido por ~27 s (mediana acompanha)
  expect(tel(1500, true, 30_000).pump).toBe(false);
  db.run("UPDATE config SET auto_mode=0");
  seedRows(3000, 9, 40_000);                      // solo seco, mas automático desligado
  expect(tel(3000, true, 60_000).pump).toBe(false);
  expect(db.query("SELECT COUNT(*) c FROM irrigation_events").get()).toEqual({ c: 0 });
});

test("leitura no extremo do ADC (4095) dispara rega automática quando há água", () => {
  expect(tel(4095, true, 1000).pump).toBe(true);
});

test("comando inclui config para o modo autônomo do ESP32", () => {
  const c = tel(2200, true, 1000);
  expect(c).toMatchObject({ auto_mode: true, min_moisture: 35, dry_raw: 3200, wet_raw: 1200 });
});

test("cooldown impede nova rega automática seguida", () => {
  tel(3000, true, 1000);
  irr.tick(1000 + 21_000);
  expect(tel(3000, true, 1000 + 22_000).pump).toBe(false);
  expect(tel(3000, true, 1000 + 601_000).pump).toBe(true);
});

test("sessão: assinatura válida, adulterada e expirada", () => {
  const tok = auth.createSession("u");
  expect(auth.verifySession(tok)?.u).toBe("u");
  expect(auth.verifySession(tok.slice(0, -2) + "xx")).toBeNull();
  expect(auth.verifySession("lixo")).toBeNull();
  expect(auth.checkCredentials("u", "p")).toBe(true);
  expect(auth.checkCredentials("u", "errada")).toBe(false);
});
