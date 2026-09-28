#!/bin/sh
# Volumes can arrive owned by root — Fly mounts them that way — which the node user
# cannot write. Started as root, take ownership of the data dir, then drop to node
# for the server itself. Started as anyone else, just run.
set -e

if [ "$(id -u)" = 0 ]; then
  chown -R node:node "${NEMLIG_DATA_DIR:-/data}" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
