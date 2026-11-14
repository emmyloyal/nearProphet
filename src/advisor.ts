import type { Technicals } from './indicators.js';
import { liqDistancePct, pnlUsd, type Side } from './perps.js';

export type Verdict = 'HOLD' | 'TAKE_PROFIT' | 'REDUCE' | 'CLOSE';

export interface PositionView {
  kind: 'perp' | 'spot';
  side: Side;
  entry: number;
  sizeUsd: number;
  collateral: number;
  leverage: number;
  liq: number | null;
}

export interface Advice {
  verdict: Verdict;
  urgent: boolean;
  pnlUsd: number;
  /** PnL as % of the money actually put in (collateral) */
  pnlPct: number;
  liqDistancePct: number | null;
  /** Trend score seen from the position's side: positive = market agrees with you */
  alignment: number;
  suggestedStop: number | null;
  reasons: string[];
}

/**
 * Rule-based hold/close read. Order matters: survival first (liquidation),
 * then cutting losers the market disagrees with, then protecting winners.
 */
export function advise(p: PositionView, t: Technicals): Advice {
  const price = t.price;
  const pnl = pnlUsd(p.side, p.entry, price, p.sizeUsd);
  const pnlPct = (pnl / p.collateral) * 100;
  const dir = p.side === 'long' ? 1 : -1;
  const alignment = t.trendScore * dir;
  const liqDist = p.liq !== null ? liqDistancePct(p.side, p.liq, price) : null;
  const atrPct = t.atrPct;
  const reasons: string[] = [];
  let verdict: Verdict = 'HOLD';
  let urgent = false;

  // Price move in the position's favour, measured in ATRs (volatility units).
  const movePct = (price / p.entry - 1) * 100 * dir;
  const moveAtr = atrPct ? movePct / atrPct : null;

  // Stop suggestion: 2 ATR behind price, never worse than liquidation.
  let suggestedStop: number | null = null;
  if (t.atr14 !== null) {
    suggestedStop = price - dir * 2 * t.atr14;
    if (p.liq !== null) {
      const safer = p.side === 'long' ? suggestedStop > p.liq : suggestedStop < p.liq;
      if (!safer) suggestedStop = null;
    }
  }

  const rsi = t.rsi14;
  const stretched = rsi !== null && (p.side === 'long' ? rsi >= 72 : rsi <= 28);
  const exhaustedAgainst = rsi !== null && (p.side === 'long' ? rsi <= 28 : rsi >= 72);
  const macdFading = t.macd ? (t.macd.hist - t.macd.prevHist) * dir < 0 : false;

  // 1. Liquidation risk
  if (liqDist !== null) {
    const normalSwing = atrPct ?? 2;
    if (liqDist <= normalSwing) {
      verdict = 'CLOSE';
      urgent = true;
      reasons.push(
        `Liquidation is ${liqDist.toFixed(2)}% away and a normal hourly swing is ${normalSwing.toFixed(2)}%. One ordinary candle can wipe the position.`,
      );
    } else if (liqDist <= normalSwing * 2.5) {
      verdict = 'REDUCE';
      urgent = true;
      reasons.push(`Liquidation is only ${liqDist.toFixed(2)}% away (about ${(liqDist / normalSwing).toFixed(1)} hourly swings). Cut size or add collateral.`);
    }
  }

  // 2. Losing and the market disagrees
  if (verdict === 'HOLD' && pnl < 0) {
    if (alignment <= -2 && moveAtr !== null && moveAtr <= -2) {
      verdict = 'CLOSE';
      reasons.push(`Down ${Math.abs(movePct).toFixed(2)}% (${Math.abs(moveAtr).toFixed(1)} ATR) and trend is against your ${p.side}.`);
    } else if (alignment <= -2) {
      verdict = 'REDUCE';
      reasons.push(`Trend has turned against your ${p.side} (price vs EMA20/EMA50 and MACD all disagree).`);
    } else if (exhaustedAgainst) {
      reasons.push(`Losing, but RSI ${rsi!.toFixed(0)} shows the move against you is stretched; a bounce back is plausible.`);
    }
  }

  // 3. Winning: protect it
  if (verdict === 'HOLD' && pnl > 0) {
    if (alignment <= -2) {
      verdict = 'CLOSE';
      reasons.push('You are in profit and the trend has flipped against the position. Lock it in.');
    } else if (stretched && moveAtr !== null && moveAtr >= 3) {
      verdict = 'TAKE_PROFIT';
      reasons.push(`Up ${movePct.toFixed(2)}% (${moveAtr.toFixed(1)} ATR) with RSI ${rsi!.toFixed(0)}: the move is stretched. Take some off.`);
    } else if (stretched && macdFading) {
      verdict = 'TAKE_PROFIT';
      reasons.push(`RSI ${rsi!.toFixed(0)} is stretched and momentum (MACD) is fading.`);
    }
  }

  if (verdict === 'HOLD') {
    if (alignment >= 2) reasons.push(`Trend supports your ${p.side} (${alignment}/3 signals agree).`);
    else if (alignment <= -1) reasons.push(`Signals lean against your ${p.side} (${alignment}/3) but not decisively. Watch closely.`);
    else reasons.push('Signals are mixed; no clear reason to exit.');
    if (macdFading && pnl > 0) reasons.push('Momentum is fading; consider tightening your stop.');
  }

  if (t.candles < 60) reasons.push(`Only ${t.candles} hourly candles available, so the read is low-confidence.`);

  return { verdict, urgent, pnlUsd: pnl, pnlPct, liqDistancePct: liqDist, alignment, suggestedStop, reasons };
}
