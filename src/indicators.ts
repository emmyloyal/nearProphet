/** Plain technical indicators over arrays ordered oldest -> newest. */

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

/** Full EMA series (same length as input; seeded with the SMA of the first `period` values). */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  const out: number[] = new Array(period - 1).fill(NaN);
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1]! : null;
}

/** Wilder RSI. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export interface Macd {
  macd: number;
  signal: number;
  hist: number;
  prevHist: number;
}

export function macd(closes: number[], fast = 12, slow = 26, signalP = 9): Macd | null {
  if (closes.length < slow + signalP + 1) return null;
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const line: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) line.push(f[i]! - s[i]!);
  const sig = emaSeries(line, signalP);
  const n = line.length - 1;
  return {
    macd: line[n]!,
    signal: sig[n]!,
    hist: line[n]! - sig[n]!,
    prevHist: line[n - 1]! - sig[n - 1]!,
  };
}

/** Wilder ATR. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const pc = candles[i - 1]!.c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  let a = 0;
  for (let i = 0; i < period; i++) a += trs[i]!;
  a /= period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]!) / period;
  return a;
}

export interface Technicals {
  price: number;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  macd: Macd | null;
  atr14: number | null;
  /** ATR as % of price */
  atrPct: number | null;
  /** -3..+3: positive = bullish structure */
  trendScore: number;
  candles: number;
}

export function technicals(candles: Candle[], livePrice?: number): Technicals {
  const closes = candles.map((c) => c.c);
  const price = livePrice ?? closes[closes.length - 1] ?? NaN;
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const m = macd(closes);
  const a = atr(candles);
  let score = 0;
  if (e20 !== null) score += price > e20 ? 1 : -1;
  if (e20 !== null && e50 !== null) score += e20 > e50 ? 1 : -1;
  if (m) score += m.hist > 0 ? 1 : -1;
  return {
    price,
    ema20: e20,
    ema50: e50,
    rsi14: rsi(closes),
    macd: m,
    atr14: a,
    atrPct: a !== null && price > 0 ? (a / price) * 100 : null,
    trendScore: score,
    candles: candles.length,
  };
}
