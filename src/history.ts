import { config } from './config.js';
import type { Db, PositionRow, PositionStats, TradeRow } from './db.js';
import { esc, positionLine, price, signed } from './format.js';
import { ftMetadata } from './near.js';
import { ago } from './news.js';
import { knownSymbols, resolveToken } from './tokens.js';
import { fromUnits } from './units.js';

/** Trade history: totals, recent closed trades, recent on-chain swaps. Used by /history and the AI. */

const MAX_LIMIT = 30;

function held(p: PositionRow): string {
  const m = Math.max(0, Math.round(((p.closed_at ?? p.opened_at) - p.opened_at) / 60_000));
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${Math.round(h / 24)}d`;
}

const pctOf = (pnl: number, base: number) => (base > 0 ? `${pnl >= 0 ? '+' : ''}${((pnl / base) * 100).toFixed(1)}%` : '');

function closedLine(p: PositionRow, now: number): string {
  const pnl = p.pnl ?? 0;
  const icon = p.status === 'liquidated' ? '💥' : pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
  const tail = p.status === 'liquidated' ? 'liquidated' : pctOf(pnl, p.collateral);
  return `${icon} ${positionLine(p)}: $${price(p.entry)} → $${price(p.exit ?? NaN)}  <b>${signed(pnl)}</b> ${tail}\n    held ${held(p)}, closed ${ago(p.closed_at ?? now, now)}`;
}

function statsLine(s: PositionStats, label: string): string[] {
  const decided = s.wins + s.losses;
  const rate = decided ? ` (${Math.round((s.wins / decided) * 100)}% wins)` : '';
  const out = [
    `<b>${label}</b>: ${s.trades} closed | ${s.wins} won, ${s.losses} lost${rate}${s.liquidations ? `, ${s.liquidations} liquidated` : ''}`,
    `Total PnL: <b>${signed(s.total_pnl)}</b>${s.total_collateral > 0 ? ` (${pctOf(s.total_pnl, s.total_collateral)} of money put in)` : ''}`,
  ];
  if (s.best !== null && s.worst !== null && s.trades > 1) out.push(`Best ${signed(s.best)} | Worst ${signed(s.worst)}`);
  return out;
}

/** Contract id -> friendly symbol for this network, if known. */
function symbolOf(contract: string): string {
  for (const s of knownSymbols()) if (resolveToken(s)?.tradeId === contract) return s;
  return contract.length > 24 ? contract.slice(0, 10) + '…' : contract;
}

async function amount(raw: string, contract: string): Promise<string> {
  try {
    const dec = contract === config.wrapContract ? 24 : (await ftMetadata(contract)).decimals;
    return fromUnits(BigInt(raw), dec, 4);
  } catch {
    return '?';
  }
}

async function swapLine(t: TradeRow, now: number): Promise<{ html: string; data: Record<string, unknown> }> {
  const [inAmt, outAmt] = await Promise.all([amount(t.amount_in, t.token_in), amount(t.amount_out, t.token_out)]);
  const inSym = symbolOf(t.token_in);
  const outSym = symbolOf(t.token_out);
  const text = t.action === 'buy' ? `Bought ${outAmt} ${outSym} for ${inAmt} ${inSym}` : `Sold ${inAmt} ${inSym} for ${outAmt} ${outSym}`;
  const link = t.tx_hash ? ` · <a href="https://${config.network === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${encodeURIComponent(t.tx_hash)}">tx</a>` : '';
  return { html: `• ${esc(text)} · ${ago(t.at, now)}${link}`, data: { action: t.action, summary: text, age: ago(t.at, now), tx: t.tx_hash } };
}

export interface History {
  html: string;
  data: unknown;
  empty: boolean;
}

export async function buildHistory(db: Db, tgId: number, limit = 10, now = Date.now()): Promise<History> {
  const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const stats = db.positionStats(tgId);
  const closed = db.closedPositions(tgId, n);
  const swaps = await Promise.all(db.recentTrades(tgId, 5).map((t) => swapLine(t, now)));
  const open = db.openPositions(tgId).length;
  if (!closed.length && !swaps.length) {
    return {
      html: `📜 <b>Trade history</b>\n\nNo closed trades or swaps yet.${open ? ` You have ${open} open trade${open === 1 ? '' : 's'}: /positions` : ' Try /long NEAR 100 3'}`,
      data: { closed_trades: [], swaps: [], open_trades: open },
      empty: true,
    };
  }
  const perp = stats.find((s) => s.kind === 'perp');
  const spot = stats.find((s) => s.kind === 'spot');
  const out = ['📜 <b>Trade history</b>', ''];
  if (perp) out.push(...statsLine(perp, 'Long/short (paper)'));
  if (spot) out.push(...(perp ? [''] : []), ...statsLine(spot, 'Spot (tracked at market price)'));
  if (perp || spot) out.push(`Paper balance now: $${db.user(tgId).paper_usd.toFixed(2)}`);
  if (closed.length) out.push('', `<b>Last ${closed.length} closed</b>`, ...closed.map((p) => closedLine(p, now)));
  if (swaps.length) out.push('', `<b>Recent swaps</b> (${esc(config.network)})`, ...swaps.map((s) => s.html));
  const total = stats.reduce((a, s) => a + s.trades, 0);
  if (total > closed.length) out.push('', `Showing ${closed.length} of ${total}. /history ${Math.min(MAX_LIMIT, total)} shows more.`);
  if (open) out.push('', `${open} trade${open === 1 ? '' : 's'} still open: /positions`);
  const r = (x: number | null) => (x === null ? null : Number(x.toFixed(2)));
  return {
    html: out.join('\n'),
    empty: false,
    data: {
      totals: stats.map((s) => ({ kind: s.kind === 'perp' ? 'long/short (paper)' : 'spot', trades: s.trades, wins: s.wins, losses: s.losses, liquidations: s.liquidations, total_pnl_usd: r(s.total_pnl), best_usd: r(s.best), worst_usd: r(s.worst) })),
      closed_trades: closed.map((p) => ({ id: p.id, kind: p.kind, side: p.side, symbol: p.symbol, leverage: p.leverage, entry: p.entry, exit: p.exit, pnl_usd: r(p.pnl), status: p.status, held: held(p), closed: ago(p.closed_at ?? now, now) })),
      swaps: swaps.map((s) => s.data),
      open_trades: open,
      paper_balance_usd: r(db.user(tgId).paper_usd),
    },
  };
}
