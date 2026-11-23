// Simula o ESP32: bun run mock [url]   (usa ESP32_TOKEN do .env)
const url = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 3000}`;
let raw = 3000, water = true, pump = false;
console.log("Mock ESP32 →", url, "(teclas: w = alterna boia, ctrl+c sai)");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (d) => { if (d[0] === 3) process.exit(); if (d.toString() === "w") { water = !water; console.log("boia:", water); } });

setInterval(async () => {
  raw = pump ? Math.max(1200, raw - 120) : Math.min(3200, raw + 15); // molha com a bomba, seca devagar
  const res = await fetch(`${url}/api/device/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": process.env.ESP32_TOKEN! },
    body: JSON.stringify({ soil_raw: raw, water_ok: water, pump_on: pump }),
  });
  const cmd = (await res.json()) as any;
  pump = !!cmd.pump && water;
  console.log(`raw=${raw} água=${water} → bomba=${pump ? "ON" : "off"} (${cmd.remaining_sec ?? 0}s)`);
}, 2000);
