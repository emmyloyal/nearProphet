import type { Candle } from './indicators.js';
import type { Side } from './perps.js';

/**
 * Odds estimate for a trade from recent 5-minute price behaviour (bootstrap Monte Carlo):
 * replay randomly drawn real 5-minute moves from the last day or two, thousands of times,
 * and count how often each price level gets touched within the horizon.
 *
 * Moves are de-meaned, so the odds reflect volatility only and do not extrapolate the recent
 * trend (trend is reported separately). They cannot foresee news, hacks or sudden crashes.
 */

export interface ForecastInput {
  side: Side;
  entry: number;
  price: number;
  liq: number | null;
  stop: number | null;
  target: number | null;
  horizonHours?: number;
  paths?: number;
  seed?: number;
}

export interface Forecast {
  horizonHours: number;
  /** % of paths that touch each level at some point within the horizon */
  pStop: number | null;
  pLiq: number | null;
  pTarget: number | null;
  /** % of paths where the trade is in profit (vs entry) at the end of the horizon */
  pProfitAtEnd: number;
  /** 10th / 50th / 90th percentile of the price at the end */
  low: number;
  mid: number;
  high: number;
  /** Typical 5-minute move (std dev, %) the estimate is built from */
  vol5mPct: number;
  samples: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns null when there is too little data for a meaningful estimate. */
export function forecast(candles: Candle[], f: ForecastInput): Forecast | null {
  const cs = candles.filter((c) => c.c > 0);
  if (cs.length < 60 || !(f.price > 0)) return null;
  const rets: number[] = [];
  for (let i = 1; i < cs.length; i++) rets.push(Math.log(cs[i]!.c / cs[i - 1]!.c));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const r = rets.map((x) => x - mean);
  const sd = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / r.length);

  // Missing candles (no trades) mean each return covers more time; scale steps to real time.
  const spacingSec = (cs[cs.length - 1]!.t - cs[0]!.t) / (cs.length - 1);
  const horizonHours = f.horizonHours ?? 24;
  const steps = Math.max(1, Math.round((horizonHours * 3600) / Math.max(spacingSec, 60)));
  const paths = f.paths ?? 2000;
  const rand = rng(f.seed ?? Date.now());
  const dir = f.side === 'long' ? 1 : -1;
  const x0 = Math.log(f.price);
  // Barriers in log space; "hit" means price crossed in the adverse/favourable direction.
  const lStop = f.stop && f.stop > 0 ? Math.log(f.stop) : null;
  const lLiq = f.liq && f.liq > 0 ? Math.log(f.liq) : null;
  const lTgt = f.target && f.target > 0 ? Math.log(f.target) : null;
  const lEntry = Math.log(f.entry);
  let nStop = 0, nLiq = 0, nTgt = 0, nProfit = 0;
  const ends = new Float64Array(paths);
  for (let p = 0; p < paths; p++) {
    let x = x0;
    let hs = false, hl = false, ht = false;
    for (let s = 0; s < steps; s++) {
      x += r[(rand() * r.length) | 0]!;
      if (lStop !== null && !hs && (x - lStop) * dir <= 0) hs = true;
      if (lLiq !== null && !hl && (x - lLiq) * dir <= 0) hl = true;
      if (lTgt !== null && !ht && (x - lTgt) * dir >= 0) ht = true;
    }
    if (hs) nStop++;
    if (hl) nLiq++;
    if (ht) nTgt++;
    // A liquidated position stays a loss even if price recovers.
    if (!hl && (x - lEntry) * dir > 0) nProfit++;
    ends[p] = Math.exp(x);
  }
  ends.sort();
  const q = (k: number) => ends[Math.min(paths - 1, Math.floor(k * paths))]!;
  const pc = (n: number) => Math.round((n / paths) * 1000) / 10;
  return {
    horizonHours,
    pStop: lStop === null ? null : pc(nStop),
    pLiq: lLiq === null ? null : pc(nLiq),
    pTarget: lTgt === null ? null : pc(nTgt),
    pProfitAtEnd: pc(nProfit),
    low: q(0.1),
    mid: q(0.5),
    high: q(0.9),
    vol5mPct: sd * 100,
    samples: rets.length,
  };
}
