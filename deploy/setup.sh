#!/bin/bash
# Run this on a fresh Hetzner CX22 (Ubuntu 24.04)
# Usage: ssh root@YOUR_IP 'bash -s' < deploy/setup.sh

set -euo pipefail

echo "=== Installing dependencies ==="
apt-get update
apt-get install -y curl git stockfish nginx certbot python3-certbot-nginx python3 make g++

# Node.js 20
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "Node: $(node -v)"
echo "npm: $(npm -v)"

# Install tsx globally
npm install -g tsx

# Create app user
if ! id -u chess &>/dev/null; then
  useradd -m -s /bin/bash chess
fi

echo "=== Cloning repo ==="
APP_DIR=/home/chess/app
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  git pull
else
  git clone https://github.com/unforced/agent-coordination-chess "$APP_DIR"
  cd "$APP_DIR"
fi

echo "=== Installing app dependencies ==="
npm ci
cd client && npm ci && npx vite build && cd ..
mkdir -p data

chown -R chess:chess "$APP_DIR"

echo "=== Creating systemd service ==="
cat > /etc/systemd/system/chess.service << 'UNIT'
[Unit]
Description=Agent Chess Lab
After=network.target

[Service]
Type=simple
User=chess
WorkingDirectory=/home/chess/app
ExecStart=/usr/bin/npx tsx server/server.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3001
EnvironmentFile=-/home/chess/app/.env

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable chess
systemctl restart chess

echo "=== Setting up nginx ==="
cat > /etc/nginx/sites-available/chess << 'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/chess /etc/nginx/sites-enabled/chess
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo ""
echo "=== Setup complete! ==="
echo "App running on port 3001, nginx proxying port 80."
echo ""
echo "Next steps:"
echo "1. Create /home/chess/app/.env with: CLAUDE_CODE_OAUTH_TOKEN=your-token"
echo "2. Point your domain's DNS A record to this server's IP"
echo "3. Run: certbot --nginx -d yourdomain.com"
echo "4. Restart: systemctl restart chess"
