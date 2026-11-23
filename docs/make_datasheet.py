#!/usr/bin/env python3
"""Gera o datasheet do RegaAPI (SVG -> PNG).

Uso (na raiz do projeto):
    python3 docs/make_datasheet.py
Requer: rsvg-convert (librsvg). Saída: docs/datasheet.png
"""
import html, os, subprocess, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_SVG = os.path.join(HERE, "datasheet.svg")
OUT_PNG = os.path.join(HERE, "datasheet.png")
REV = "Rev. 1.3"

W = 1600
INK, MUTE, LINE, BG, CARD, ACC = "#14203a", "#5d6b88", "#d5deea", "#eef3f9", "#ffffff", "#0b6bcb"
FONT = "DejaVu Sans, Noto Sans, sans-serif"
RED, BLK, GRN, BLU, ORG, PUR = "#d93025", "#222222", "#1e8e3e", "#1a73e8", "#e8710a", "#8e44ad"
o = []
esc = lambda t: html.escape(t, quote=False)


def text(x, y, s, size=15, fill=INK, weight="normal", anchor="start", mono=False):
    fam = "DejaVu Sans Mono, monospace" if mono else FONT
    o.append(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" fill="{fill}" '
             f'font-weight="{weight}" text-anchor="{anchor}">{esc(s)}</text>')


def rect(x, y, w, h, fill=CARD, stroke=LINE, r=10, sw=1.5):
    o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')


def wire(pts, color, sw=3.5):
    o.append(f'<polyline points="{" ".join(f"{a},{b}" for a, b in pts)}" fill="none" stroke="{color}" '
             f'stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round"/>')


def dot(x, y, c=INK):
    o.append(f'<circle cx="{x}" cy="{y}" r="5" fill="{c}"/>')


def card(x, y, w, title, rows, size=14.5):
    """rows: ('kv', k, v[, largura_da_chave]) | ('p', texto) | ('b', texto) | ('mono', texto). Retorna a altura."""
    start = len(o)
    o.append("")
    cy = y + 38
    text(x + 18, y + 27, title, 17, ACC, "bold")
    o.append(f'<line x1="{x+18}" y1="{y+36}" x2="{x+w-18}" y2="{y+36}" stroke="{LINE}"/>')
    cy += 12
    cw = size * 0.57
    for r in rows:
        kind = r[0]
        if kind == "kv":
            kw = int(r[3]) if len(r) > 3 else 150
            lines = textwrap.wrap(r[2], max(8, int((w - 36 - kw) / cw))) or [""]
            text(x + 18, cy, r[1], size, MUTE, "bold")
            for i, l in enumerate(lines):
                text(x + 18 + kw, cy + i * (size + 5), l, size)
            cy += len(lines) * (size + 5) + 5
        elif kind in ("p", "b"):
            pre = "• " if kind == "b" else ""
            lines = textwrap.wrap(pre + r[1], int((w - 36) / cw), subsequent_indent="  " if kind == "b" else "")
            for l in lines:
                text(x + 18, cy, l, size)
                cy += size + 5
            cy += 3
        elif kind == "mono":
            for l in r[1].split("\n"):
                text(x + 18, cy, l, 13, INK, "normal", mono=True)
                cy += 18
            cy += 3
    h = cy - y + 8
    o[start] = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{CARD}" stroke="{LINE}" stroke-width="1.5"/>'
    return h


# ---------------- Cabeçalho ----------------
rect(0, 0, W, 130, "#0b2a4a", "#0b2a4a", 0)
text(48, 62, "RegaAPI — Datasheet", 40, "#ffffff", "bold")
text(48, 98, "Sistema de irrigação automática · ESP32 + sensor de umidade + boia + relé + bomba d'água", 18, "#bcd3ee")
text(W - 48, 62, REV, 22, "#ffffff", "bold", "end")
text(W - 48, 98, "Firmware C++ (Arduino) · Servidor Bun + SQLite", 16, "#bcd3ee", anchor="end")

# ---------------- Diagrama de ligação ----------------
Y0 = 160
rect(24, Y0, W - 48, 610)
text(48, Y0 + 34, "ESQUEMA DE LIGAÇÃO", 17, ACC, "bold")
dy = Y0 + 50

# ESP32
ex1, ex2 = 640, 960
rect(ex1, dy, ex2 - ex1, 470, "#16324f", "#0b2a4a", 14, 2)
text((ex1 + ex2) / 2, dy + 40, "ESP32", 30, "#ffffff", "bold", "middle")
text((ex1 + ex2) / 2, dy + 66, "DevKit (lógica 3,3 V)", 14, "#bcd3ee", anchor="middle")
text((ex1 + ex2) / 2, dy + 440, "Wi-Fi 2,4 GHz → servidor", 14, "#bcd3ee", anchor="middle")


def pin_left(y, label, color):
    text(ex1 + 14, dy + y + 5, label, 15, "#ffffff", "bold")
    dot(ex1, dy + y, color)


def pin_right(y, label, color):
    text(ex2 - 14, dy + y + 5, label, 15, "#ffffff", "bold", "end")
    dot(ex2, dy + y, color)


# Sensor de umidade
sx1, sx2 = 60, 330
rect(sx1, dy + 30, sx2 - sx1, 170, "#eaf6ee", "#7fbf95", 12, 2)
text((sx1 + sx2) / 2, dy + 58, "Sensor de umidade", 17, INK, "bold", "middle")
text((sx1 + sx2) / 2, dy + 78, "(capacitivo, analógico)", 13, MUTE, anchor="middle")
for yy, lab, col, pin, pc in [(110, "VCC", RED, "3V3", RED), (150, "GND", BLK, "GND", BLK), (190, "AO", GRN, "GPIO34", GRN)]:
    text(sx2 - 14, dy + yy + 5, lab, 15, INK, "bold", "end")
    dot(sx2, dy + yy, col)
    wire([(sx2, dy + yy), (ex1, dy + yy)], col)
    pin_left(yy, pin, pc)
text(sx1 + 14, dy + 190, "ADC1 (só entrada)", 12, MUTE)

# Boia
rect(sx1, dy + 250, sx2 - sx1, 130, "#fff7e6", "#e0b45a", 12, 2)
text((sx1 + sx2) / 2, dy + 280, "Boia de nível", 17, INK, "bold", "middle")
text((sx1 + sx2) / 2, dy + 300, "(liga / desliga)", 13, MUTE, anchor="middle")
for yy, lab, col, pin, pc in [(330, "fio 1", ORG, "GPIO27", ORG), (370, "fio 2", BLK, "GND", BLK)]:
    text(sx2 - 14, dy + yy + 5, lab, 15, INK, "bold", "end")
    dot(sx2, dy + yy, col)
    wire([(sx2, dy + yy), (ex1, dy + yy)], col)
    pin_left(yy, pin, pc)
text(sx1 + 14, dy + 372, "pull-up interno", 12, MUTE)

# Relé
rx1, rx2 = 1180, 1440
rect(rx1, dy + 30, rx2 - rx1, 240, "#eef2ff", "#8b9be0", 12, 2)
text((rx1 + rx2) / 2, dy + 58, "Módulo relé 5 V", 17, INK, "bold", "middle")
text((rx1 + rx2) / 2, dy + 78, "1 canal · ativo em LOW", 13, MUTE, anchor="middle")
for yy, lab, col, pin, pc in [(110, "VCC", RED, "VIN 5V", RED), (150, "GND", BLK, "GND", BLK), (190, "IN", PUR, "GPIO26", PUR)]:
    text(rx1 + 14, dy + yy + 5, lab, 15, INK, "bold")
    dot(rx1, dy + yy, col)
    wire([(ex2, dy + yy), (rx1, dy + yy)], col)
    pin_right(yy, pin, pc)
# Terminais de saída (potência): NC não é usado
text(rx1 + 70, dy + 235, "NC", 14, MUTE, "bold", "middle")
text(rx1 + 150, dy + 235, "NO", 14, INK, "bold", "middle")
text(rx1 + 230, dy + 235, "COM", 14, INK, "bold", "middle")
text(rx1 + 70, dy + 252, "não usar", 11, MUTE, anchor="middle")
dot(rx1 + 70, dy + 270, "#9aa3b5")
dot(rx1 + 150, dy + 270, BLU)
dot(rx1 + 230, dy + 270, RED)

# Bomba e alimentação (5 V do ESP32)
px1, px2 = 1060, 1280
rect(px1, dy + 340, px2 - px1, 100, "#fdecec", "#e08a8a", 12, 2)
text((px1 + px2) / 2, dy + 395, "Bomba d'água DC", 16, INK, "bold", "middle")
text(px1 + 52, dy + 361, "(+)", 14, INK, "bold")
text(px2 - 90, dy + 433, "(−)", 14, INK, "bold")
fx1, fx2 = 1320, 1540
rect(fx1, dy + 340, fx2 - fx1, 100, "#f1f1f1", "#b0b0b0", 12, 2)
text((fx1 + fx2) / 2, dy + 395, "5 V do ESP32", 16, INK, "bold", "middle")
text((fx1 + fx2) / 2, dy + 413, "(carregador USB ≥ 1 A)", 12, MUTE, anchor="middle")
text(fx1 + 52, dy + 361, "VIN 5V", 14, INK, "bold")
text(fx2 - 100, dy + 433, "GND", 14, INK, "bold")
# fios de potência
wire([(rx1 + 230, dy + 270), (rx1 + 230, dy + 305), (fx1 + 40, dy + 305), (fx1 + 40, dy + 340)], RED)
wire([(rx1 + 150, dy + 270), (rx1 + 150, dy + 322), (px1 + 40, dy + 322), (px1 + 40, dy + 340)], BLU)
wire([(px2 - 40, dy + 440), (px2 - 40, dy + 475), (fx2 - 40, dy + 475), (fx2 - 40, dy + 440)], BLK)
for xx, yy, c in [(fx1 + 40, dy + 340, RED), (px1 + 40, dy + 340, BLU), (px2 - 40, dy + 440, BLK), (fx2 - 40, dy + 440, BLK)]:
    dot(xx, yy, c)

# Notas
text(sx1, dy + 420, "GND comum: ESP32, sensor, relé e boia.", 13, MUTE)
text(sx1, dy + 438, "Bomba alimentada pelo 5V (VIN) do ESP32, passando pelo relé (COM → NO).", 13, MUTE)
text(sx1, dy + 462, "Diodo 1N4007 em paralelo com a bomba (faixa no +).", 13, MUTE)
text(sx1, dy + 480, "100 µF nos terminais da bomba (faixa no −).", 13, MUTE)
text(sx1, dy + 504, "470–1000 µF entre VIN e GND do ESP32 (faixa no GND).", 13, RED, "bold")
text(sx1, dy + 522, "Alimente o ESP32 com carregador USB de 1 A ou mais.", 13, RED, "bold")
text(sx1, dy + 546, "Use o contato NO, nunca o NC: com o relé desligado a bomba fica parada.", 13, RED, "bold")

# ---------------- Colunas ----------------
Y1 = Y0 + 610 + 24
cw3 = (W - 48 - 2 * 20) // 3
cx = [24, 24 + cw3 + 20, 24 + 2 * (cw3 + 20)]
cols = [Y1, Y1, Y1]


def put(i, title, rows, size=14.5):
    h = card(cx[i], cols[i], cw3, title, rows, size)
    cols[i] += h + 18


put(0, "PINAGEM DO ESP32", [
    ("kv", "GPIO34", "Sensor de umidade (AO) — entrada analógica ADC1", 90),
    ("kv", "GPIO27", "Boia — INPUT_PULLUP, outro fio no GND", 90),
    ("kv", "GPIO26", "Relé (IN) — saída, ativo em LOW", 90),
    ("kv", "3V3", "Alimenta o sensor de umidade", 90),
    ("kv", "VIN (5V)", "Alimenta o módulo relé e a bomba (via relé)", 90),
    ("kv", "GND", "Comum a todos os módulos", 90),
    ("p", "Use ADC1: o ADC2 não funciona com Wi-Fi. Pinos em firmware/rega_esp32/config.h."),
])
put(0, "COMPONENTES", [
    ("kv", "ESP32 DevKit", "Controle e Wi-Fi", 170),
    ("kv", "Sensor capacitivo", "Umidade do solo (analógico)", 170),
    ("kv", "Boia", "Água suficiente: sim / não", 170),
    ("kv", "Módulo relé 5 V", "Saídas NC / COM / NO; a bomba usa COM e NO (NC não usado)", 170),
    ("kv", "Bomba JT100", "3–6 V, ~200 mA, ~2 L/min (alimentada pelo 5V do ESP32)", 170),
    ("kv", "Diodo 1N4007", "Proteção do relé contra picos", 170),
    ("kv", "Capacitores", "470–1000 µF (VIN–GND) e 100 µF (bomba)", 170),
])
put(0, "VALIDAÇÃO REALIZADA", [
    ("b", "32 testes automatizados (rega, segurança, normalização, tempo real, alertas)"),
    ("b", "Teste ponta a ponta com ESP32 simulado"),
    ("b", "Firmware compilado e gravado; ESP32 conecta ao servidor e recebe comandos"),
    ("p", "Pendente: conferir, com a bomba submersa, se o ESP32 reinicia ou perde o Wi-Fi quando ela liga."),
])
put(1, "PARÂMETROS PADRÃO (editáveis no painel)", [
    ("kv", "Limite de rega", "umidade < 35 %", 160),
    ("kv", "Duração da rega", "20 s", 160),
    ("kv", "Intervalo mínimo", "600 s (cooldown entre regas auto)", 160),
    ("kv", "Teto da bomba", "120 s (máx. 600 s no servidor)", 160),
    ("kv", "Calibração ADC", "seco 3200 · úmido 1200", 160),
    ("kv", "Janela de horário", "desligada (exemplo 06:00–09:00)", 160),
    ("kv", "Vazão da bomba", "~2 L/min a 6 V; em 5 V use ~1,5 (0 = não informada)", 160),
    ("p", "Sensor capacitivo: valor alto = seco. % = (seco − leitura)/(seco − úmido) × 100, sobre a mediana das últimas 9 leituras."),
])
put(1, "QUANDO O SISTEMA REGA SOZINHO", [
    ("b", "modo automático ligado e dentro da janela de horário"),
    ("b", "rega não pausada por falha"),
    ("b", "sensor válido (ADC entre 50 e 4090)"),
    ("b", "boia indica água"),
    ("b", "umidade abaixo do limite, bomba parada e fora do cooldown"),
    ("p", "Modo ONLINE: o servidor decide. Modo AUTÔNOMO: sem resposta por 60 s, o ESP32 rega com a última configuração salva em flash."),
])
put(1, "PROTOCOLO ESP32 ⇄ SERVIDOR (a cada 3 s)", [
    ("p", "POST /api/device/telemetry · header X-Device-Token · conexão mantida"),
    ("mono", '→ {"soil_raw":2874,\n   "water_ok":true,\n   "pump_on":false}'),
    ("mono", '← {"pump":true,\n   "remaining_sec":18,\n   "max_run_sec":120,\n   "auto_mode":true, ...cfg}'),
], 14)
put(2, "PROTEÇÕES", [
    ("b", "Sem água: corta a bomba na hora e bloqueia nova partida (firmware e servidor)"),
    ("b", "Bomba só liga com autorização que expira sozinha (queda de Wi-Fi ou servidor desliga)"),
    ("b", "Limite absoluto de 120 s de funcionamento contínuo no firmware"),
    ("b", "Sensor solto ou em curto nunca dispara rega"),
    ("b", "Rede em tarefa separada: a checagem da boia e do prazo da bomba roda a cada 20 ms"),
    ("b", "Relé inicia desligado; watchdog de 15 s reinicia o ESP32 se o loop travar"),
    ("b", "Token de dispositivo e sessão assinada no painel; limite de tentativas de login"),
])
put(2, "FALHAS E ALERTAS", [
    ("kv", "Bomba/mangueira", "3 regas sem subir a umidade ≥ 3 pontos → rega automática pausada", 175),
    ("kv", "ESP32 offline", "sem dados há mais de 5 min", 175),
    ("kv", "Sem água", "boia sem água há mais de 10 min", 175),
    ("kv", "Sensor", "leitura nos extremos do ADC", 175),
    ("kv", "Solo seco", "abaixo do limite por 3 h", 175),
    ("kv", "Excesso", "10 regas ou mais em 24 h", 175),
    ("p", "Alertas aparecem no painel e no log. Painel em tempo real (WebSocket)."),
])

H = max(cols) + 40
text(W / 2, H - 14, "RegaAPI · docs/DATASHEET.md contém o detalhamento completo (calibração, solução de problemas, instalação)",
     13, MUTE, anchor="middle")
H += 8
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
       f'<rect width="{W}" height="{H}" fill="{BG}"/>' + "\n".join(o) + "</svg>")
with open(OUT_SVG, "w") as f:
    f.write(svg)
subprocess.run(["rsvg-convert", "-z", "1.5", OUT_SVG, "-o", OUT_PNG], check=True)
os.remove(OUT_SVG)
print("gerado:", OUT_PNG, "altura (px do SVG):", H)
