#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Execute com sudo: sudo $0"
  exit 1
fi

SSID="${AP_SSID:-RegaAP}"
PASS="${AP_PASS:-rega123456}"
AP_IF="ap0"
STA_IF="wlan0"
AP_IP="192.168.50.1"
TMP_DIR="$(mktemp -d /tmp/rega-ap.XXXXXX)"
DNSMASQ_PID=""

cleanup() {
  if [[ -n "${DNSMASQ_PID}" ]] && kill -0 "${DNSMASQ_PID}" 2>/dev/null; then
    kill "${DNSMASQ_PID}" 2>/dev/null || true
  fi
  iw dev "${AP_IF}" del 2>/dev/null || true
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT INT TERM

# Detecta canal atual de wlan0 (placa suporta 1 canal por vez).
CHANNEL=6
CUR_CH="$(iw dev "${STA_IF}" info 2>/dev/null | awk '/channel / {print $2; exit}' || true)"
if [[ -n "${CUR_CH}" ]]; then
  if (( CUR_CH >= 1 && CUR_CH <= 13 )); then
    CHANNEL="${CUR_CH}"
    echo "[ap] ${STA_IF} em 2.4 GHz (canal ${CHANNEL}); mantendo conexao ativa."
  else
    echo "[ap] ${STA_IF} esta em 5 GHz (canal ${CUR_CH}); desconectando para operar em 2.4 GHz (canal 6)..."
    iwctl station "${STA_IF}" disconnect 2>/dev/null || true
    sleep 1
    CHANNEL=6
  fi
fi

# Recria interface virtual ap0 se já existir.
iw dev "${AP_IF}" del 2>/dev/null || true
iw dev "${STA_IF}" interface add "${AP_IF}" type __ap
ip addr flush dev "${AP_IF}"
ip addr add "${AP_IP}/24" dev "${AP_IF}"
ip link set "${AP_IF}" up

# Libera DHCP (67/udp) e RegaAPI (3000/tcp) no ufw se ativo.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow in on "${AP_IF}" to any port 67 proto udp >/dev/null || true
  ufw allow in on "${AP_IF}" to any port 3000 proto tcp >/dev/null || true
fi

cat > "${TMP_DIR}/dnsmasq.conf" <<EOF
interface=${AP_IF}
bind-interfaces
port=0
dhcp-range=192.168.50.10,192.168.50.50,12h
dhcp-option=3,${AP_IP}
EOF

cat > "${TMP_DIR}/hostapd.conf" <<EOF
interface=${AP_IF}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=${CHANNEL}
ieee80211n=1
wmm_enabled=1
auth_algs=1
wpa=2
wpa_passphrase=${PASS}
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

dnsmasq -C "${TMP_DIR}/dnsmasq.conf" --no-daemon --pid-file="${TMP_DIR}/dnsmasq.pid" &
DNSMASQ_PID=$!

echo "[ap] Hotspot '${SSID}' ativo em ${AP_IP} (canal ${CHANNEL}). Pressione Ctrl+C para encerrar."
hostapd "${TMP_DIR}/hostapd.conf"
