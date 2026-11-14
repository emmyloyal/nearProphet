import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyPair, type KeyPairString } from 'near-api-js';
import { advise } from '../src/advisor.js';
import { analyzeToken, type MarketSnapshot } from '../src/analysis.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { Db } from '../src/db.js';
import { atr, type Candle, ema, macd, rsi, type Technicals, technicals } from '../src/indicators.js';
import { generateWallet } from '../src/near.js';
import { closePosition, openPerp } from '../src/paper.js';
import { fee, isLiquidated, liqDistancePct, liquidationPrice, pnlUsd } from '../src/perps.js';
import { resolveToken } from '../src/tokens.js';
import { applySlippage, fromUnits, toUnits } from '../src/units.js';

const KEY = 'a'.repeat(64);

/** Deterministic random walk with drift (percent per candle). */
function series(start: number, driftPct: number, n: number, seed = 7, noisePct = 1): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296) * 2 - 1;
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + (driftPct + rnd() * noisePct) / 100);
    out.push({ t: i * 3600, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v: 1000 });
  }
  return out;
}

const tech = (o: Partial<Technicals>): Technicals => ({
  price: 100, ema20: 98, ema50: 95, rsi14: 58, macd: { macd: 1, signal: 0.8, hist: 0.2, prevHist: 0.1 },
  atr14: 1, atrPct: 1, trendScore: 3, candles: 200, ...o,
});

test('units: round trip and rejects bad input', () => {
  assert.equal(toUnits('1.5', 24), 1_500_000_000_000_000_000_000_000n);
  assert.equal(fromUnits(1_500_000_000_000_000_000_000_000n, 24), '1.5');
  assert.equal(fromUnits(1n, 6), '0.000001');
  assert.equal(toUnits('0.000001', 6), 1n);
  assert.throws(() => toUnits('1e5', 6));
  assert.throws(() => toUnits('-1', 6));
  assert.throws(() => toUnits('0.0000001', 6));
  assert.equal(applySlippage(10_000n, 1), 9_900n);
});

test('crypto: round trip, bound to owner, tamper-evident', () => {
  const blob = encrypt('ed25519:secret', KEY, '42');
  assert.equal(decrypt(blob, KEY, '42'), 'ed25519:secret');
  assert.notEqual(blob, encrypt('ed25519:secret', KEY, '42'));
  assert.throws(() => decrypt(blob, KEY, '43'));
  assert.throws(() => decrypt(blob, 'b'.repeat(64), '42'));
  const raw = Buffer.from(blob, 'base64');
  raw[raw.length - 1]! ^= 1;
  assert.throws(() => decrypt(raw.toString('base64'), KEY, '42'));
});

test('wallet: implicit address matches the key', () => {
  const w = generateWallet();
  assert.match(w.accountId, /^[0-9a-f]{64}$/);
  const pub = KeyPair.fromString(w.privateKey as KeyPairString).getPublicKey();
  assert.equal(Buffer.from(pub.data).toString('hex'), w.accountId);
  assert.notEqual(generateWallet().accountId, w.accountId);
});

test('indicators: reference values', () => {
  assert.equal(ema([1, 2, 3, 4, 5], 5), 3);
  // Classic Wilder RSI worked example (first value 70.46)
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  assert.ok(Math.abs(rsi(closes)! - 70.46) < 0.1, String(rsi(closes)));
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), 100);
  assert.equal(rsi([1, 2]), null);
  const up = series(10, 0.3, 120);
  assert.ok(macd(up.map((c) => c.c))!.macd > 0);
  assert.ok(atr(up)! > 0);
  const tu = technicals(up);
  assert.ok(tu.price > tu.ema20! && tu.ema20! > tu.ema50!);
  assert.equal(tu.trendScore, 3);
  const td = technicals(series(10, -0.3, 150));
  assert.ok(td.price < td.ema20! && td.ema20! < td.ema50!);
  assert.equal(td.trendScore, -3);
  assert.equal(technicals(up, 123).price, 123, 'live price overrides last close');
});

test('perps maths', () => {
  assert.ok(Math.abs(liquidationPrice('long', 100, 10) - 90.5) < 1e-9);
  assert.ok(Math.abs(liquidationPrice('short', 100, 10) - 109.5) < 1e-9);
  assert.equal(pnlUsd('long', 100, 110, 1000), 100.00000000000009);
  assert.ok(Math.abs(pnlUsd('short', 100, 110, 1000) + 100) < 1e-9);
  assert.equal(isLiquidated('long', 90.5, 90.5), true);
  assert.equal(isLiquidated('short', 109.5, 109), false);
  assert.ok(Math.abs(liqDistancePct('long', 90, 100) - 10) < 1e-9);
  assert.equal(fee(1000), 0.5);
});

test('paper venue: open, close, liquidation, no double close', () => {
  const db = new Db(':memory:', 1000);
  const base = { tgId: 1, symbol: 'NEAR', marketId: 'wrap.near', maxLeverage: 10 };
  const pos = openPerp(db, { ...base, side: 'long', price: 2, collateral: 100, leverage: 5 });
  assert.equal(pos.size_usd, 500);
  assert.ok(Math.abs(db.user(1).paper_usd - (1000 - 100 - 0.25)) < 1e-9);
  const r = closePosition(db, pos, 2.2)!; // +10% * 500 = +50
  assert.ok(Math.abs(r.pnl - 50) < 1e-9);
  assert.ok(Math.abs(db.user(1).paper_usd - (1000 - 0.25 + 50 - 0.25)) < 1e-9);
  assert.equal(closePosition(db, pos, 2.2), null);

  const before = db.user(1).paper_usd;
  const s = openPerp(db, { ...base, side: 'short', price: 2, collateral: 100, leverage: 10 });
  const liq = closePosition(db, s, 2.5)!; // far past liquidation
  assert.equal(liq.liquidated, true);
  assert.equal(liq.pnl, -100);
  assert.ok(Math.abs(db.user(1).paper_usd - (before - 100 - 0.5)) < 1e-9);

  assert.throws(() => openPerp(db, { ...base, side: 'long', price: 2, collateral: 100, leverage: 11 }), /Leverage/);
  assert.throws(() => openPerp(db, { ...base, side: 'long', price: 2, collateral: 1e6, leverage: 2 }), /Not enough/);
  assert.throws(() => openPerp(db, { ...base, side: 'long', price: 2, collateral: NaN, leverage: 2 }), /Collateral/);
  assert.equal(db.position(pos.id, 2), undefined, "another user cannot read someone's position");
});

test('advisor: verdicts', () => {
  const mk = (side: 'long' | 'short', entry: number, leverage: number, kind: 'perp' | 'spot' = 'perp') => ({
    kind, side, entry, sizeUsd: 1000 * leverage, collateral: 1000, leverage,
    liq: kind === 'perp' ? liquidationPrice(side, entry, leverage) : null,
  });

  // Winning long, trend agrees, RSI normal -> hold, with a stop below price and above liquidation
  const a1 = advise(mk('long', 97, 2), tech({}));
  assert.equal(a1.verdict, 'HOLD');
  assert.ok(a1.pnlUsd > 0 && a1.alignment === 3);
  assert.equal(a1.suggestedStop, 98);

  // Winning long, far extended and overbought -> take profit
  assert.equal(advise(mk('long', 90, 2), tech({ rsi14: 80 })).verdict, 'TAKE_PROFIT');

  // Winning long, trend flipped down -> close to lock in
  assert.equal(advise(mk('long', 95, 2), tech({ trendScore: -3 })).verdict, 'CLOSE');

  // Losing short in an uptrend: 2+ ATR under water -> close; slightly under water -> reduce
  assert.equal(advise(mk('short', 97, 2), tech({})).verdict, 'CLOSE');
  assert.equal(advise(mk('short', 99.5, 2), tech({})).verdict, 'REDUCE');

  // Losing long but trend still up -> hold
  assert.equal(advise(mk('long', 101, 2), tech({})).verdict, 'HOLD');

  // 10x long 0.6% from liquidation with 1% hourly swings -> urgent close; 2% away -> urgent reduce
  const near = advise(mk('long', 109.83, 10), tech({}));
  assert.ok(near.liqDistancePct! < 1, String(near.liqDistancePct));
  assert.deepEqual([near.verdict, near.urgent], ['CLOSE', true]);
  const closeish = advise(mk('long', 108.3, 10), tech({}));
  assert.deepEqual([closeish.verdict, closeish.urgent], ['REDUCE', true]);

  // Spot: no liquidation maths
  const spot = advise(mk('long', 100, 1, 'spot'), tech({}));
  assert.equal(spot.liqDistancePct, null);
  assert.equal(spot.verdict, 'HOLD');

  // Thin history is called out
  assert.ok(advise(mk('long', 97, 2), tech({ candles: 20 })).reasons.some((r) => r.includes('low-confidence')));

  // End to end on generated candles: short opened before a rally -> close
  const up = series(10, 0.3, 120);
  const e2e = advise(mk('short', up[60]!.c, 2), technicals(up));
  assert.equal(e2e.verdict, 'CLOSE');
});

test('token analysis: flags thin, new pools', () => {
  const base: MarketSnapshot = {
    address: 'x.near', symbol: 'X', name: 'X', priceUsd: 1, fdvUsd: 50_000_000, marketCapUsd: null, liquidityUsd: 5_000_000,
    volume24hUsd: 800_000, change: { h1: 0.2, h6: 1, h24: 3 }, txns24h: { buys: 400, sells: 300, buyers: null, sellers: null },
    poolAddress: 'p', poolName: 'X / NEAR', poolCreatedAt: '2023-01-01T00:00:00Z',
  };
  const now = Date.parse('2026-11-13T00:00:00Z');
  const good = analyzeToken(base, tech({}), now);
  assert.equal(good.safetyScore, 100);
  assert.equal(good.bias, 'BULLISH');
  const bad = analyzeToken({ ...base, liquidityUsd: 4_000, volume24hUsd: 300, poolCreatedAt: '2026-11-12T00:00:00Z', change: { h1: 0, h6: 0, h24: 80 } }, null, now);
  assert.ok(bad.safetyScore <= 20, String(bad.safetyScore));
  assert.ok(bad.flags.length >= 4);
  assert.equal(bad.bias, 'NEUTRAL');
  assert.equal(analyzeToken(base, tech({ trendScore: -3, rsi14: 40 }), now).bias, 'BEARISH');
  assert.equal(analyzeToken(base, tech({ rsi14: 82 }), now).bias, 'NEUTRAL', 'overbought uptrend is not a buy signal');
});

test('token resolution on testnet', () => {
  assert.deepEqual(resolveToken('near'), { symbol: 'NEAR', marketId: 'wrap.near', tradeId: 'wrap.testnet' });
  assert.deepEqual(resolveToken('foo.testnet'), { symbol: 'foo.testnet', marketId: null, tradeId: 'foo.testnet' });
  assert.deepEqual(resolveToken('token.sweat'), { symbol: 'token.sweat', marketId: 'token.sweat', tradeId: null });
  assert.equal(resolveToken('<script>'), null);
  assert.equal(resolveToken('doge'), null);
});
