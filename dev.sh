#!/usr/bin/env bash
set -e

CONTAINER_NAME="mom-whatsapp-sandbox"
DATA_DIR="$(pwd)/data"

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
    alpine:latest \
    tail -f /dev/null
fi

echo "Starting mom-whatsapp in dev mode..."
npx tsx --watch-path src --watch src/main.ts --sandbox=docker:$CONTAINER_NAME ./data
