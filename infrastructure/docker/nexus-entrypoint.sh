#!/bin/sh
# Entry point for the Nexus server image.
#
# - Plain Docker: runs the CMD ("nexus-server serve").
# - Pterodactyl: Wings passes the egg's startup line in $STARTUP with {{VAR}}
#   placeholders; they are expanded from the environment and executed.
#
# JWT_SECRET: if not provided, a random one is generated once and stored in
# the data directory (so it survives restarts but never lives in the egg).
set -eu

DATA_DIR="${NEXUS_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ -z "${JWT_SECRET:-}" ]; then
  SECRET_FILE="$DATA_DIR/.jwt_secret"
  if [ ! -s "$SECRET_FILE" ]; then
    umask 077
    head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"
    echo "nexus: generated a new JWT secret in $SECRET_FILE"
  fi
  JWT_SECRET="$(cat "$SECRET_FILE")"
  export JWT_SECRET
fi

# Pterodactyl provides the primary allocation as SERVER_PORT; an empty
# NEXUS_PORT egg variable means "listen on the allocation".
if [ -n "${SERVER_PORT:-}" ] && [ -z "${NEXUS_PORT:-}" ]; then
  export NEXUS_PORT="$SERVER_PORT"
fi

if [ -n "${STARTUP:-}" ]; then
  cd /home/container
  # {{VAR}} -> ${VAR}
  MODIFIED_STARTUP=$(echo "$STARTUP" | sed -e 's/{{/${/g' -e 's/}}/}/g')
  echo "nexus: starting: $MODIFIED_STARTUP"
  eval "exec $MODIFIED_STARTUP"
fi

exec "$@"
