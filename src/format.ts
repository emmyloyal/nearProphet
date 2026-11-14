import type { Advice } from './advisor.js';
import { fmt, type MarketSnapshot, type TokenReport } from './analysis.js';
import type { PositionRow } from './db.js';
import type { Technicals } from './indicators.js';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function price(p: number): string {
  if (!Number.isFinite(p)) return '?';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toPrecision(4);
}

const pct = (v: number | null): string => (v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');
const usd = (v: number | null): string => (v === null ? 'n/a' : '$' + fmt(v));
const signed = (v: number): string => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);

export const DISCLAIMER = '<i>Automated read of market signals, not financial advice.</i>';

export function tokenInfo(m: MarketSnapshot): string {
  const lines = [
    `<b>${esc(m.name)} (${esc(m.symbol)})</b>`,
    `<code>${esc(m.address)}</code>`,
    '',
    `Price: <b>$${price(m.priceUsd)}</b>`,
    `1h ${pct(m.change.h1)} | 6h ${pct(m.change.h6)} | 24h ${pct(m.change.h24)}`,
    `Market cap: ${usd(m.marketCapUsd)} | FDV: ${usd(m.fdvUsd)}`,
    `Liquidity: ${usd(m.liquidityUsd)} | 24h volume: ${usd(m.volume24hUsd)}`,
  ];
  if (m.txns24h) lines.push(`24h trades: ${m.txns24h.buys} buys / ${m.txns24h.sells} sells`);
  if (m.poolName) lines.push(`Main pool: ${esc(m.poolName)}`);
  return lines.join('\n');
}

export function deepAnalysis(m: MarketSnapshot, r: TokenReport, t: Technicals | null): string {
  const biasIcon = r.bias === 'BULLISH' ? '🟢' : r.bias === 'BEARISH' ? '🔴' : '🟡';
  const out = [tokenInfo(m), '', `${biasIcon} Market bias: <b>${r.bias}</b>`, `Safety score: <b>${r.safetyScore}/100</b>`];
  if (r.flags.length) out.push('', '<b>Risks</b>', ...r.flags.map((f) => '⚠️ ' + esc(f)));
  if (r.positives.length) out.push('', '<b>In its favour</b>', ...r.positives.map((f) => '✅ ' + esc(f)));
  out.push('', '<b>Technicals (hourly)</b>', ...r.technicalNotes.map((f) => '• ' + esc(f)));
  if (t?.atr14 && t.ema20) out.push(`• Reference levels: 20h average $${price(t.ema20)}, 2-ATR band $${price(t.price - 2 * t.atr14)} to $${price(t.price + 2 * t.atr14)}`);
  out.push('', DISCLAIMER);
  return out.join('\n');
}

const VERDICT_LABEL: Record<Advice['verdict'], string> = {
  HOLD: '🟢 HOLD',
  TAKE_PROFIT: '🟡 TAKE PROFIT (partial)',
  REDUCE: '🟠 REDUCE',
  CLOSE: '🔴 CLOSE',
};

export function positionLine(p: PositionRow): string {
  const tag = p.kind === 'spot' ? 'SPOT' : `${p.side.toUpperCase()} ${p.leverage}x`;
  return `#${p.id} ${esc(p.symbol)} ${tag}`;
}

export function positionReport(p: PositionRow, a: Advice, t: Technicals): string {
  const out = [
    `<b>${positionLine(p)}</b>${p.kind === 'perp' ? ' (paper)' : ' (tracked at market price)'}`,
    `Entry $${price(p.entry)} → now <b>$${price(t.price)}</b>`,
    `PnL: <b>${signed(a.pnlUsd)}</b> (${pct(a.pnlPct)}) on $${p.collateral.toFixed(2)}`,
  ];
  if (p.liq !== null && a.liqDistancePct !== null) out.push(`Liquidation: $${price(p.liq)} (${a.liqDistancePct.toFixed(2)}% away)`);
  const m: string[] = [];
  if (t.rsi14 !== null) m.push(`RSI ${t.rsi14.toFixed(0)}`);
  if (t.ema20 !== null) m.push(`price ${t.price > t.ema20 ? '>' : '<'} EMA20`);
  if (t.macd) m.push(`MACD ${t.macd.hist > 0 ? '+' : '-'}`);
  if (t.atrPct !== null) m.push(`hourly swing ${t.atrPct.toFixed(2)}%`);
  if (m.length) out.push(`Market: ${esc(m.join(' | '))}`);
  out.push('', `Verdict: <b>${VERDICT_LABEL[a.verdict]}</b>`, ...a.reasons.map((r) => '• ' + esc(r)));
  if (a.suggestedStop !== null && a.verdict === 'HOLD') out.push(`• Suggested stop: $${price(a.suggestedStop)}`);
  return out.join('\n');
}

export { signed, pct, usd };
