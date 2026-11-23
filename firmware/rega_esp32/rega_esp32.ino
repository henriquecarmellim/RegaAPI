// RegaAPI — firmware ESP32 (Arduino ou PlatformIO). Ver docs/DATASHEET.md para ligação e protocolo.
//
// Arquitetura (duas partes, para a segurança não depender da rede):
//   loop()      checa boia e prazo da bomba a cada 20 ms. Nunca faz rede nem espera.
//   netTask()   Wi-Fi, envio de telemetria (conexão mantida), leitura do sensor e modo autônomo.
//               Pode demorar o quanto precisar: o loop continua cortando a bomba no tempo certo.
//
// Operação automática:
//   ONLINE      servidor decide a rega e devolve comando + configuração (guardada em flash).
//   AUTÔNOMO    sem resposta do servidor por SERVER_LOST_AFTER_MS, rega sozinho com a última configuração.
// Segurança local (sempre ativa):
//   - boia sem água => bomba desliga na hora e não liga;
//   - bomba só liga com autorização que expira (rede caiu => expira sozinha);
//   - limite absoluto de funcionamento contínuo (HARD_MAX_RUN_MS);
//   - sensor desconectado (ADC nos extremos) nunca dispara rega;
//   - relé inicia desligado; watchdog reinicia o ESP32 se o loop travar.

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include "config.h"

#ifndef DEBUG_SERIAL
#define DEBUG_SERIAL 0
#endif

// ===== Configuração de rega (espelho do servidor, guardada em flash) =====
struct RegaConfig {
  bool  autoMode    = true;
  float minMoisture = 35;
  int   durationSec = 20;
  int   cooldownSec = 600;
  int   maxRunSec   = 120;
  int   dryRaw      = 3200;
  int   wetRaw      = 1200;
} cfg;
Preferences prefs;

// ===== Estado do loop de segurança =====
volatile bool pumpOn = false;
unsigned long pumpStartedAt = 0;
volatile bool waterOk = false;
bool floatRaw = false;
unsigned long floatChangedAt = 0;

// ===== Autorização da bomba: escrita pela tarefa de rede, lida pelo loop =====
portMUX_TYPE authMux = portMUX_INITIALIZER_UNLOCKED;
bool authOn = false;
unsigned long authUntil = 0;

void grantPump(unsigned long ms) {
  portENTER_CRITICAL(&authMux);
  authOn = true;
  authUntil = millis() + ms;
  portEXIT_CRITICAL(&authMux);
}
void revokePump() {
  portENTER_CRITICAL(&authMux);
  authOn = false;
  portEXIT_CRITICAL(&authMux);
}
bool pumpGranted() {
  portENTER_CRITICAL(&authMux);
  bool r = authOn && (long)(authUntil - millis()) > 0;
  portEXIT_CRITICAL(&authMux);
  return r;
}

// ===== Estado da tarefa de rede =====
unsigned long lastSend = 0;
unsigned long lastServerOk = 0;      // 0 = nunca respondeu
unsigned long lastLocalRunAt = 0;
bool          hadLocalRun = false;
unsigned long lastWifiTry = 0;
HTTPClient    http;                  // reaproveitado: mantém a conexão TCP entre envios

// ===== Sensor =====
int lastMed = 0, lastMin = 0, lastMax = 0;
float soilEma = -1;

// Mediana de 31 amostras: descarta picos rápidos (ruído do Wi-Fi, fonte, fio solto).
int readSoilRaw() {
  static int buf[31];
  for (int i = 0; i < 31; i++) { buf[i] = analogRead(PIN_SOIL); delayMicroseconds(400); }
  for (int i = 1; i < 31; i++) {
    int k = buf[i], j = i - 1;
    while (j >= 0 && buf[j] > k) { buf[j + 1] = buf[j]; j--; }
    buf[j + 1] = k;
  }
  lastMin = buf[0]; lastMax = buf[30]; lastMed = buf[15];
  return lastMed;
}

// Filtro exponencial sobre a mediana (só a tarefa de rede chama).
int soilSmoothed() {
  int r = readSoilRaw();
  soilEma = (soilEma < 0) ? r : soilEma * 0.75f + r * 0.25f;
  return (int)lroundf(soilEma);
}

bool sensorFault(int raw) { return raw <= 50 || raw >= 4090; }

float rawToPercent(int raw) {
  if (cfg.dryRaw == cfg.wetRaw) return 0;
  float p = (float)(cfg.dryRaw - raw) / (cfg.dryRaw - cfg.wetRaw) * 100.0f;
  return p < 0 ? 0 : (p > 100 ? 100 : p);
}

// ===== Relé e boia (loop) =====
void relayWrite(bool on) { digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }

void setPump(bool on) {
  if (on == pumpOn) return;
  pumpOn = on;
  relayWrite(on);
  if (on) pumpStartedAt = millis();
  Serial.printf("[bomba] %s\n", on ? "LIGADA" : "desligada");
}

void readFloat() {
  bool now = (digitalRead(PIN_FLOAT) == FLOAT_LEVEL_WHEN_WATER);
  if (now != floatRaw) { floatRaw = now; floatChangedAt = millis(); }
  if (millis() - floatChangedAt >= FLOAT_DEBOUNCE_MS) waterOk = floatRaw;
  if (!floatRaw) waterOk = false;       // falta de água: corte imediato
}

// Regras de segurança: bomba só com água, autorização válida e dentro do limite físico.
void enforceSafety() {
  bool allowed = waterOk && pumpGranted() && (!pumpOn || millis() - pumpStartedAt < HARD_MAX_RUN_MS);
  if (!allowed) revokePump();
  setPump(allowed);
}

// ===== Configuração em flash (tarefa de rede e setup) =====
void loadConfig() {
  prefs.begin("rega", false);
  cfg.autoMode    = prefs.getBool("auto", true);
  cfg.minMoisture = prefs.getFloat("minM", cfg.minMoisture);
  cfg.durationSec = prefs.getInt("dur", cfg.durationSec);
  cfg.cooldownSec = prefs.getInt("cool", cfg.cooldownSec);
  cfg.maxRunSec   = prefs.getInt("max", cfg.maxRunSec);
  cfg.dryRaw      = prefs.getInt("dry", cfg.dryRaw);
  cfg.wetRaw      = prefs.getInt("wet", cfg.wetRaw);
  prefs.end();
}
void saveConfigIfChanged(const RegaConfig& n) {
  bool changed = n.autoMode != cfg.autoMode || n.minMoisture != cfg.minMoisture || n.durationSec != cfg.durationSec ||
                 n.cooldownSec != cfg.cooldownSec || n.maxRunSec != cfg.maxRunSec || n.dryRaw != cfg.dryRaw || n.wetRaw != cfg.wetRaw;
  cfg = n;
  if (!changed) return;                 // evita desgaste da flash
  prefs.begin("rega", false);
  prefs.putBool("auto", n.autoMode); prefs.putFloat("minM", n.minMoisture); prefs.putInt("dur", n.durationSec);
  prefs.putInt("cool", n.cooldownSec); prefs.putInt("max", n.maxRunSec); prefs.putInt("dry", n.dryRaw); prefs.putInt("wet", n.wetRaw);
  prefs.end();
  Serial.println("[cfg] configuração atualizada e salva");
}

// ===== Rede (tarefa) =====
void wifiKeepAlive() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastWifiTry && millis() - lastWifiTry < 10000) return;
  lastWifiTry = millis();
  Serial.println("[wifi] conectando...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

double jsonNum(const String& body, const char* key, double def) {
  int i = body.indexOf(String("\"") + key + "\":");
  if (i < 0) return def;
  return body.substring(i + strlen(key) + 3).toDouble();
}
bool jsonBool(const String& body, const char* key, bool def) {
  int i = body.indexOf(String("\"") + key + "\":");
  if (i < 0) return def;
  return body.startsWith("true", i + strlen(key) + 3);
}

void sendTelemetry(int raw) {
  if (WiFi.status() != WL_CONNECTED) return;
  http.setReuse(true);
  http.setConnectTimeout(1500);
  http.setTimeout(2500);
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  String payload = String("{\"soil_raw\":") + raw + ",\"water_ok\":" + (waterOk ? "true" : "false") +
                   ",\"pump_on\":" + (pumpOn ? "true" : "false") + "}";
  int code = http.POST(payload);
  if (code == 200) {
    String body = http.getString();
    lastServerOk = millis();
    if (lastServerOk == 0) lastServerOk = 1;
    RegaConfig n = cfg;
    n.autoMode    = jsonBool(body, "auto_mode", cfg.autoMode);
    n.minMoisture = jsonNum(body, "min_moisture", cfg.minMoisture);
    n.durationSec = jsonNum(body, "duration_sec", cfg.durationSec);
    n.cooldownSec = jsonNum(body, "cooldown_sec", cfg.cooldownSec);
    n.maxRunSec   = jsonNum(body, "max_run_sec", cfg.maxRunSec);
    n.dryRaw      = jsonNum(body, "dry_raw", cfg.dryRaw);
    n.wetRaw      = jsonNum(body, "wet_raw", cfg.wetRaw);
    if (n.dryRaw > n.wetRaw) saveConfigIfChanged(n);     // ignora config inválida
    long remaining = (long)jsonNum(body, "remaining_sec", 0);
    if (jsonBool(body, "pump", false) && remaining > 0) grantPump((unsigned long)remaining * 1000UL);
    else revokePump();
  } else {
    Serial.printf("[http] erro %d (%s)\n", code, HTTPClient::errorToString(code).c_str());
    http.end();          // conexão reaproveitada pode ter caído: fecha e reabre no próximo envio
    return;
  }
}

// Modo autônomo: sem servidor por muito tempo, rega com a última configuração salva.
void autonomousStep(int raw) {
  bool serverLost = (lastServerOk == 0) ? (millis() > SERVER_LOST_AFTER_MS) : (millis() - lastServerOk > SERVER_LOST_AFTER_MS);
  if (!serverLost || !cfg.autoMode || pumpOn || !waterOk || pumpGranted()) return;
  if (hadLocalRun && millis() - lastLocalRunAt < (unsigned long)cfg.cooldownSec * 1000UL) return;
  if (sensorFault(raw)) return;
  if (rawToPercent(raw) < cfg.minMoisture) {
    int dur = min(cfg.durationSec, (int)(HARD_MAX_RUN_MS / 1000));
    grantPump((unsigned long)dur * 1000UL);
    hadLocalRun = true; lastLocalRunAt = millis();
    Serial.printf("[autônomo] solo %.0f%% < %.0f%% => regando %ds\n", rawToPercent(raw), cfg.minMoisture, dur);
  }
}

void netTask(void*) {
  for (;;) {
    wifiKeepAlive();
    if (millis() - lastSend >= SEND_INTERVAL_MS) {
      lastSend = millis();
      int v = soilSmoothed();
      sendTelemetry(v);
      autonomousStep(v);
#if DEBUG_SERIAL
      Serial.printf("[sensor] suave=%d (%.0f%%) faixa=%d..%d | boia=%s | bomba=%s\n", v, rawToPercent(v), lastMin, lastMax,
                    waterOk ? "COM agua" : "SEM agua", pumpOn ? "ON" : "off");
#endif
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

void setup() {
  digitalWrite(PIN_RELAY, RELAY_ACTIVE_LOW ? HIGH : LOW);   // desligado antes de virar saída
  pinMode(PIN_RELAY, OUTPUT);
  relayWrite(false);
  pinMode(PIN_FLOAT, INPUT_PULLUP);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  Serial.begin(115200);
  loadConfig();
  floatRaw = (digitalRead(PIN_FLOAT) == FLOAT_LEVEL_WHEN_WATER);
  floatChangedAt = millis();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t w = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&w);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);                                   // watchdog cobre o loop de segurança
  xTaskCreatePinnedToCore(netTask, "rega-net", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  esp_task_wdt_reset();
  readFloat();
  enforceSafety();
  delay(20);
}
