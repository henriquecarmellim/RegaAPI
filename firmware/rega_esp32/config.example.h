#pragma once
// ===== EDITE AQUI =====
#define WIFI_SSID     "SEU_WIFI"
#define WIFI_PASS     "SUA_SENHA"
#define SERVER_URL    "http://192.168.0.10:3000/api/device/telemetry"  // IP do PC/servidor rodando a API
#define DEVICE_TOKEN  "COLE_AQUI_O_ESP32_TOKEN_DO_.env"

// Pinos
#define PIN_SOIL   34   // ADC1 (não use ADC2: não funciona com Wi-Fi)
#define PIN_FLOAT  27   // boia entre o pino e GND (pull-up interno)
#define PIN_RELAY  26

// Boia: nível do pino quando HÁ ÁGUA (boia que fecha contato ao subir => LOW). Inverta se necessário.
#define FLOAT_LEVEL_WHEN_WATER  LOW
// Módulo relé comum é "ativo em LOW". Se o seu liga com HIGH, use false.
#define RELAY_ACTIVE_LOW        true

// Tempos
#define SEND_INTERVAL_MS        3000UL
#define HARD_MAX_RUN_MS         120000UL  // limite absoluto local de bomba contínua
#define FLOAT_DEBOUNCE_MS       1000UL
#define SERVER_LOST_AFTER_MS    60000UL   // sem resposta do servidor por isso => modo autônomo
#define WDT_TIMEOUT_S           15

// Diagnóstico: 1 = imprime leitura do sensor a cada envio (serial 115200); 0 = silencioso
#define DEBUG_SERIAL            1
