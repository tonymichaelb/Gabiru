#!/usr/bin/env bash
set -euo pipefail

# Hotspot fallback using NetworkManager.
# If not connected to Wi-Fi, bring up an AP so the user can configure Wi-Fi.

IFACE="${CHROMA_WIFI_IFACE:-wlan0}"
AP_SSID="${CHROMA_AP_SSID:-Chroma-Setup}"
AP_PASS="${CHROMA_AP_PASS:-chroma-setup}"
AP_CONN_NAME="${CHROMA_AP_CONN_NAME:-chroma-hotspot}"
SLEEP_S="${CHROMA_WIFI_POLL_S:-10}"

log() {
  echo "[gabiru-wifi] $*"
}

if ! command -v nmcli >/dev/null 2>&1; then
  log "nmcli not found; Wi-Fi fallback disabled"
  exit 0
fi

# Ensure NetworkManager is up (best-effort)
if command -v systemctl >/dev/null 2>&1; then
  systemctl start NetworkManager.service >/dev/null 2>&1 || true
fi

is_wifi_connected() {
  # Example line: wlan0:wifi:connected:MySSID
  # Some NM versions report "connected (externally)".
  local conn_name
  conn_name="$(
    nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status \
      | awk -F: -v iface="${IFACE}" '$1==iface && $2=="wifi" && $3 ~ /^connected/ {print $4; exit 0} END {exit 1}'
  )" || return 1

  [[ -n "${conn_name}" ]] && [[ "${conn_name}" != "${AP_CONN_NAME}" ]]
}

is_hotspot_active() {
  nmcli -t -f NAME,DEVICE,TYPE,STATE con show --active | grep -Eq "^${AP_CONN_NAME}:${IFACE}:(wifi|802-11-wireless):activated$"
}

ensure_wifi_radio_on() {
  nmcli radio wifi on >/dev/null 2>&1 || true
}

start_hotspot() {
  if is_hotspot_active; then
    return 0
  fi

  log "starting hotspot SSID=${AP_SSID}"

  ensure_wifi_radio_on

  nmcli con down "${AP_CONN_NAME}" >/dev/null 2>&1 || true
  nmcli con delete "${AP_CONN_NAME}" >/dev/null 2>&1 || true

  # nmcli will create a shared connection with DHCP/NAT.
  local out
  # NetworkManager CLI uses "con-name" (some environments might accept other aliases).
  if out="$(nmcli dev wifi hotspot ifname "${IFACE}" ssid "${AP_SSID}" password "${AP_PASS}" con-name "${AP_CONN_NAME}" 2>&1)"; then
    log "hotspot started: ${out}"
    return 0
  fi

  # Fallback for environments that might not support "con-name".
  if out2="$(nmcli dev wifi hotspot ifname "${IFACE}" ssid "${AP_SSID}" password "${AP_PASS}" name "${AP_CONN_NAME}" 2>&1)"; then
    log "hotspot started: ${out2}"
    return 0
  fi

  log "hotspot failed: ${out}"
  log "hotspot failed (fallback): ${out2}"
  return 1
}

stop_hotspot() {
  nmcli con down "${AP_CONN_NAME}" >/dev/null 2>&1 || true
}

log "monitoring iface=${IFACE}"

while true; do
  if is_wifi_connected; then
    if is_hotspot_active; then
      log "wifi connected; stopping hotspot"
      stop_hotspot
    fi
  else
    start_hotspot || true
  fi

  sleep "${SLEEP_S}"
done
