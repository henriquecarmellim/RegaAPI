<!--
RASCUNHO DA A3 — adapte à norma/template da disciplina (capa, margens, fonte, ABNT).
Campos [entre colchetes] precisam ser preenchidos por você. Seção 5.3 reserva espaço para os
resultados do teste em hardware real, que ainda NÃO foram feitos — preencha com medições suas.
-->

# RegaAPI: Sistema de Irrigação Automática com ESP32 e Monitoramento Web

**Universidade São Judas Tadeu (USJT)**
Curso: [curso] · Disciplina: [disciplina] · Professor(a): [nome]
Aluno(s): [nome — RA] · São Paulo, [mês/ano]

---

## Resumo

Este trabalho apresenta o desenvolvimento do RegaAPI, um sistema de irrigação automática baseado no microcontrolador ESP32, composto por sensor capacitivo de umidade do solo, boia de nível (liga/desliga), módulo relé e bomba d'água, integrado a um servidor web com API REST e painel de monitoramento. O sistema decide quando irrigar a partir da umidade medida, bloqueia a bomba na ausência de água, continua operando de forma autônoma quando a rede falha e detecta falhas como bomba ou mangueira obstruída, avisando o usuário no painel. O servidor foi implementado em Bun (TypeScript) com banco SQLite, e o firmware em C++ (Arduino framework). A lógica foi validada por 29 testes automatizados e por simulação ponta a ponta; a validação em hardware real é indicada como etapa seguinte.

**Palavras-chave:** Internet das Coisas; irrigação automatizada; ESP32; sistemas embarcados; API REST.

---

## 1 Introdução

### 1.1 Contexto e problema
O cultivo de plantas, em hortas domésticas ou vasos, depende de irrigação regular. A rega manual sofre com esquecimento, excesso ou falta de água e impossibilita ausências prolongadas. Sistemas de irrigação comerciais costumam ser caros ou fechados. Há espaço para uma solução de baixo custo, aberta e com segurança operacional: não pode acionar a bomba sem água (risco de queimá-la) nem deixá-la ligada indefinidamente (risco de alagamento).

### 1.2 Objetivos
**Objetivo geral:** projetar e implementar um sistema de irrigação automática de baixo custo, monitorado remotamente, que opere sem intervenção humana.

**Objetivos específicos:**
1. Medir a umidade do solo e o nível do reservatório e acionar uma bomba por relé.
2. Implementar regras de segurança independentes do servidor (corte por falta de água, limite de tempo, falha de rede).
3. Disponibilizar API e painel web com histórico, controle manual e configuração.
4. Detectar falhas (bomba/mangueira, sensor, ausência de água, dispositivo offline) e alertar o usuário.
5. Validar a lógica por testes automatizados e simulação.

### 1.3 Justificativa
O projeto integra eletrônica, sistemas embarcados, redes e desenvolvimento web, aplicando conceitos de IoT a um problema real, com ênfase em **confiabilidade**: o sistema deve falhar de forma segura.

---

## 2 Fundamentação teórica

**Internet das Coisas (IoT).** Dispositivos com sensores e atuadores conectados à rede, enviando dados a um serviço central e recebendo comandos. Neste projeto, o ESP32 envia telemetria periódica e recebe do servidor o comando da bomba.

**ESP32.** Microcontrolador de 32 bits com Wi-Fi integrado, conversor analógico-digital (ADC) de 12 bits e lógica de 3,3 V (ESPRESSIF, ficha técnica). O ADC2 é compartilhado com o Wi-Fi e fica indisponível durante seu uso, por isso o sensor é ligado ao ADC1 (GPIO34).

**Sensor capacitivo de umidade.** Mede a constante dielétrica do solo, que varia com a água. Ao contrário dos sensores resistivos, não tem eletrodos expostos à corrosão. A leitura é analógica e inversamente proporcional à umidade, exigindo calibração (valor em solo seco e em água).

**Boia de nível.** Interruptor mecânico que fecha ou abre um contato conforme o nível, usada aqui como indicador binário de "água suficiente".

**Módulo relé.** Interface de potência que permite ao microcontrolador (3,3 V, poucos mA) comandar a bomba, com alimentação separada.

**Tolerância a falhas e *fail-safe*.** Projeto em que a falha leva ao estado seguro. Aqui o estado seguro é "bomba desligada": a bomba só funciona com autorização que expira sozinha.

**API REST e HTTP.** Comunicação cliente-servidor por requisições HTTP com troca de dados em JSON (IETF, RFC 9110).

---

## 3 Materiais e arquitetura

### 3.1 Hardware

| Item | Função |
|---|---|
| ESP32 DevKit | Leitura dos sensores, controle da bomba, Wi-Fi |
| Sensor capacitivo de umidade do solo | Umidade (analógico, GPIO34) |
| Boia de nível | Água suficiente: sim/não (GPIO27, pull-up interno) |
| Módulo relé 1 canal | Aciona a bomba (GPIO26) |
| Bomba d'água DC + fonte própria | Irrigação |
| Diodo 1N4007 | Proteção contra picos da carga indutiva |

Esquema de ligação, pinagem e cuidados de montagem estão no datasheet do projeto (`docs/DATASHEET.md`).

### 3.2 Arquitetura

```
 Sensor de umidade ─┐                    Wi-Fi / HTTP + JSON
 Boia ──────────────┼─► ESP32 ◄───────────────────────────► Servidor (Bun + SQLite) ──► Painel web
 Relé ◄─────────────┘     │ (flash: última configuração)        │ API REST · alertas · histórico
   └─► Bomba              └─ modo autônomo se o servidor cair
```

### 3.3 Software
- **Firmware (C++/Arduino):** leitura com média de 16 amostras, filtro (debounce) da boia, controle do relé, cliente HTTP, configuração em memória flash, *watchdog* de 15 s.
- **Servidor (TypeScript/Bun):** `Bun.serve`, `bun:sqlite`, sem dependências de execução. Autenticação por sessão assinada (HMAC-SHA256, cookie `HttpOnly`/`SameSite=Strict`) para o painel e token de dispositivo para o ESP32.
- **Painel (HTML/CSS/JS):** estado em tempo quase real (atualização a cada 3 s), gráfico de 1 h/24 h/7 dias com as regas marcadas, controle manual, configuração, histórico e alertas.

---

## 4 Desenvolvimento

### 4.1 Funcionamento
A cada 3 s o ESP32 envia `{soil_raw, water_ok, pump_on}`. O servidor grava a leitura, converte o valor bruto em porcentagem pela calibração configurada, avalia a necessidade de irrigação e responde com o comando (`pump`, `remaining_sec`) e a configuração vigente, que o ESP32 guarda em flash.

A rega automática ocorre quando **todas** as condições são verdadeiras: modo automático ligado, dentro da janela de horário, não pausada por falha, sensor válido, boia indicando água, umidade abaixo do limite, bomba parada e fora do intervalo mínimo entre regas (*cooldown*).

### 4.2 Segurança operacional (requisito central)

| Risco | Medida | Local |
|---|---|---|
| Bomba a seco | Boia sem água corta a bomba imediatamente | Firmware e servidor |
| Bomba presa ligada | Autorização com prazo que expira sozinha; limite absoluto de 120 s | Firmware |
| Rede/servidor indisponível | Modo autônomo com última configuração salva | Firmware |
| Sensor desconectado | Leituras nos extremos do ADC são ignoradas | Ambos |
| Travamento do MCU | *Watchdog* e relé iniciando desligado | Firmware |
| Acesso indevido | Sessão assinada, limite de tentativas de login, token de dispositivo | Servidor |

### 4.3 Detecção de falhas
- **Eficácia da rega:** 90 s após cada rega o servidor mede se a umidade subiu ao menos 3 pontos percentuais. Três regas seguidas sem efeito indicam bomba entupida, mangueira solta ou sensor mal posicionado: a rega automática é **pausada** e o usuário é avisado, evitando bombear água sem resultado.
- **Alertas:** dispositivo offline (> 5 min), reservatório vazio (> 10 min), sensor com defeito, solo seco por 3 h, excesso de regas (≥ 10 em 24 h). Cada alerta aparece uma vez no painel e no log, e é marcado como resolvido quando a condição some.

### 4.4 Janela de horário
Permite restringir a rega automática (por exemplo, 06:00–09:00), reduzindo evaporação e preservando as plantas. Aceita janelas que cruzam a meia-noite. O servidor envia ao ESP32 o estado já efetivo do modo automático, de modo que o modo autônomo respeita a mesma regra sem lógica adicional no firmware.

### 4.5 Estimativa de consumo
Com a vazão da bomba informada (L/min), o painel estima os litros usados por rega, no dia e em 7 dias.

---

## 5 Testes e resultados

### 5.1 Testes automatizados
29 testes (`bun test`) cobrindo: conversão e calibração do sensor; bloqueio sem água (manual e automático); limite de duração; corte da bomba quando a boia desliga durante a rega; *cooldown*; sensor desconectado; sessões (assinatura válida, adulterada, expirada); janelas de horário (normal e cruzando a meia-noite); medição de eficácia; pausa após três falhas e retomada; e todos os tipos de alerta, inclusive a ausência de duplicação e a resolução. Resultado: **29 aprovados, 0 falhas**.

### 5.2 Testes de integração
- Mais de 50 verificações contra a API em execução: autenticação, rotas protegidas, validação de entradas (valores fora da faixa, tipos incorretos, JSON inválido), proteção contra acesso a arquivos fora do diretório público, limite de tentativas de login e fluxo de rega manual.
- Simulação com ESP32 virtual: rega automática disparada, parada pelo tempo configurado (8 s exatos), umidade subindo e rega encerrada, novo ciclo após o solo secar e respeito ao *cooldown*.
- Painel executado em DOM simulado contra servidor real: sem erros de JavaScript; gráfico, abas, avisos e botão de retomada funcionais.
- Firmware compilado para ESP32 (PlatformIO, Arduino core 2.x): 71 % da memória flash e 14 % da RAM.

### 5.3 Testes em hardware real
> **[A preencher.]** Registre: (a) calibração do sensor (valor seco e úmido medidos); (b) tempo de rega e variação de umidade observados; (c) teste da boia (retirar a água durante a rega e confirmar corte imediato); (d) teste de queda do Wi-Fi com a bomba ligada (deve desligar ao fim do prazo); (e) fotos da montagem.

---

## 6 Limitações e trabalhos futuros

**Limitações.** A comunicação é HTTP sem criptografia (adequada à rede local); um único ponto de irrigação; a boia fornece apenas informação binária de nível; e a validação em bancada ainda não foi realizada.

**Trabalhos futuros.** HTTPS por proxy reverso; múltiplos sensores/válvulas; sensor de vazão para medir litros em vez de estimar; integração com previsão do tempo para suspender a rega quando houver chuva; atualização do firmware pela rede (OTA).

---

## 7 Conclusão

O RegaAPI atende aos objetivos propostos: irriga automaticamente a partir da umidade medida, protege a bomba contra funcionamento a seco e excesso de tempo, continua operando sem rede, detecta falhas e alerta o usuário, e oferece painel de acompanhamento. A abordagem em camadas — segurança no firmware, inteligência no servidor — mostrou-se adequada: falhas de comunicação não comprometem a segurança da bomba. Os testes automatizados e a simulação sustentam a correção da lógica; a próxima etapa é a validação em hardware real, descrita na seção 5.3.

---

## Referências
*(Confira e formate conforme a ABNT e as fontes que você de fato consultou.)*

ESPRESSIF SYSTEMS. **ESP32 Series Datasheet**. Disponível em: https://www.espressif.com. Acesso em: [data].

ESPRESSIF SYSTEMS. **Arduino-ESP32 Documentation**. Disponível em: https://docs.espressif.com/projects/arduino-esp32. Acesso em: [data].

FIELDING, R.; NOTTINGHAM, M.; RESCHKE, J. **HTTP Semantics**. RFC 9110. IETF, 2022. Disponível em: https://www.rfc-editor.org/rfc/rfc9110. Acesso em: [data].

SQLITE. **SQLite Documentation**. Disponível em: https://www.sqlite.org/docs.html. Acesso em: [data].

BUN. **Bun Documentation**. Disponível em: https://bun.sh/docs. Acesso em: [data].

---

## Apêndice A — Endpoints principais

| Método e rota | Descrição |
|---|---|
| `POST /api/device/telemetry` | ESP32 envia leitura e recebe comando + configuração (token de dispositivo) |
| `GET /api/status` | Estado completo: sensores, bomba, alertas, configuração |
| `GET /api/chart?range=1h\|24h\|7d` | Série agregada e regas para o gráfico |
| `POST /api/irrigation/start` · `/stop` · `/resume` | Rega manual, parada e retomada do automático |
| `GET /api/irrigation/history` · `/api/stats` · `/api/alerts` | Histórico, consumo e alertas |
| `GET/PUT /api/config` | Configuração (limites, calibração, janela, vazão) |

## Apêndice B — Código-fonte
Estrutura: `index.ts` e `src/` (servidor), `public/` (painel), `firmware/rega_esp32/` (ESP32), `tests/` (testes), `docs/DATASHEET.md` (datasheet).
