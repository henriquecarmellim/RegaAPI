<div align="center">

# 🌱 RegaAPI

**Sistema de irrigação automática IoT com ESP32, API em Bun + SQLite e painel web em tempo real.**

[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org/)
[![Firmware: ESP32](https://img.shields.io/badge/Firmware-ESP32%20(C%2B%2B)-e7352c?logo=espressif&logoColor=fff)](firmware/rega_esp32/rega_esp32.ino)
[![Tests](https://img.shields.io/badge/Tests-32%20passing-2ea44f)](#testes)

</div>

---

O **RegaAPI** monitora a umidade do solo e o nível do reservatório em tempo real por meio de um **ESP32**, decide quando irrigar (manual ou automaticamente) com múltiplas camadas de segurança no servidor e no firmware, e disponibiliza um **painel web via WebSocket** com gráficos, histórico de regas, estimativa de litros e alertas inteligentes.

Se a conexão Wi-Fi ou o servidor cair, o ESP32 entra automaticamente em **modo autônomo** usando a última configuração salva na memória flash.

## ✨ Principais recursos

- **Backend 100% Bun sem dependências externas:** servidor HTTP, WebSocket nativo (`Bun.serve`) e persistência em SQLite (`bun:sqlite`).
- **Painel Web em Tempo Real:** atualização via `WebSocket /ws`, gráficos agregados (`1h`, `24h`, `7d`) com marcação das regas, consumo estimado em litros e calibração visual do sensor.
- **Modo Automático Inteligente:**
  - Disparo por limite de umidade, respeitando **cooldown**, **janela de horário** (inclusive cruzando a meia-noite, ex.: `22:00–05:00`) e nível de água.
  - **Detecção de falha na bomba/mangueira:** verifica 90 s após cada rega se a umidade subiu; após 3 regas seguidas sem efeito, pausa o modo automático e emite alerta até que o usuário retome.
- **Alertas com resolução automática:** ESP32 offline (`> 5 min`), reservatório sem água (`> 10 min`), sensor com defeito/desconectado, rega pausada por falha, solo seco por 3 h e excesso de regas em 24 h.
- **Segurança em duas camadas (Servidor + Firmware):**
  - Bloqueio imediato se a boia indicar reservatório vazio.
  - Tempo máximo contínuo de bomba (`max_run_sec`, limite rígido de `120 s` no firmware).
  - Filtro de mediana e detecção de leitura extrema de ADC (`<= 50` ou `>= 4090`).
  - Autenticação por cookie `HttpOnly` assinado (painel) e token `X-Device-Token` (ESP32).

## 🏗️ Arquitetura

```text
┌───────────────────────────┐         Wi-Fi / HTTP (3 s)         ┌─────────────────────────────┐
│           ESP32           │ ─────────────────────────────────► │      Servidor RegaAPI       │
│  • Sensor umidade (GPIO34)│ ◄───────────────────────────────── │  • Bun.serve + bun:sqlite   │
│  • Boia de nível (GPIO27) │    comando bomba + config efetiva  │  • Lógica de rega & alertas │
│  • Módulo relé   (GPIO26) │                                    │  • WebSocket /ws            │
│  • Modo autônomo em flash │                                    └──────────────┬──────────────┘
└───────────────────────────┘                                                   │
                                                                                ▼
                                                                 ┌─────────────────────────────┐
                                                                 │     Painel Web (Browser)    │
                                                                 │  • Gráficos e histórico     │
                                                                 │  • Controle manual & config │
                                                                 └─────────────────────────────┘
```

## 📁 Estrutura do projeto

```text
RegaAPI/
├── index.ts                 # Ponto de entrada (HTTP, WebSocket, loops de monitoramento)
├── src/
│   ├── alerts.ts            # Monitoramento de falhas, eficácia de regas e alertas
│   ├── auth.ts              # Sessão via cookie HttpOnly assinado e proteção de rotas
│   ├── db.ts                # Schema e consultas SQLite (telemetria, regas, config, alertas)
│   ├── env.ts               # Carregamento e validação de variáveis de ambiente
│   ├── irrigation.ts        # Regras de negócio, calibração, janela horária e segurança
│   ├── realtime.ts          # Publicação de estado via WebSocket (/ws)
│   └── routes.ts            # Endpoints REST da API e do dispositivo
├── public/                  # Interface web (dashboard, login e estilos)
├── firmware/
│   ├── platformio.ini       # Configuração PlatformIO para ESP32
│   └── rega_esp32/          # Código C++ (.ino) e config.example.h
├── scripts/
│   └── mock-device.ts       # Simulador de ESP32 no terminal para testes locais
├── tests/                   # Suíte de testes automatizados (bun test)
├── docs/                    # Datasheet técnico, esquemas e relatório do projeto
└── deploy/                  # Unit file systemd (rega-api.service)
```

## 🚀 Como executar

### Pré-requisitos

- [Bun](https://bun.sh) instalado (`v1.x+`)

### Instalação e execução

```bash
# 1. Instalar tipos/dependências de desenvolvimento
bun install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Edite o .env com seu usuário, senha, SESSION_SECRET e ESP32_TOKEN

# 3. Iniciar o servidor em modo desenvolvimento
bun run dev
# Acesse: http://localhost:3000
```

### Simulador de ESP32 (sem hardware)

Para testar o sistema completo localmente sem o ESP32 físico:

```bash
bun run mock
```

> Durante a execução do simulador, pressione a tecla **`w`** para alternar o estado da boia (com água / sem água).

## 🧪 Testes

```bash
bun test
```

A suíte cobre regras de irrigação, bloqueios de segurança, calibração, janela horária, detecção de bomba com defeito, geração/resolução de alertas, autenticação e WebSocket em tempo real.

## 🔌 Hardware e Firmware (ESP32)

| Componente | Pino ESP32 | Observação |
|---|---|---|
| Sensor de umidade capacitivo (`AO`) | `GPIO 34` | Entrada analógica (`ADC1_CH6`) |
| Boia de nível | `GPIO 27` | `INPUT_PULLUP` conectado ao `GND` |
| Módulo relé (`IN`) | `GPIO 26` | Aciona a bomba d'água |

Para gravar o firmware:

1. Copie `firmware/rega_esp32/config.example.h` para `firmware/rega_esp32/config.h` e preencha Wi-Fi, `SERVER_URL` e `DEVICE_TOKEN`.
2. Faça o upload com PlatformIO (`cd firmware && pio run -t upload`) ou via Arduino IDE.

### Calibração do sensor

No painel web, observe o valor de **ADC bruto** com o sensor **seco (no ar)** e **úmido (em um copo d'água)** e salve ambos na aba de configuração. Sensores capacitivos retornam valores maiores quando secos.

## 📡 Resumo da API

| Escopo | Método & Rota | Descrição |
|---|---|---|
| **Público** | `GET /api/health` | Healthcheck do servidor |
| **Dispositivo** | `POST /api/device/telemetry` | Envia `{ soil_raw, water_ok, pump_on }` (`X-Device-Token`) e recebe comando da bomba |
| **Auth** | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | Autenticação de sessão |
| **Status & Dados** | `GET /api/status` · `GET /api/stats` · `GET /api/chart?range=1h\|24h\|7d` | Estado atual, estatísticas e séries para gráficos |
| **Irrigação** | `POST /api/irrigation/start` · `POST /api/irrigation/stop` · `POST /api/irrigation/resume` | Controle manual e retomada do automático |
| **Histórico & Alertas** | `GET /api/telemetry/history` · `GET /api/irrigation/history` · `GET /api/alerts` | Registros históricos e alertas |
| **Configuração** | `GET /api/config` · `PUT /api/config` | Limites, calibração, janela horária e vazão |
| **Tempo real** | `WebSocket /ws` | Push de estado a cada 2 s e em eventos |

## 📚 Documentação adicional

- **[docs/DATASHEET.md](docs/DATASHEET.md)** — Pinagem detalhada, esquema elétrico, protocolo e solução de problemas.
- **[docs/A3_RELATORIO.md](docs/A3_RELATORIO.md)** — Relatório completo do projeto.
- **[deploy/rega-api.service](deploy/rega-api.service)** — Serviço `systemd` para execução contínua em Linux.

> ⚠️ **Nota de rede:** A comunicação padrão do ESP32 usa HTTP simples, ideal para rede local. Caso exponha o painel na internet, utilize um proxy reverso com HTTPS.
