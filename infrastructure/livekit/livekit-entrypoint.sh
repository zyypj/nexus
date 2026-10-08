#!/bin/sh
# Generates /home/container/livekit.yaml from environment variables, then
# starts LiveKit. Secrets are passed through LIVEKIT_KEYS (read by
# livekit-server) and are never written to disk.
#
# Port layout (2 Pterodactyl allocations):
#   allocation A = LIVEKIT_PORT    TCP: HTTP/WebSocket signaling
#                                  UDP: WebRTC media (UDP mux, single port)
#   allocation B = LIVEKIT_TCP_PORT TCP: ICE over TCP (networks blocking UDP)
# Optional allocation C = LIVEKIT_TURN_UDP_PORT for the embedded TURN server.
set -eu

: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"
if [ "${#LIVEKIT_API_SECRET}" -lt 32 ]; then
  echo "livekit: LIVEKIT_API_SECRET must be at least 32 characters" >&2
  exit 1
fi

PORT="${LIVEKIT_PORT:-${SERVER_PORT:-7880}}"
UDP_PORT="${LIVEKIT_UDP_PORT:-}"
[ -n "$UDP_PORT" ] || UDP_PORT="$PORT"
TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
CONFIG="${LIVEKIT_CONFIG_FILE:-/home/container/livekit.yaml}"

{
  echo "# Generated at startup by livekit-entrypoint. Do not edit: change the egg variables."
  echo "port: $PORT"
  echo "bind_addresses: ['0.0.0.0']"
  echo "rtc:"
  echo "  tcp_port: $TCP_PORT"
  echo "  udp_port: $UDP_PORT"
  if [ -n "${LIVEKIT_PUBLIC_IP:-}" ]; then
    echo "  use_external_ip: false"
    echo "  node_ip: ${LIVEKIT_PUBLIC_IP}"
  else
    echo "  use_external_ip: true"
  fi
  echo "room:"
  echo "  auto_create: true"
  echo "  empty_timeout: 60"
  echo "  departure_timeout: 20"
  echo "  max_participants: ${LIVEKIT_MAX_PARTICIPANTS:-25}"
  if [ -n "${LIVEKIT_WEBHOOK_URL:-}" ]; then
    echo "webhook:"
    echo "  api_key: ${LIVEKIT_API_KEY}"
    echo "  urls:"
    echo "    - ${LIVEKIT_WEBHOOK_URL}"
  fi
  case "${LIVEKIT_TURN_ENABLED:-false}" in
    true|1|yes)
      echo "turn:"
      echo "  enabled: true"
      if [ -n "${LIVEKIT_DOMAIN:-}" ]; then echo "  domain: ${LIVEKIT_DOMAIN}"; fi
      if [ -n "${LIVEKIT_TURN_UDP_PORT:-}" ]; then echo "  udp_port: ${LIVEKIT_TURN_UDP_PORT}"; fi
      if [ -n "${LIVEKIT_TURN_TLS_PORT:-}" ]; then
        echo "  tls_port: ${LIVEKIT_TURN_TLS_PORT}"
        echo "  cert_file: ${LIVEKIT_TURN_CERT:-/home/container/turn.crt}"
        echo "  key_file: ${LIVEKIT_TURN_KEY:-/home/container/turn.key}"
      fi
      ;;
  esac
  echo "logging:"
  echo "  level: ${LOG_LEVEL:-info}"
  echo "  json: false"
} > "$CONFIG"

export LIVEKIT_KEYS="${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
echo "livekit: signaling tcp/$PORT, media udp/$UDP_PORT, ice-tcp tcp/$TCP_PORT, public ip ${LIVEKIT_PUBLIC_IP:-auto (STUN)}"

if [ -n "${STARTUP:-}" ]; then
  cd /home/container
  MODIFIED_STARTUP=$(echo "$STARTUP" | sed -e 's/{{/${/g' -e 's/}}/}/g')
  eval "exec $MODIFIED_STARTUP"
fi
exec "$@"
