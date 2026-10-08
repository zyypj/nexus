#!/bin/bash
# LiveKit launcher for Pterodactyl (runs in /home/container on every start).
#
# 1. Installs/updates the official livekit-server binary from
#    github.com/livekit/livekit releases (LIVEKIT_VERSION: pinned version or
#    "latest"), verifying the published SHA-256 checksum.
# 2. Writes livekit.yaml from the egg variables (secrets stay in LIVEKIT_KEYS,
#    never in the file).
# 3. Starts LiveKit.
set -u
cd "${CONTAINER_HOME:-/home/container}" || exit 1

log() { echo "[livekit-start] $*"; }

# 0. Keeps this launcher itself up to date from the Nexus release (GITHUB_REPO),
#    verifying the published SHA-256, then re-executes the new version once.
self_update() {
  local repo="${GITHUB_REPO:-zyypj/nexus}" base tmp
  base="${RELEASE_BASE:-https://github.com/${repo}/releases/latest/download}"
  tmp=$(mktemp -d)
  if curl -fsSL --max-time 20 -o "$tmp/livekit-start.sh" "${base%/}/livekit-start.sh" 2>/dev/null &&
     curl -fsSL --max-time 20 -o "$tmp/livekit-start.sh.sha256" "${base%/}/livekit-start.sh.sha256" 2>/dev/null &&
     (cd "$tmp" && sha256sum -c livekit-start.sh.sha256 >/dev/null 2>&1); then
    if ! cmp -s "$tmp/livekit-start.sh" ./livekit-start.sh; then
      install -m 0755 "$tmp/livekit-start.sh" ./livekit-start.sh.new && mv -f ./livekit-start.sh.new ./livekit-start.sh
      rm -rf "$tmp"
      log "launcher updated; restarting it"
      NEXUS_LAUNCHER_UPDATED=1 exec bash ./livekit-start.sh
    fi
  else
    log "could not check for a launcher update; using the current one"
  fi
  rm -rf "$tmp"
}
case "${AUTO_UPDATE:-1}" in
  1|true|yes) [ -n "${NEXUS_LAUNCHER_UPDATED:-}" ] || self_update ;;
esac

WANTED="${LIVEKIT_VERSION:-1.13.9}"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) log "unsupported architecture $(uname -m)"; exit 1 ;;
esac

install_livekit() {
  local version="$WANTED" tmp asset base
  if [ "$version" = "latest" ]; then
    version=$(curl -fsSL --max-time 20 https://api.github.com/repos/livekit/livekit/releases/latest 2>/dev/null |
      grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')
    if [ -z "$version" ]; then
      log "could not query the latest LiveKit release; keeping the installed binary"
      return 0
    fi
  fi
  version="${version#v}"
  if [ -f ./livekit-server ] && [ "$(cat .livekit-version 2>/dev/null)" = "$version" ]; then
    log "livekit-server ${version} already installed"
    return 0
  fi
  asset="livekit_${version}_linux_${ARCH}.tar.gz"
  base="https://github.com/livekit/livekit/releases/download/v${version}"
  tmp=$(mktemp -d)
  log "downloading LiveKit ${version} (${ARCH})"
  if ! curl -fsSL --max-time 300 -o "$tmp/$asset" "$base/$asset" ||
     ! curl -fsSL --max-time 20 -o "$tmp/checksums.txt" "$base/checksums.txt"; then
    log "download failed; keeping the installed binary"
    rm -rf "$tmp"; return 0
  fi
  if ! (cd "$tmp" && grep " ${asset}\$" checksums.txt | sha256sum -c - >/dev/null 2>&1); then
    log "checksum mismatch for ${asset}; refusing to install"
    rm -rf "$tmp"; return 0
  fi
  tar -xzf "$tmp/$asset" -C "$tmp" livekit-server || { log "bad archive"; rm -rf "$tmp"; return 0; }
  install -m 0755 "$tmp/livekit-server" ./livekit-server.new && mv -f ./livekit-server.new ./livekit-server
  echo "$version" > .livekit-version
  rm -rf "$tmp"
  log "installed livekit-server ${version}"
}

case "${AUTO_UPDATE:-1}" in
  1|true|yes) install_livekit ;;
  *) [ -f ./livekit-server ] || install_livekit ;;
esac
[ -f ./livekit-server ] || { log "livekit-server is not installed"; exit 1; }

: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"
if [ "${#LIVEKIT_API_SECRET}" -lt 32 ]; then
  log "LIVEKIT_API_SECRET must be at least 32 characters"; exit 1
fi

PORT="${LIVEKIT_PORT:-}"; [ -n "$PORT" ] || PORT="${SERVER_PORT:-7880}"
UDP_PORT="${LIVEKIT_UDP_PORT:-}"; [ -n "$UDP_PORT" ] || UDP_PORT="$PORT"
TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"

{
  echo "# Generated at every start by livekit-start.sh. Change the egg variables instead."
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
} > livekit.yaml

log "signaling tcp/$PORT, media udp/$UDP_PORT, ice-tcp tcp/$TCP_PORT, public ip ${LIVEKIT_PUBLIC_IP:-auto (STUN)}"
# livekit-server also reads every config field from LIVEKIT_<FIELD> env vars,
# which override livekit.yaml: an empty egg variable such as LIVEKIT_PORT
# would silently turn the signaling port into 0. Hand it only the keys.
KEYS="${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
for v in $(compgen -e); do
  case "$v" in LIVEKIT_*) unset "$v" ;; esac
done
export LIVEKIT_KEYS="$KEYS"
chmod +x ./livekit-server
exec ./livekit-server --config livekit.yaml
