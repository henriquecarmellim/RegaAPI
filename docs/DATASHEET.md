# RegaAPI — Datasheet do Sistema de Irrigação Automática

**Revisão:** 1.0 · **MCU:** ESP32 (DevKit 30/38 pinos) · **Firmware:** `firmware/rega_esp32` · **Servidor:** Bun + SQLite

## 1. Visão geral

Sistema que mantém o solo úmido sem intervenção. O ESP32 mede a umidade do solo e o nível do reservatório (boia), aciona uma bomba d'água por um módulo relé e conversa com um servidor (API + painel web) que registra histórico e permite ajustes. Se o servidor ou o Wi-Fi cair, o ESP32 continua regando sozinho.

```
 Sensor umidade ──┐                       Wi-Fi / HTTP
 Boia (on/off) ───┼──► ESP32 ◄──────────────────────────► Servidor RegaAPI ──► Painel web
 Relé ◄───────────┘      │                                   (SQLite)
   │                     └─ flash: última configuração
 Bomba d'água ◄─ Reservatório
```

## 2. Componentes

| # | Componente | Função | Interface | Alimentação |
|---|---|---|---|---|
| 1 | ESP32 DevKit | Controle, Wi-Fi | — | 5 V (USB/VIN), lógica 3,3 V |
| 2 | Sensor de umidade do solo (capacitivo, saída analógica) | Mede umidade | Analógica → ADC1 | 3,3 V |
| 3 | Boia de nível (interruptor) | Água suficiente: sim/não | Digital, contato seco | — |
| 4 | Módulo relé 1 canal (5 V, c/ optoacoplador) | Aciona a bomba | Digital | 5 V (VIN) |
| 5 | Bomba d'água (DC) | Irriga | Contatos COM/NO do relé | Fonte própria (conforme a bomba) |

> Os valores elétricos da bomba e do relé dependem do modelo adquirido. Confira a etiqueta/ficha técnica da **sua** bomba: tensão, corrente nominal e corrente de partida. A corrente deve ficar abaixo do limite de contato do relé (comum: 10 A).

## 3. Pinagem do ESP32

| Sinal | GPIO | Modo | Observação |
|---|---|---|---|
| Sensor de umidade (AO) | **34** | Entrada analógica (ADC1_CH6) | Apenas entrada. Use ADC1: ADC2 não funciona com Wi-Fi |
| Boia | **27** | `INPUT_PULLUP` | Um fio no GPIO27, outro no GND |
| Relé (IN) | **26** | Saída | Ativo em LOW (padrão da maioria dos módulos) |
| Alimentação do sensor | 3V3 / GND | — | |
| Alimentação do relé | VIN (5 V) / GND | — | Se o módulo não ligar com 3,3 V de sinal, veja a seção 9 |

Pinos alteráveis em `firmware/rega_esp32/config.h`.

## 4. Esquema de ligação

```
ESP32                      Sensor umidade
 3V3 ─────────────────────── VCC
 GND ─────────────────────── GND
 GPIO34 ──────────────────── AO

ESP32                      Boia
 GPIO27 ──────────/ boia /── GND          (fecha ao subir a água => LOW => "com água")

ESP32                      Módulo relé
 VIN(5V) ─────────────────── VCC
 GND ─────────────────────── GND
 GPIO26 ──────────────────── IN

Relé (lado de potência)
 (+) Fonte da bomba ──► COM ;  NO ──► (+) Bomba ;  (−) Bomba ──► (−) Fonte
```

Regras de montagem:
1. **GND comum** entre ESP32, módulo relé e sensor. A fonte da bomba é separada e só passa pelos contatos do relé.
2. Para bomba DC, coloque um **diodo de roda livre** (ex.: 1N4007, catodo no +) em paralelo com a bomba, para proteger o relé de picos.
3. Se a bomba for de **rede (110/220 V)**, use o relé apenas se for dimensionado para isso, com isolamento adequado e caixa fechada. Prefira bomba DC de baixa tensão.
4. Mantenha eletrônica fora de respingos; apenas o sensor (parte inferior) e a bomba ficam em contato com água/terra.
5. Boia posicionada de forma que **"água suficiente" = boia elevada** com folga acima da entrada da bomba, para ela nunca trabalhar a seco.

## 5. Sensor de umidade e calibração

- Leitura: média de 16 amostras do ADC de 12 bits (0–4095), atenuação 11 dB.
- Sensor capacitivo: **valor alto = seco**, valor baixo = úmido.
- Conversão: `% = (seco − leitura) / (seco − úmido) × 100`, limitada a 0–100.
- Padrões: `seco = 3200`, `úmido = 1200`. **Calibre o seu:**
  1. Painel mostra "ADC bruto". Com o sensor no ar, anote o valor → *Calibração SECO*.
  2. Com o sensor até a linha indicada dentro de um copo d'água, anote → *Calibração ÚMIDO*.
  3. Salve em *Configuração*; o ESP32 recebe sozinho no próximo ciclo.
- Leitura ≤ 50 ou ≥ 4090 é tratada como **sensor desconectado/em curto** e nunca dispara rega.

## 6. Lógica de operação

| Parâmetro | Padrão | Faixa | Descrição |
|---|---|---|---|
| `auto_mode` | ligado | on/off | Rega automática |
| `min_moisture` | 35 % | 0–100 | Abaixo disso, dispara rega |
| `duration_sec` | 20 s | 1–`max_run_sec` | Duração de cada rega |
| `cooldown_sec` | 600 s | 0–86 400 | Intervalo mínimo entre regas automáticas |
| `max_run_sec` | 120 s | 1–600 | Teto de funcionamento da bomba |
| `dry_raw` / `wet_raw` | 3200 / 1200 | 0–4095 | Calibração (seco deve ser > úmido) |
| `window_enabled`, `window_start_min`, `window_end_min` | desligada, 06:00–09:00 | 0–1439 | Janela de horário da rega **automática** (a manual ignora) |
| `flow_lpm` | 0 | 0–100 | Vazão da bomba (L/min) para estimar litros; 0 = não informado |

Condição de rega automática (servidor): `auto_mode` ∧ **dentro da janela** ∧ **não pausada por falha** ∧ sensor válido ∧ boia com água ∧ umidade < `min_moisture` ∧ bomba parada ∧ fora do cooldown.

### Verificação de eficácia e pausa por falha
90 s após cada rega concluída, o servidor compara a umidade antes e depois. Subida < 3 pontos = rega **sem efeito**. Três regas sem efeito seguidas pausam a rega automática e geram alerta (provável bomba entupida, mangueira solta ou sensor mal posicionado). Medições inconclusivas (solo já acima de 80 % ou sem leituras) não contam. A pausa termina ao tocar em *Retomar* ou quando uma rega (ex.: manual, após o conserto) funcionar.

### Alertas
| Alerta | Condição |
|---|---|
| ESP32 offline | sem telemetria há > 5 min (após o primeiro contato) |
| Reservatório sem água | boia sem água há > 10 min |
| Sensor com defeito | ADC ≤ 50 ou ≥ 4090 |
| Rega pausada | 3 regas sem efeito |
| Solo seco há horas | umidade abaixo do limite durante 3 h |
| Rega acima do normal | ≥ 10 regas em 24 h |

Cada alerta aparece uma vez no painel e no log, e é marcado como resolvido quando a condição some.

### Modos do ESP32
| Modo | Quando | Quem decide a rega |
|---|---|---|
| **Online** | Servidor respondeu nos últimos 60 s | Servidor (ESP32 obedece o comando) |
| **Autônomo** | Sem resposta por mais de 60 s | ESP32, com a última configuração salva em flash |

Em ambos valem as proteções da seção 7. Ao voltar, o servidor reassume.

O campo `auto_mode` enviado ao ESP32 já é o valor **efetivo** (falso fora da janela de horário ou com a rega pausada por falha). Como o firmware guarda esse campo em flash, o modo autônomo respeita a mesma regra sem lógica extra no ESP32. Limitação: no modo autônomo o ESP32 usa o último valor recebido, pois sem servidor não há como saber a hora.

## 7. Proteções

| Risco | Proteção | Onde |
|---|---|---|
| Bomba a seco | Boia sem água corta a bomba imediatamente e impede nova partida | Firmware + servidor |
| Bomba presa ligada | Autorização com prazo; expira sozinha se Wi-Fi/servidor caírem | Firmware |
| Excesso de rega | Duração limitada por `max_run_sec`; teto fixo de 120 s no firmware; cooldown | Ambos |
| Sensor solto | Leitura nos extremos do ADC é ignorada | Ambos |
| Ruído na boia | Debounce de 1 s ao *ligar*; desligar é imediato | Firmware |
| Pulso no boot | Relé inicia desligado antes de virar saída | Firmware |
| Travamento | Watchdog de 15 s reinicia o ESP32 | Firmware |
| Telemetria forjada | Token `X-Device-Token` em toda chamada do dispositivo | Servidor |
| Acesso ao painel | Sessão assinada (`HttpOnly`, `SameSite=Strict`, 8 h) + limite de 5 tentativas/min | Servidor |
| Falha com ESP32 offline | Rega manual recusada se sem telemetria há > 30 s | Servidor |

## 8. Protocolo (ESP32 ⇄ Servidor)

Intervalo: **3 s**. HTTP simples (rede local).

**Requisição** `POST /api/device/telemetry` · Header `X-Device-Token`
```json
{ "soil_raw": 2874, "water_ok": true, "pump_on": false }
```
**Resposta** `200`
```json
{ "pump": true, "remaining_sec": 18, "max_run_sec": 120,
  "auto_mode": true, "min_moisture": 35, "duration_sec": 20,
  "cooldown_sec": 600, "dry_raw": 3200, "wet_raw": 1200 }
```
`pump:true` com `remaining_sec>0` autoriza a bomba pelo prazo informado; o ESP32 renova a cada resposta. A configuração enviada é salva em flash (só grava se mudou).

Erros: `400` payload inválido (`soil_raw` fora de 0–4095 ou `water_ok` não booleano) · `401` token inválido.

Endpoints do painel e demais detalhes: `README.md`.

## 9. Resolução de problemas

| Sintoma | Causa provável | Ação |
|---|---|---|
| Painel diz "ESP32 offline" | Wi-Fi/IP/token errados | Monitor serial (115200); confira `config.h`; servidor acessível na porta 3000 (firewall) |
| Bomba nunca liga | Boia lida como "sem água" | Inverta `FLOAT_LEVEL_WHEN_WATER`; confira se a boia fecha contato quando elevada |
| Bomba liga ao contrário (liga quando deveria desligar) | Relé ativo em HIGH | `RELAY_ACTIVE_LOW false` |
| Relé não aciona com 3,3 V no IN | Módulo exige mais tensão de sinal | Use módulo com optoacoplador e VCC de 5 V (JD-VCC) ou um transistor/ driver |
| % de umidade invertida/estranha | Calibração errada | Refazer seção 5 |
| Umidade sempre 0 % ou 100 % | Sensor desconectado ou ADC2 | Confira GPIO34 e fiação |
| ESP32 reinicia ao ligar a bomba | Queda de tensão/ruído | Fonte separada para a bomba, GND comum, capacitor na alimentação |
| Rega frequente demais | Limite alto ou sensor mal posicionado | Reduza `min_moisture`, aumente `cooldown_sec` |

## 10. Instalação rápida

1. **Servidor:** `bun install`, copiar `.env.example` para `.env`, `bun run start`. Autostart: `deploy/rega-api.service`.
2. **Firmware:** editar `firmware/rega_esp32/config.h` (Wi-Fi, IP do servidor, token = `ESP32_TOKEN` do `.env`) e gravar:
   `cd firmware && pio run -t upload` (ou abrir a pasta `rega_esp32` na Arduino IDE).
3. **Teste a seco:** ligue a bomba só depois de ver no painel "ESP32 online" e testar a boia manualmente (com um LED no lugar da bomba, se possível).
4. **Calibrar** o sensor (seção 5) e ajustar `min_moisture`.

## 11. Verificações realizadas

- 29 testes automatizados (`bun test`): lógica de rega, segurança, sessão, janela de horário, eficácia, pausa por falha e alertas.
- Painel carregado em DOM simulado contra servidor real: sem erros de JavaScript; gráfico, abas, banners e botão *Retomar* funcionando.
- Teste ponta a ponta com ESP32 simulado: rega automática, parada na duração exata, cooldown, bloqueio sem água e autenticação.
- Firmware compilado com PlatformIO (`espressif32`, Arduino core 2.x): Flash 71 %, RAM 14 %.
- **Não testado em hardware real.** Valide boia, relé e bomba na bancada antes da instalação definitiva.
