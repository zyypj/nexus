#!/bin/bash
# Nexus Server launcher for Pterodactyl (runs in /home/container on every start).
#
# 1. AUTO_UPDATE=1: compares the installed version with the newest GitHub
#    release (or NEXUS_VERSION if pinned), downloads it, verifies SHA-256 and
#    swaps the binary. A failed update never stops the server from starting.
# 2. Generates JWT_SECRET once (data/.jwt_secret) when the variable is empty.
# 3. Starts the server on the primary allocation.
set -u
cd "${CONTAINER_HOME:-/home/container}" || exit 1

REPO="${GITHUB_REPO:-zyypj/nexus}"
WANTED="${NEXUS_VERSION:-latest}"
ASSET="nexus-server-linux-x86_64.tar.gz"
DATA_DIR="${NEXUS_DATA_DIR:-$PWD/data}"

log() { echo "[nexus-start] $*"; }

# RELEASE_BASE: alternative download location (mirror or tests), laid out like
# GitHub's ".../releases/latest/download/<asset>".
release_url() {
  if [ -n "${RELEASE_BASE:-}" ]; then
    echo "${RELEASE_BASE%/}/$1"
  elif [ "$WANTED" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/$1"
  else
    echo "https://github.com/${REPO}/releases/download/v${WANTED#v}/$1"
  fi
}

update() {
  local remote current tmp
  remote=$(curl -fsSL --max-time 20 "$(release_url VERSION)" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$remote" ]; then
    log "could not reach GitHub releases of ${REPO}; keeping the installed version"
    return 0
  fi
  current=$(cat .nexus-version 2>/dev/null || echo "none")
  if [ "$remote" = "$current" ] && [ -f ./nexus-server ]; then
    log "up to date (${current})"
    return 0
  fi
  log "updating ${current} -> ${remote}"
  tmp=$(mktemp -d)
  if ! curl -fsSL --max-time 300 -o "$tmp/$ASSET" "$(release_url "$ASSET")" ||
     ! curl -fsSL --max-time 20 -o "$tmp/$ASSET.sha256" "$(release_url "$ASSET.sha256")"; then
    log "download failed; keeping the installed version"
    rm -rf "$tmp"; return 0
  fi
  if ! (cd "$tmp" && sha256sum -c "$ASSET.sha256" >/dev/null 2>&1); then
    log "checksum mismatch; refusing to install the download"
    rm -rf "$tmp"; return 0
  fi
  tar -xzf "$tmp/$ASSET" -C "$tmp" || { log "bad archive"; rm -rf "$tmp"; return 0; }
  # Atomic swaps: the running shell keeps reading the old script inode.
  install -m 0755 "$tmp/nexus-server" ./nexus-server.new && mv -f ./nexus-server.new ./nexus-server
  if [ -f "$tmp/nexus-start.sh" ]; then
    install -m 0755 "$tmp/nexus-start.sh" ./nexus-start.sh.new && mv -f ./nexus-start.sh.new ./nexus-start.sh
  fi
  echo "$remote" > .nexus-version
  rm -rf "$tmp"
  log "installed ${remote}"
}

case "${AUTO_UPDATE:-1}" in
  1|true|yes) update ;;
  *) log "auto update disabled (AUTO_UPDATE=${AUTO_UPDATE})" ;;
esac

if [ ! -x ./nexus-server ]; then
  log "nexus-server binary missing and no release could be downloaded; check GITHUB_REPO/NEXUS_VERSION"
  exit 1
fi

mkdir -p "$DATA_DIR"
if [ -z "${JWT_SECRET:-}" ]; then
  if [ ! -s "$DATA_DIR/.jwt_secret" ]; then
    (umask 077; head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DATA_DIR/.jwt_secret")
    log "generated a new JWT secret in $DATA_DIR/.jwt_secret"
  fi
  JWT_SECRET=$(cat "$DATA_DIR/.jwt_secret")
  export JWT_SECRET
fi

export NEXUS_DATA_DIR="$DATA_DIR"
export NEXUS_HOST="${NEXUS_HOST:-0.0.0.0}"
if [ -z "${NEXUS_PORT:-}" ]; then export NEXUS_PORT="${SERVER_PORT:-3000}"; fi
export NO_COLOR=1

log "starting nexus-server $(cat .nexus-version 2>/dev/null) on port ${NEXUS_PORT}"
chmod +x ./nexus-server
exec ./nexus-server serve
