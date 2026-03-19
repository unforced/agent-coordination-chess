#!/bin/bash
# Quick deploy: pull latest code and restart
# Usage: ssh root@YOUR_IP 'bash -s' < deploy/update.sh

set -euo pipefail

APP_DIR=/home/chess/app
cd "$APP_DIR"

echo "=== Pulling latest ==="
git pull

echo "=== Installing dependencies ==="
npm ci
cd client && npm ci && npx vite build && cd ..

chown -R chess:chess "$APP_DIR"

echo "=== Restarting ==="
systemctl restart chess

echo "=== Done! ==="
systemctl status chess --no-pager
