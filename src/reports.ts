import { type Agent, checkData } from './agent.js';
import { config } from './config.js';
import type { Db, PositionRow } from './db.js';
import { forecast, type Forecast } from './forecast.js';
import { DISCLAIMER, esc, positionLine, price, signed } from './format.js';
import { technicals } from './indicators.js';
import { getCandles5m, getMarket } from './market.js';
import { ago, marketNews, type NewsItem, newsData, newsFor } from './news.js';

/**
 * Trade reports: for every open trade, the rule verdict, short-term (5-minute) trend, estimated odds
 * for the next 24 hours, and recent headlines, plus an AI write-up of the options when AI is on.
 * Sent on a schedule (REPORT_INTERVAL_HOURS, per-user via /report) and on demand with /report now.
 */

const MAX_TRADES = 5;

interface TradeReport {
  p: PositionRow;
  check: Awaited<ReturnType<typeof checkData>>;
  trend5m: { score: number; rsi14: number | null; candles: number } | null;
  odds: Forecast | null;
  stop: number | null;
  target: number | null;
  news: NewsItem[];
}

const r6 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toPrecision(6)));

async function tradeReport(db: Db, p: PositionRow): Promise<TradeReport> {
  const check = await checkData(db, p.tg_id, p.id);
  const px = check.price ?? p.entry;
  const [c5, market] = await Promise.all([getCandles5m(p.market_id), getMarket(p.market_id)]);
  const t5 = c5.length >= 60 ? technicals(c5, px) : null;
  const dir = p.side === 'long' ? 1 : -1;
  const stop = check.rule_verdict.suggested_stop;
  const atrPct = check.technicals.atr_pct;
  // Mirror of the suggested stop: 2 hourly ATRs in the trade's favour.
  const target = atrPct ? px * (1 + (dir * 2 * atrPct) / 100) : null;
  const odds = forecast(c5, { side: p.side, entry: p.entry, price: px, liq: p.liq, stop, target });
  const news = await newsFor(market.symbol, market.name, 4).catch(() => []);
  return { p, check, trend5m: t5 && { score: t5.trendScore, rsi14: t5.rsi14, candles: t5.candles }, odds, stop, target, news };
}

const pc = (v: number | null) => (v === null ? 'n/a' : v < 1 ? '&lt;1%' : v > 99 ? '&gt;99%' : `${Math.round(v)}%`);
const trendWord = (s: number, side: string) => {
  const aligned = side === 'long' ? s : -s;
  const dirWord = s >= 2 ? 'up' : s <= -2 ? 'down' : 'sideways';
  return `${dirWord} (${aligned >= 2 ? 'with you' : aligned <= -2 ? 'against you' : 'mixed'})`;
};
const VERDICT: Record<string, string> = { HOLD: '🟢 HOLD', TAKE_PROFIT: '🟡 TAKE PROFIT (partial)', REDUCE: '🟠 REDUCE', CLOSE: '🔴 CLOSE' };

function render(r: TradeReport, now: number): string {
  const { p, check: c, odds } = r;
  const out = [
    `<b>${positionLine(p)}</b>${p.kind === 'perp' ? ' (paper)' : ''}`,
    `Entry $${price(p.entry)} → now <b>$${price(c.price ?? NaN)}</b> | PnL <b>${signed(c.pnl_usd ?? 0)}</b> (${(c.pnl_pct ?? 0) >= 0 ? '+' : ''}${(c.pnl_pct ?? 0).toFixed(1)}%)`,
    `Verdict: <b>${VERDICT[c.rule_verdict.verdict] ?? c.rule_verdict.verdict}</b>${c.rule_verdict.urgent ? ' ⚠️ urgent' : ''}`,
    ...c.rule_verdict.reasons.slice(0, 2).map((x) => '• ' + esc(x)),
    `Trend: hourly ${trendWord(c.technicals.trend_score, p.side)}${r.trend5m ? `, 5-min ${trendWord(r.trend5m.score, p.side)}` : ''}`,
  ];
  if (odds) {
    out.push('', `<b>Next ${odds.horizonHours}h, estimated</b> (from recent 5-min volatility)`);
    if (r.stop !== null) out.push(`• Touches suggested stop $${price(r.stop)}: ${pc(odds.pStop)}`);
    if (r.target !== null) out.push(`• Touches target $${price(r.target)}: ${pc(odds.pTarget)}`);
    if (p.liq !== null) out.push(`• Touches liquidation $${price(p.liq)}: ${pc(odds.pLiq)}`);
    out.push(`• In profit at the end: ${pc(odds.pProfitAtEnd)}`, `• Likely range: $${price(odds.low)} – $${price(odds.high)}`);
  } else out.push('', 'Not enough 5-minute data for odds on this token.');
  if (r.news.length) {
    out.push('', '<b>News</b>');
    for (const n of r.news) out.push(`• ${n.link ? `<a href="${esc(n.link)}">${esc(n.title)}</a>` : esc(n.title)} (${esc(n.source)}, ${ago(n.publishedAt, now)})`);
  }
  return out.join('\n');
}

export interface BuiltReport {
  html: string;
  /** Compact data for the AI */
  data: unknown;
}

/** Build the report for one user's open trades, or null if they have none. */
export async function buildReport(db: Db, tgId: number, now = Date.now()): Promise<BuiltReport | null> {
  const list = db.openPositions(tgId).slice(0, MAX_TRADES);
  if (!list.length) return null;
  const reports: TradeReport[] = [];
  const failed: string[] = [];
  for (const p of list) {
    try {
      reports.push(await tradeReport(db, p));
    } catch (e) {
      failed.push(`${positionLine(p)}: ${esc((e as Error).message)}`);
    }
  }
  if (!reports.length) throw new Error('Market data is unavailable right now. Try /report now again in a few minutes.');
  const market = await marketNews(4).catch(() => []);
  const parts = reports.map((r) => render(r, now));
  if (failed.length) parts.push('Could not read: ' + failed.join('; '));
  if (market.length)
    parts.push(['<b>Crypto market news</b>', ...market.slice(0, 3).map((n) => `• ${n.link ? `<a href="${esc(n.link)}">${esc(n.title)}</a>` : esc(n.title)} (${esc(n.source)}, ${ago(n.publishedAt, now)})`)].join('\n'));
  const html = `📊 <b>Trade report</b>\n\n${parts.join('\n\n———\n\n')}\n\n${DISCLAIMER} Odds are estimates from recent price swings and cannot foresee news or crashes.`;
  const data = {
    trades: reports.map((r) => ({
      ...r.check,
      trend_5m: r.trend5m,
      odds_next_24h: r.odds && {
        touch_stop_pct: r.odds.pStop,
        stop: r6(r.stop),
        touch_target_pct: r.odds.pTarget,
        target: r6(r.target),
        touch_liquidation_pct: r.odds.pLiq,
        in_profit_at_end_pct: r.odds.pProfitAtEnd,
        likely_range: [r6(r.odds.low), r6(r.odds.high)],
      },
      token_news: newsData(r.news, now),
    })),
    market_news: newsData(market, now),
  };
  return { html, data };
}

export function reportHoursFor(db: Db, tgId: number): number {
  const h = db.user(tgId).report_hours;
  return h === null ? config.reportHours : h;
}

/** Users whose scheduled report is due. The clock starts at their first open trade or their last report. */
export function dueUsers(db: Db, now = Date.now()): number[] {
  const firstOpen = new Map<number, number>();
  for (const p of db.openPositions()) firstOpen.set(p.tg_id, Math.min(firstOpen.get(p.tg_id) ?? Infinity, p.opened_at));
  const due: number[] = [];
  for (const [tgId, opened] of firstOpen) {
    const hours = reportHoursFor(db, tgId);
    if (!(hours > 0)) continue;
    const since = Math.max(opened, db.user(tgId).last_report_at ?? 0);
    if (now - since >= hours * 3_600_000) due.push(tgId);
  }
  return due;
}

export type Send = (tgId: number, html: string, plain?: boolean) => Promise<void>;

/** Build and send one user's report (rule-based part first, AI write-up after). */
export async function sendReport(db: Db, tgId: number, agent: Agent | null, send: Send): Promise<boolean> {
  const r = await buildReport(db, tgId);
  if (!r) return false;
  db.markReported(tgId);
  await send(tgId, r.html);
  if (agent) {
    const note = await agent.commentary(tgId, 'report', r.data).catch((e) => (console.error('[ai report]', (e as Error).message), null));
    if (note) await send(tgId, '🤖 ' + note, true);
  }
  return true;
}

/** Send every due report. Failures are logged and retried next tick. */
export async function sendDueReports(db: Db, agent: Agent | null, send: Send, now = Date.now()): Promise<void> {
  for (const tgId of dueUsers(db, now)) {
    try {
      await sendReport(db, tgId, agent, send);
    } catch (e) {
      console.error(`[report] ${tgId}: ${(e as Error).message}`);
    }
  }
}
