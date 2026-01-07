#!/usr/bin/env bash
set -euo pipefail

# Hotspot fallback using NetworkManager.
# If not connected to Wi-Fi, bring up an AP so the user can configure Wi-Fi.

IFACE="${CHROMA_WIFI_IFACE:-wlan0}"
AP_SSID="${CHROMA_AP_SSID:-Chroma-Setup}"
AP_PASS="${CHROMA_AP_PASS:-chroma-setup}"
AP_CONN_NAME="${CHROMA_AP_CONN_NAME:-chroma-hotspot}"
SLEEP_S="${CHROMA_WIFI_POLL_S:-10}"

# When the user requests a Wi‑Fi connection via the panel, the backend will create this
# lock so the watchdog doesn't immediately re-enable hotspot and interrupt the join.
LOCK_FILE="${CHROMA_WIFI_LOCK_FILE:-/run/gabiru-wifi-connect.lock}"
LOCK_MAX_AGE_S="${CHROMA_WIFI_LOCK_MAX_AGE_S:-180}"

# If this file exists, hotspot will never be started again until reboot.
# Use /run so it's cleared on reboot.
HOTSPOT_DISABLE_FILE="${CHROMA_WIFI_HOTSPOT_DISABLE_FILE:-/run/gabiru-hotspot-disabled.lock}"

# Tolerance: only activate hotspot after persistent disconnection for this many seconds.
# This prevents hotspot flapping during WiFi connection stabilization.
DISCONNECT_GRACE_PERIOD_S="${CHROMA_WIFI_DISCONNECT_GRACE_PERIOD_S:-120}"

# Keep hotspot up for a bit after a successful Wi-Fi connection so the user can stay on
# the configuration page. After this hold, hotspot will be turned off.
HOTSPOT_HOLD_AFTER_CONNECT_S="${CHROMA_WIFI_HOTSPOT_HOLD_AFTER_CONNECT_S:-120}"

# Tracks the timestamp when we first detected disconnection.
DISCONNECT_START_TS=0
# Tracks when Wi-Fi became connected (used to delay hotspot shutdown).
CONNECTED_START_TS=0

log() {
  echo "[gabiru-wifi] $*"
}

if ! command -v nmcli >/dev/null 2>&1; then
  log "nmcli não encontrado; fallback de Wi‑Fi desativado"
  exit 0
fi

# Ensure NetworkManager is up (best-effort)
if command -v systemctl >/dev/null 2>&1; then
  systemctl start NetworkManager.service >/dev/null 2>&1 || true
fi

is_wifi_connected() {
  # Check actual IP address connectivity on the interface.
  # This is more reliable than just checking connection state.
  local ip4_addr
  ip4_addr="$(
    nmcli -t -f DEVICE,IP4.ADDRESS dev show "${IFACE}" 2>/dev/null \
      | grep "^IP4\.ADDRESS" | head -1 | cut -d: -f2 | xargs
  )"
  
  # Must have a non-zero, non-localhost IP
  if [[ -n "${ip4_addr}" ]] && [[ "${ip4_addr}" != "127.0.0.1"* ]] && [[ "${ip4_addr}" != "0.0.0.0"* ]]; then
    # Also verify it's not the hotspot IP range
    if [[ "${ip4_addr}" != "10.42.0."* ]]; then
      return 0
    fi
  fi
  
  return 1
}

is_hotspot_active() {
  nmcli -t -f NAME,DEVICE,TYPE,STATE con show --active | grep -Eq "^${AP_CONN_NAME}:${IFACE}:(wifi|802-11-wireless):activated$"
}

ensure_wifi_radio_on() {
  nmcli radio wifi on >/dev/null 2>&1 || true
}

lock_is_active() {
  [[ -f "${LOCK_FILE}" ]] || return 1

  # If the lock is stale, ignore it.
  local now mtime age
  now="$(date +%s)"
  mtime="$(stat -c %Y "${LOCK_FILE}" 2>/dev/null || echo 0)"
  age=$(( now - mtime ))
  (( age >= 0 && age <= LOCK_MAX_AGE_S ))
}

is_wifi_connecting() {
  nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status \
    | awk -F: -v iface="${IFACE}" '$1==iface && $2=="wifi" && $3 ~ /^connecting/ {exit 0} END {exit 1}'
}

start_hotspot() {
  if is_hotspot_active; then
    return 0
  fi

  log "iniciando hotspot SSID=${AP_SSID}"

  ensure_wifi_radio_on

  nmcli con down "${AP_CONN_NAME}" >/dev/null 2>&1 || true
  nmcli con delete "${AP_CONN_NAME}" >/dev/null 2>&1 || true

  # nmcli will create a shared connection with DHCP/NAT.
  local out
  # NetworkManager CLI uses "con-name" (some environments might accept other aliases).
  if out="$(nmcli dev wifi hotspot ifname "${IFACE}" ssid "${AP_SSID}" password "${AP_PASS}" con-name "${AP_CONN_NAME}" 2>&1)"; then
    log "hotspot iniciado: ${out}"
    return 0
  fi

  # Fallback for environments that might not support "con-name".
  if out2="$(nmcli dev wifi hotspot ifname "${IFACE}" ssid "${AP_SSID}" password "${AP_PASS}" name "${AP_CONN_NAME}" 2>&1)"; then
    log "hotspot iniciado: ${out2}"
    return 0
  fi

  log "falha ao iniciar hotspot: ${out}"
  log "falha ao iniciar hotspot (fallback): ${out2}"
  return 1
}

stop_hotspot() {
  nmcli con down "${AP_CONN_NAME}" >/dev/null 2>&1 || true
}

disable_hotspot_until_reboot() {
  mkdir -p "$(dirname "${HOTSPOT_DISABLE_FILE}")" >/dev/null 2>&1 || true
  echo "$(date -Is)" >"${HOTSPOT_DISABLE_FILE}" 2>/dev/null || true
}

hotspot_is_disabled() {
  [[ -f "${HOTSPOT_DISABLE_FILE}" ]]
}

log "monitorando iface=${IFACE} (tolerância desconectado: ${DISCONNECT_GRACE_PERIOD_S}s, espera após conectar: ${HOTSPOT_HOLD_AFTER_CONNECT_S}s)"

# If we already have Wi-Fi at boot, never enable hotspot in this boot session.
if is_wifi_connected; then
  disable_hotspot_until_reboot
  stop_hotspot
  log "wifi conectado no boot; hotspot desativado até reiniciar"
fi

while true; do
  # During explicit connect attempts, leave hotspot as-is so the user can keep the page open.
  if lock_is_active || is_wifi_connecting; then
    DISCONNECT_START_TS=0  # Reset grace period timer during active connection attempt
    CONNECTED_START_TS=0
    sleep "${SLEEP_S}"
    continue
  fi

  if is_wifi_connected; then
    DISCONNECT_START_TS=0  # Reset timer on successful connection

    # Once Wi-Fi is connected, disable hotspot for the rest of this boot.
    if ! hotspot_is_disabled; then
      disable_hotspot_until_reboot
      log "wifi conectado; hotspot desativado até reiniciar"
    fi

    if is_hotspot_active; then
      # Requirement: if Wi-Fi is connected, hotspot should turn off.
      log "wifi conectado; desligando hotspot"
      stop_hotspot
    else
      # Hotspot already down.
      CONNECTED_START_TS=0
    fi
  else
    CONNECTED_START_TS=0

    # If Wi-Fi has connected at least once this boot, never start hotspot again.
    if hotspot_is_disabled; then
      DISCONNECT_START_TS=0
      if is_hotspot_active; then
        log "hotspot desativado; desligando hotspot"
        stop_hotspot
      fi
      sleep "${SLEEP_S}"
      continue
    fi

    # WiFi is disconnected; start grace period timer if not already started
    if [[ ${DISCONNECT_START_TS} -eq 0 ]]; then
      DISCONNECT_START_TS="$(date +%s)"
      log "wifi desconectado; iniciando tolerância (${DISCONNECT_GRACE_PERIOD_S}s)"
    fi

    # Check if grace period has elapsed
    now="$(date +%s)"
    elapsed=$(( now - DISCONNECT_START_TS ))

    if [[ ${elapsed} -ge ${DISCONNECT_GRACE_PERIOD_S} ]]; then
      # Grace period expired; activate hotspot
      ensure_wifi_radio_on
      start_hotspot || true
    else
      # Still within grace period; wait a bit longer before activating hotspot
      log "tolerância: ${elapsed}/${DISCONNECT_GRACE_PERIOD_S}s"
    fi
  fi

  sleep "${SLEEP_S}"
done
