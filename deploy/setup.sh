#!/usr/bin/env bash
# One-time server setup for nearProphet on Ubuntu (tested target: Google Cloud e2-micro, Ubuntu 24.04).
# Safe to run again: it only adds what is missing.
#   git clone https://github.com/emmyloyal/nearProphet.git ~/nearProphet && bash ~/nearProphet/deploy/setup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
echo "==> App folder: $APP_DIR (user: $APP_USER)"

# 1. Swap: the e2-micro has 1 GB RAM; npm install can need more.
if ! swapon --show | grep -q .; then
  echo "==> Adding 1 GB swap"
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 2. Node.js 24 LTS (the bot needs 22.13+ for its built-in SQLite), git, sqlite3 for backups
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git sqlite3 >/dev/null
echo "==> Node $(node -v)"

# 3. Dependencies
cd "$APP_DIR"
npm ci --no-audit --no-fund
mkdir -p data backups
chmod 700 data backups

# 4. Run as a service: starts on boot, restarts on crash
sed -e "s#__USER__#$APP_USER#g" -e "s#__DIR__#$APP_DIR#g" deploy/nearprophet.service | sudo tee /etc/systemd/system/nearprophet.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable nearprophet >/dev/null

# 5. Daily database backup at 03:00 (keeps 14 days)
chmod +x deploy/*.sh
( crontab -l 2>/dev/null | grep -v 'deploy/backup.sh' ; echo "0 3 * * * $APP_DIR/deploy/backup.sh >> $APP_DIR/backups/backup.log 2>&1" ) | crontab -

echo
if [ -f .env ]; then
  chmod 600 .env
  echo "==> .env found. Start the bot with:  sudo systemctl restart nearprophet"
else
  echo "==> Setup done. Next: upload .env (and data/bot.db) into $APP_DIR, then run:"
  echo "    chmod 600 $APP_DIR/.env && sudo systemctl start nearprophet"
fi
echo "    Logs: journalctl -u nearprophet -f"
