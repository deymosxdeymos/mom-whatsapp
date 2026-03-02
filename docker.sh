#!/usr/bin/env bash

CONTAINER_NAME="mom-whatsapp-sandbox"
IMAGE="debian:bookworm-slim"

case "$1" in
  create)
    if [ -z "$2" ]; then
      echo "Usage: $0 create <data-dir>"
      echo "Example: $0 create ./data"
      exit 1
    fi

    if ! mkdir -p "$2"; then
      echo "Failed to create data directory: $2"
      exit 1
    fi

    DATA_DIR=$(cd "$2" && pwd)

    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' already exists. Remove it first with: $0 remove"
      exit 1
    fi

    echo "Creating container '${CONTAINER_NAME}'..."
    echo "  Data dir: ${DATA_DIR} -> /workspace"

    docker run -d \
      --name "$CONTAINER_NAME" \
      --security-opt label=disable \
      -v "${DATA_DIR}:/workspace" \
      "$IMAGE" \
      tail -f /dev/null

    if [ $? -eq 0 ]; then
      echo "Installing runtime dependencies (node, uv, unzip, poppler-utils)..."
      if ! docker exec "$CONTAINER_NAME" /bin/sh -lc "set -e; apt-get update >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl nodejs npm python3 python3-venv unzip poppler-utils >/dev/null; curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null; ln -sf /root/.local/bin/uv /usr/local/bin/uv; ln -sf /root/.local/bin/uvx /usr/local/bin/uvx"; then
        echo "Failed to install runtime dependencies inside container."
        echo "Removing incomplete container '${CONTAINER_NAME}'..."
        docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
        exit 1
      fi

      echo "Container created and running."
      echo ""
      echo "Run mom-whatsapp with: mom-whatsapp --sandbox=docker:${CONTAINER_NAME} $2"
    else
      echo "Failed to create container."
      exit 1
    fi
    ;;

  start)
    docker start "$CONTAINER_NAME"
    ;;

  stop)
    docker stop "$CONTAINER_NAME"
    ;;

  remove)
    docker rm -f "$CONTAINER_NAME"
    ;;

  status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' is running."
      docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.ID}}\t{{.Image}}\t{{.Status}}"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' exists but is not running."
      echo "Start it with: $0 start"
    else
      echo "Container '${CONTAINER_NAME}' does not exist."
      echo "Create it with: $0 create <data-dir>"
    fi
    ;;

  shell)
    docker exec -it "$CONTAINER_NAME" /bin/sh
    ;;

  *)
    echo "mom-whatsapp Docker Sandbox Management"
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Commands:"
    echo "  create <data-dir>  - Create and start the container"
    echo "  start              - Start the container"
    echo "  stop               - Stop the container"
    echo "  remove             - Remove the container"
    echo "  status             - Check container status"
    echo "  shell              - Open a shell in the container"
    ;;
esac
