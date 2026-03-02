#!/usr/bin/env bash
set -e

CONTAINER_NAME="mom-whatsapp-sandbox"
DATA_DIR="$(pwd)/live-data"

if [ -z "$MOM_WA_AUTH_DIR" ]; then
  export MOM_WA_AUTH_DIR="$HOME/.pi/mom-whatsapp/wa-auth"
  echo "MOM_WA_AUTH_DIR not set. Using default: $MOM_WA_AUTH_DIR"
fi

mkdir -p "$DATA_DIR"
mkdir -p "$MOM_WA_AUTH_DIR"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Starting existing container: $CONTAINER_NAME"
    docker start "$CONTAINER_NAME"
  else
    echo "Container $CONTAINER_NAME already running"
  fi
else
  echo "Creating container: $CONTAINER_NAME"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --security-opt label=disable \
    -v "$DATA_DIR:/workspace" \
    debian:bookworm-slim \
    tail -f /dev/null
  echo "Installing runtime dependencies in $CONTAINER_NAME"
  docker exec "$CONTAINER_NAME" /bin/sh -lc "set -e; apt-get update >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl nodejs npm python3 python3-venv unzip poppler-utils >/dev/null; curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null; ln -sf /root/.local/bin/uv /usr/local/bin/uv; ln -sf /root/.local/bin/uvx /usr/local/bin/uvx"
fi

echo "Starting mom-whatsapp in dev mode..."
npx tsx --watch-path src --watch src/main.ts --sandbox=docker:$CONTAINER_NAME ./live-data
