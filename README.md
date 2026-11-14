# NEAR Trading Bot (Telegram)

A Telegram bot for NEAR Protocol. It can:
- create a wallet for each user
- look up and analyze tokens
- buy and sell tokens on Ref Finance
- open long and short trades (paper money for now)
- watch open trades and tell you whether to hold or close
- send scheduled trade reports: trend, estimated odds for the next 24 hours, and news

It also has an **AI agent (Claude)** that takes part in every step. It chats in any language and replies in that language. It explains analyses and trades, searches the web for token news, and can propose any trade. It never moves money itself: every trade it proposes shows a Confirm button that only the user can press.

**Status:** this version runs on testnet. Long/short trades use paper money against live prices.

## Commands
| Command | What it does |
|---|---|
| `/wallet` | Create or view your bot wallet, balances and paper balance |
| `/export` | Show your private key. Private chat only; the message deletes itself after 60s |
| `/connect <account>` | Watch a wallet you already own, read-only (the bot never asks for its key) |
| `/token <symbol or contract>` | Price, 1h/6h/24h change, market cap, liquidity, volume, buys and sells |
| `/analyze <symbol or contract>` | Deep analysis: market bias, safety score (0–100), risk flags, technicals |
| `/buy <token> <NEAR>` | Get a quote, then confirm with a button. Swaps on Ref Finance |
| `/sell <token> <amount or 50%>` | Get a quote, then confirm. Sells the token for NEAR |
| `/long <token> <$collateral> <leverage>` | Open a long |
| `/short <token> <$collateral> <leverage>` | Open a short |
| `/positions` | Open trades with live profit and loss (PnL) |
| `/check [id]` | Live read of a trade: **HOLD / TAKE PROFIT / REDUCE / CLOSE**, with reasons |
| `/close <id>` | Close a trade |
| `/report now` | Trade report for your open trades: trend, 24h odds, news, and AI options |
| `/report <hours>` / `/report off` | Get a report automatically every 1–24 hours, or stop them |

## The AI agent
Set one key in `.env` to switch it on. Without a key, the bot runs on rules only and everything else still works.

| Provider | Key | Notes |
|---|---|---|
| NEAR AI Cloud | `NEAR_AI_API_KEY` | Pay per token, private inference. Offers Claude (`claude-sonnet-5-5` is sent as `anthropic/claude-sonnet-5-5`) and open models such as `deepseek/deepseek-v4.1-flash`. |
| Anthropic | `ANTHROPIC_API_KEY` | The only provider with live web search. |
| Any OpenAI-compatible API | `AI_PROVIDER=openai`, `AI_BASE_URL`, `AI_API_KEY` | OpenRouter, Groq, Gemini and others. |

If several keys are set, NEAR AI is used. Every provider gets headlines through the `get_news` tool.

| Where | What the AI does |
|---|---|
| Chat | Users type normally in any language, e.g. "buy 2 NEAR of REF", "how my short dey go?", "¿debo cerrar mi long?". The AI reads data with tools and answers in the same language. |
| `/analyze` | Adds a plain-language read under the numbers. May search the web for recent news. |
| `/check` | Explains hold or close for each trade, building on the rule verdict. |
| Alerts | When a trade's verdict changes, adds a short note in the user's last language (uses the cheaper model). |
| Reports | Explains what the trend, odds and news mean for each trade, with two or three options and a price level for each. The trader decides. |
| Trades | Can propose buy, sell, long, short or close. The user gets a Confirm/Cancel button; proposals expire after 60s and work once. |

What the AI cannot do:
- see private keys
- execute a trade without a tap
- override an urgent liquidation warning from the rules
- reply in group chats (wallet and trade data stay private)

Text inside token data and web pages is treated as data, not instructions.

**Languages.** The AI replies in the language of the user's latest message and remembers it for alerts. Before a user's first chat, it uses their Telegram app language. Command names, buttons and the trade confirmation summaries stay in English.

**Cost control.** Each user is capped at `AI_DAILY_LIMIT` AI replies per day. Web search uses at most 3 searches per question, and you can turn it off with `AI_WEB_SEARCH=off`. The automatic 5-minute re-check runs on rules only, so the AI is called only when a verdict changes.

## How the hold-or-close read works
Every few minutes (`MONITOR_INTERVAL_SEC`, 300 by default) the bot rechecks every open trade against live hourly candles. It messages the user when the verdict changes. It checks, in this order:
1. **Liquidation risk.** How far is liquidation, compared with a normal hourly price swing (ATR)?
2. **Losing trades.** Is the trend against you? It checks price against the 20- and 50-hour averages (EMA20/EMA50) and momentum (MACD).
3. **Winning trades.** Has the trend flipped against you, or is the move overstretched (high RSI, fading momentum)? If so, take profit.

When the verdict is HOLD, it also suggests a stop-loss 2 ATR behind the current price. Paper positions are liquidated automatically if the price crosses the liquidation price.

The verdict comes from fixed rules applied to the signals. It is not a guarantee.

## Trade reports
Every `REPORT_INTERVAL_HOURS` (4 by default), each trader with open trades gets a report. Users can change their interval with `/report <hours>` or turn it off with `/report off`. For each trade it shows:
- the rule verdict and the hourly and 5-minute trend
- **estimated odds for the next 24 hours**: the chance of touching the suggested stop, a target the same distance above (2 ATR), and liquidation; the chance of being in profit at the end; and the likely price range
- recent headlines about the token

Then the AI, if switched on, explains the options.

**How the odds work.** The bot takes the last 2 days of real 5-minute price moves and replays them in random order 2,000 times over the next 24 hours. It counts how often each level is touched. The moves are de-meaned, so the odds reflect how much the price swings, not which way it has been heading; trend is shown separately. They are estimates. They cannot foresee news, hacks or sudden crashes, and they are less reliable for thin tokens.

**News.** Headlines come from the free public RSS feeds of Cointelegraph, Decrypt, The Block and CoinDesk; change them with `NEWS_FEEDS`. These feeds hold only the latest stories, roughly the last day or two, so smaller tokens are often not mentioned. The report then says there is no token news and the AI uses general market headlines. Headlines are third-party text: they are escaped before display, and the AI treats them as data, not instructions.

## Project layout
```
src/
  index.ts      starts the bot and the monitor
  bot.ts        Telegram commands
  config.ts     settings from .env
  db.ts         SQLite: users, positions, trade log
  crypto.ts     AES-256-GCM encryption of wallet keys
  near.ts       wallets, balances, NEAR RPC, one trade at a time per user
  ref.ts        Ref Finance quotes and swaps
  market.ts     GeckoTerminal prices, pools, hourly candles
  indicators.ts EMA, RSI, MACD, ATR
  analysis.ts   token safety score and market bias
  advisor.ts    hold/close verdict for a trade (rules)
  forecast.ts   24h odds from 5-minute price moves (bootstrap Monte Carlo)
  news.ts       headlines from free crypto RSS feeds
  reports.ts    scheduled and on-demand trade reports
  agent.ts      AI agent: chat, tools, commentary, trade proposals
  llm-openai.ts lets the agent use NEAR AI or any OpenAI-compatible API
  proposals.ts  confirm-before-execute for every money action
  lookup.ts     symbol or name -> token
  perps.ts      leverage maths: liquidation price, PnL, fees
  paper.ts      paper long/short venue
  monitor.ts    background trade watcher and alerts
  tokens.ts     symbol registry (mainnet and testnet contracts)
  format.ts     Telegram message formatting
test/           unit tests and end-to-end tests
```

## Setup
Requires Node 22.13 or later.
```bash
npm install
cp .env.example .env
npm run genkey          # paste the output into MASTER_KEY
# put your @BotFather token in BOT_TOKEN
# optional: put a NEAR AI key in NEAR_AI_API_KEY (or an Anthropic key in ANTHROPIC_API_KEY) to switch on the AI agent
npm start
```
To get test NEAR, send funds from https://near-faucet.io to the address `/wallet` shows.

## Tests
`npm test`
All 27 tests pass. They cover:
- the maths: units, indicators, leverage, the paper venue
- security: encryption and wallets
- the logic: hold/close rules, token analysis, market data parsing
- end-to-end bot flows with fake Telegram, market and NEAR network
- the AI agent with a fake model: proposals, languages, limits, alerts
- the NEAR AI (OpenAI-compatible) translation, news parsing and matching, the odds, and trade reports and their schedule

`npm run smoke` checks the live services without keys or transactions: GeckoTerminal prices, hourly and 5-minute candles and search, live 24h odds, the news feeds, the NEAR RPC, and a Ref Finance quote on the configured network.

**Not tested yet:** live Ref swaps (sending a transaction), Telegram itself and real Claude replies. Run `/buy REF 0.5` on testnet first, then chat with the bot in a couple of languages.

## Before mainnet
- Real long/short needs an adapter to a real perpetuals venue in place of `paper.ts`, e.g. NEAR perps on Hyperliquid.
- Keep `MASTER_KEY` in a secrets manager and back it up. If it is lost, every bot wallet is lost. If it leaks along with the database, every user's funds can be stolen.
- Get a security review. Keep `MAX_TRADE_NEAR` low. Leave the funder account empty.
- A public bot that holds people's funds and offers leverage may need a licence. Get legal advice for the countries you serve.
- The bot refuses to start on mainnet unless you set `I_UNDERSTAND_MAINNET_RISK=yes`.
