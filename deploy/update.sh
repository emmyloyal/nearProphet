#!/usr/bin/env bash
# Pull the latest code from GitHub, install dependencies, run the tests, restart the bot.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
./deploy/backup.sh
git pull --ff-only
npm ci --no-audit --no-fund
npm test >/tmp/nearprophet-test.log 2>&1 || { echo "Tests failed; NOT restarting. See /tmp/nearprophet-test.log"; exit 1; }
sudo systemctl restart nearprophet
sleep 5
systemctl --no-pager --lines=5 status nearprophet
