import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getMarketAndCandles, MarketError, searchToken } from '../src/market.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(routes: Record<string, { status?: number; body?: unknown }>) {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const r = key ? routes[key]! : { status: 404 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
}

test('market: parses token, top pool and candles (oldest first)', async () => {
  stub({
    '/tokens/aaa.near': {
      body: {
        data: { attributes: { name: 'Aaa', symbol: 'AAA', price_usd: '2.5', fdv_usd: '1000000', market_cap_usd: null, volume_usd: { h24: '5000' } } },
        included: [
          { id: 'near_small', attributes: { address: 'small', name: 'AAA / X', pool_created_at: null, reserve_in_usd: '10' } },
          {
            id: 'near_big',
            attributes: {
              address: 'big', name: 'AAA / NEAR', pool_created_at: '2024-01-01T00:00:00Z', reserve_in_usd: '90000',
              price_change_percentage: { h1: '1.5', h6: '-2', h24: '4' }, transactions: { h24: { buys: 10, sells: 5 } },
            },
          },
        ],
      },
    },
    '/pools/big/ohlcv': { body: { data: { attributes: { ohlcv_list: [[200, 2, 3, 1, 2.5, 9], [100, 1, 2, 1, 2, 8]] } } } },
  });
  const { market, candles } = await getMarketAndCandles('aaa.near');
  assert.equal(market.priceUsd, 2.5);
  assert.equal(market.poolAddress, 'big');
  assert.equal(market.liquidityUsd, 90000);
  assert.equal(market.marketCapUsd, null);
  assert.deepEqual(market.change, { h1: 1.5, h6: -2, h24: 4 });
  assert.deepEqual(candles.map((c) => c.t), [100, 200]);
  assert.equal(candles[1]!.c, 2.5);
});

test('market: search picks the exact symbol, errors are typed', async () => {
  stub({
    '/search/pools': {
      body: {
        data: [
          { id: '1', attributes: { name: 'FOOBAR / NEAR', reserve_in_usd: '999999' }, relationships: { base_token: { data: { id: 'near_foobar.near' } } } },
          { id: '2', attributes: { name: 'FOO / NEAR', reserve_in_usd: '10' }, relationships: { base_token: { data: { id: 'near_foo.near' } } } },
        ],
      },
    },
    '/tokens/limited.near': { status: 429 },
  });
  assert.equal(await searchToken('foo'), 'foo.near');
  await assert.rejects(getMarketAndCandles('missing.near'), (e) => e instanceof MarketError && e.code === 'not_found');
  await assert.rejects(getMarketAndCandles('limited.near'), (e) => e instanceof MarketError && e.code === 'rate_limited');
});
