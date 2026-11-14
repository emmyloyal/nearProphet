/**
 * Read-only smoke test against the live services the unit tests fake out.
 * Needs no keys and sends no transactions.  Run: npm run smoke
 *
 * Checks:
 *  1. GeckoTerminal: token lookup, market snapshot, hourly candles, analysis
 *  2. NEAR RPC: account state and FT metadata on the configured network
 *  3. Ref Finance: a 0.1 NEAR -> REF quote on the configured network
 */
import { config } from '../src/config.js';
import { analyzeToken } from '../src/analysis.js';
import { technicals } from '../src/indicators.js';
import { findToken } from '../src/lookup.js';
import { getMarketAndCandles } from '../src/market.js';
import { ftMetadata, nearBalance } from '../src/near.js';
import { quote } from '../src/ref.js';
import { resolveToken } from '../src/tokens.js';

let failed = 0;

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`PASS  ${name} (${Date.now() - t0}ms)\n      ${detail}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name} (${Date.now() - t0}ms)\n      ${(e as Error)?.message ?? e}`);
  }
}

console.log(`network=${config.network} rpc=${config.rpcUrl} ref=${config.refContract}\n`);

await step('market: REF price, pool and candles', async () => {
  const ref = resolveToken('REF');
  if (!ref?.marketId) throw new Error('REF missing from registry');
  const { market, candles } = await getMarketAndCandles(ref.marketId);
  if (!(market.priceUsd > 0)) throw new Error(`bad price ${market.priceUsd}`);
  if (candles.length < 50) throw new Error(`only ${candles.length} candles`);
  const report = analyzeToken(market, technicals(candles, market.priceUsd));
  return `$${market.priceUsd} via ${market.poolName}; ${candles.length} candles; safety ${report.safetyScore}/100, bias ${report.bias}`;
});

await step('market: search by name (findToken "LONK")', async () => {
  const t = await findToken('LONK');
  if (!t?.marketId) throw new Error('not found');
  return `${t.symbol} -> ${t.marketId}`;
});

await step('rpc: wrap contract state and metadata', async () => {
  const bal = await nearBalance(config.wrapContract);
  if (bal === null) throw new Error(`${config.wrapContract} does not exist on ${config.network}`);
  const meta = await ftMetadata(config.wrapContract);
  return `${config.wrapContract}: ${meta.symbol}, ${meta.decimals} decimals`;
});

await step('ref: quote 0.1 NEAR -> REF', async () => {
  const ref = resolveToken('REF');
  if (!ref?.tradeId) throw new Error(`REF is not tradable on ${config.network}`);
  const q = await quote(config.wrapContract, ref.tradeId, 10n ** 23n);
  return `pool ${q.poolId}: out ${q.amountOut} (min ${q.minOut}) of ${ref.tradeId}`;
});

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
