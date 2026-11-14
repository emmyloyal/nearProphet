#!/usr/bin/env bash
# Consistent copy of the database (safe while the bot runs). Keeps the last 14 days.
# These backups live on the same server: also download one now and then (see DEPLOY.md).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
DB="$(grep -E '^DB_PATH=' .env 2>/dev/null | cut -d= -f2- | tr -d '\r')"
DB="${DB:-./data/bot.db}"
[ -f "$DB" ] || { echo "$(date -Is) no database at $DB"; exit 0; }
mkdir -p backups
OUT="backups/bot-$(date +%Y%m%d-%H%M).db"
sqlite3 "$DB" ".backup '$OUT'"
chmod 600 "$OUT"
find backups -name 'bot-*.db' -mtime +14 -delete
echo "$(date -Is) saved $OUT"
