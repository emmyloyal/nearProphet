# Running nearProphet on your Windows PC (free)

The bot runs hidden in the background, starts by itself when you log in to Windows, and restarts within 15 seconds if it crashes. It only runs while the PC is **on, awake and online**. While the PC sleeps or is shut down, there are no alerts or reports.

Run these in PowerShell from the `nearProphet` folder:

| What | Command |
|---|---|
| Start automatically at every login (one-time setup) | `powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1` |
| Start now | `powershell -ExecutionPolicy Bypass -File deploy\windows\start-bot.ps1` |
| Stop | `powershell -ExecutionPolicy Bypass -File deploy\windows\stop-bot.ps1` |
| Restart (e.g. after editing `.env`) | Stop, then Start |
| Stop starting at login | `powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall.ps1` |
| Back up the database now | `npm run backup` |

- **Logs:** one file per day in `logs\bot-YYYYMMDD.log`, kept for 14 days.
- **Backups:** the database is copied to `backups\` each time the bot starts, then once a day, and copies are kept for 14 days. Also copy the newest backup and `.env` somewhere off this PC now and then, such as a USB stick or a password manager.
- **Laptops:** set sleep to *Never* when plugged in (Settings → System → Power), keep it plugged in, and don't close the lid unless *When I close the lid* is set to *Do nothing* (Control Panel → Power Options → Choose what closing the lid does).
- **One copy only:** don't also run `npm start` while the background bot is running. Two copies fight over Telegram messages.

---

# Hosting nearProphet for free on Google Cloud

The bot runs 24/7 on Google Cloud's free **e2-micro** server: 1 GB RAM and a 30 GB disk, free with no end date if you stay inside the limits below. It takes about 20 minutes.

> ⚠️ Run only **one** copy of the bot at a time. Two copies using the same bot token fight over Telegram messages (error 409). Stop the copy on your PC before starting the server.

## 1. Create the account (one time)
1. Go to https://cloud.google.com/free and sign in with a Google account.
2. Add a payment card. Google asks for one, but the e2-micro is free inside the limits below.
3. **Set a budget alert** so you hear about it if anything is ever charged: **Billing → Budgets & alerts → Create budget**, amount **$1**, with email alerts on.

## 2. Create the server
**Compute Engine → VM instances → Create instance** (click *Enable* if asked), then set:

| Setting | Value | Why |
|---|---|---|
| Name | `nearprophet` | |
| Region | **us-west1 (Oregon)**, **us-central1 (Iowa)** or **us-east1 (South Carolina)** | Only these are free |
| Machine type | **e2-micro** | The free one |
| Boot disk → Change | **Ubuntu 24.04 LTS**, **Standard persistent disk**, **30 GB** | "Balanced" or "SSD" disks are **not** free |
| Firewall | leave HTTP/HTTPS **unticked** | The bot needs no open ports |

Click **Create**. The page may show a monthly estimate; the free tier is applied to your bill afterwards.

## 3. Install the bot on the server
Click **SSH** next to the server. A terminal opens in your browser. Paste:

```bash
git clone https://github.com/emmyloyal/nearProphet.git ~/nearProphet && bash ~/nearProphet/deploy/setup.sh
```

This takes a few minutes. It installs Node.js, the bot, a service that restarts the bot after crashes and reboots, and a daily database backup.

## 4. Move your settings and wallets from your PC
The server needs two files from your PC:
- **`.env`**: your bot token, `MASTER_KEY` and AI key
- **`data/bot.db`**: the users' wallets (keys encrypted with `MASTER_KEY`)

**Without both, existing wallets are lost.** The two belong together: a database without its `MASTER_KEY` cannot be decrypted.

1. **Stop the bot on your PC** first, so the database file is complete and only one copy runs.
2. In the SSH window, click **Upload file** (the ⬆ icon at the top right) and upload `.env`. Upload `bot.db` the same way. Both land in your home folder.
3. Move them into place and start the bot:

```bash
mv ~/.env ~/nearProphet/.env && mv ~/bot.db ~/nearProphet/data/bot.db
chmod 600 ~/nearProphet/.env ~/nearProphet/data/bot.db
sudo systemctl start nearprophet
journalctl -u nearprophet -n 20 --no-pager
```

You should see `Running as @NearProphetbot`. Close the browser tab; the bot keeps running.

## Everyday commands (in the SSH window)
| What | Command |
|---|---|
| Live logs | `journalctl -u nearprophet -f` (Ctrl+C to stop watching) |
| Is it running? | `systemctl status nearprophet` |
| Restart (e.g. after editing `.env`) | `sudo systemctl restart nearprophet` |
| Edit settings | `nano ~/nearProphet/.env`, then restart |
| Update to the latest code from GitHub | `bash ~/nearProphet/deploy/update.sh` (backs up, runs the tests, and restarts only if they pass) |
| Back up now | `bash ~/nearProphet/deploy/backup.sh` |

## Backups
- A copy of the database is saved every day at 03:00 (server time) in `~/nearProphet/backups/`, and copies are kept for 14 days.
- Those copies sit on the same server, so **once in a while download the newest one** (SSH window → ⚙ → **Download file** → `/home/<you>/nearProphet/backups/bot-….db`) and keep it with your `.env`.
- Keep a copy of `.env` (above all `MASTER_KEY`) somewhere safe off the server, such as a password manager. If both the server and that copy are lost, every bot wallet is lost.

## Staying free
- Keep exactly **one e2-micro** in one of the three US regions, with a **Standard** disk of 30 GB or less.
- The free tier includes 1 GB of outbound traffic a month. The bot uses far less: Telegram messages and market data are small.
- Don't add extras such as a static IP, snapshots or load balancers; they cost money.
- The $1 budget alert tells you if anything changes.

## Security notes
- Anyone with access to this server can read `.env` and the database, which is enough to take the funds in every bot wallet. Use a strong password on your Google account and turn on 2-step verification.
- The server has no open ports; you reach it only through Google's SSH button.
