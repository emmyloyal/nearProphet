import type { Technicals } from './indicators.js';

export interface MarketSnapshot {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null; // top pool reserve
  volume24hUsd: number | null;
  change: { h1: number | null; h6: number | null; h24: number | null };
  txns24h: { buys: number; sells: number; buyers: number | null; sellers: number | null } | null;
  poolAddress: string | null;
  poolName: string | null;
  poolCreatedAt: string | null;
}

export interface TokenReport {
  bias: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  /** 0 (dangerous) .. 100 (healthy) */
  safetyScore: number;
  flags: string[];
  positives: string[];
  technicalNotes: string[];
}

export function analyzeToken(m: MarketSnapshot, t: Technicals | null, now = Date.now()): TokenReport {
  const flags: string[] = [];
  const positives: string[] = [];
  const technicalNotes: string[] = [];
  let score = 100;

  // Liquidity
  if (m.liquidityUsd === null) {
    score -= 25;
    flags.push('No liquidity figure available.');
  } else if (m.liquidityUsd < 10_000) {
    score -= 40;
    flags.push(`Very thin liquidity ($${fmt(m.liquidityUsd)}). You may not be able to exit without a large loss.`);
  } else if (m.liquidityUsd < 100_000) {
    score -= 20;
    flags.push(`Low liquidity ($${fmt(m.liquidityUsd)}). Expect slippage on anything but small trades.`);
  } else positives.push(`Liquidity $${fmt(m.liquidityUsd)} in the main pool.`);

  // Valuation vs liquidity
  if (m.fdvUsd && m.liquidityUsd && m.liquidityUsd > 0) {
    const ratio = m.liquidityUsd / m.fdvUsd;
    if (ratio < 0.005) {
      score -= 15;
      flags.push(`Liquidity is only ${(ratio * 100).toFixed(2)}% of fully diluted value. The price is supported by very little money.`);
    }
  }

  // Volume
  if (m.volume24hUsd !== null && m.liquidityUsd) {
    const turn = m.volume24hUsd / m.liquidityUsd;
    if (m.volume24hUsd < 1_000) {
      score -= 15;
      flags.push(`Almost no trading in 24h ($${fmt(m.volume24hUsd)}).`);
    } else if (turn > 5) {
      score -= 5;
      flags.push(`24h volume is ${turn.toFixed(1)}x pool liquidity. That is heavy churn: possible hype or wash trading.`);
    } else positives.push(`24h volume $${fmt(m.volume24hUsd)}.`);
  }

  // Pool age
  if (m.poolCreatedAt) {
    const days = (now - Date.parse(m.poolCreatedAt)) / 86_400_000;
    if (days < 3) {
      score -= 25;
      flags.push(`Main pool is ${days.toFixed(1)} days old. New pools carry the highest rug risk.`);
    } else if (days < 30) {
      score -= 10;
      flags.push(`Main pool is ${days.toFixed(0)} days old.`);
    } else positives.push(`Main pool has existed for ${days.toFixed(0)} days.`);
  }

  // Order flow
  if (m.txns24h) {
    const { buys, sells } = m.txns24h;
    const total = buys + sells;
    if (total >= 20) {
      const buyShare = buys / total;
      if (buyShare > 0.65) technicalNotes.push(`Buy pressure: ${(buyShare * 100).toFixed(0)}% of 24h trades are buys.`);
      else if (buyShare < 0.35) technicalNotes.push(`Sell pressure: ${((1 - buyShare) * 100).toFixed(0)}% of 24h trades are sells.`);
    } else if (total < 5) {
      score -= 5;
      flags.push(`Only ${total} trades in 24h.`);
    }
  }

  // Volatility / moves
  if (m.change.h24 !== null && Math.abs(m.change.h24) > 40) {
    score -= 10;
    flags.push(`Price moved ${m.change.h24.toFixed(1)}% in 24h. Extreme volatility.`);
  }

  // Technicals -> bias
  let bias: TokenReport['bias'] = 'NEUTRAL';
  if (t && t.candles >= 30) {
    if (t.trendScore >= 2) bias = 'BULLISH';
    else if (t.trendScore <= -2) bias = 'BEARISH';
    if (t.ema20 !== null) technicalNotes.push(`Price is ${t.price > t.ema20 ? 'above' : 'below'} the 20-hour average.`);
    if (t.ema20 !== null && t.ema50 !== null)
      technicalNotes.push(`Short-term average is ${t.ema20 > t.ema50 ? 'above' : 'below'} the 50-hour average (${t.ema20 > t.ema50 ? 'uptrend' : 'downtrend'} structure).`);
    if (t.rsi14 !== null) {
      const r = t.rsi14;
      technicalNotes.push(`RSI ${r.toFixed(0)}: ${r >= 70 ? 'overbought, late to buy' : r <= 30 ? 'oversold, late to sell' : 'neutral'}.`);
      if (bias === 'BULLISH' && r >= 75) bias = 'NEUTRAL';
      if (bias === 'BEARISH' && r <= 25) bias = 'NEUTRAL';
    }
    if (t.macd) technicalNotes.push(`MACD momentum is ${t.macd.hist > 0 ? 'positive' : 'negative'} and ${t.macd.hist > t.macd.prevHist ? 'strengthening' : 'weakening'}.`);
    if (t.atrPct !== null) technicalNotes.push(`Typical hourly swing: ${t.atrPct.toFixed(2)}%.`);
  } else {
    technicalNotes.push('Not enough price history for a technical read.');
  }

  return { bias, safetyScore: Math.max(0, Math.min(100, Math.round(score))), flags, positives, technicalNotes };
}

export function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}
