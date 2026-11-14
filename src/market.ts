import type { MarketSnapshot } from './analysis.js';
import { config } from './config.js';
import type { Candle } from './indicators.js';

/** Market data from GeckoTerminal's public API (mainnet prices; ~30 requests/min on the free tier). */

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 60_000;

async function get<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const res = await fetch(config.geckoBase + path, {
    headers: { accept: 'application/json;version=20230302' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) throw new MarketError('not_found', 'Token or pool not found on the market data provider.');
  if (res.status === 429) throw new MarketError('rate_limited', 'Market data is rate-limited right now. Try again in a minute.');
  if (!res.ok) throw new MarketError('upstream', `Market data provider returned ${res.status}.`);
  const value = (await res.json()) as T;
  cache.set(path, { at: Date.now(), value });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
  return value;
}

export class MarketError extends Error {
  constructor(public code: 'not_found' | 'rate_limited' | 'upstream', message: string) {
    super(message);
  }
}

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

interface GeckoPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    pool_created_at: string | null;
    reserve_in_usd: string | null;
    price_change_percentage?: Record<string, string>;
    transactions?: Record<string, { buys: number; sells: number; buyers?: number; sellers?: number }>;
    volume_usd?: Record<string, string>;
  };
  relationships?: { base_token?: { data?: { id: string } } };
}

/** Find a token's contract address from a symbol or name. Returns the base token of the deepest matching pool. */
export async function searchToken(query: string): Promise<string | null> {
  const r = await get<{ data: GeckoPool[] }>(
    `/search/pools?query=${encodeURIComponent(query)}&network=${config.geckoNetwork}&page=1`,
  );
  const pools = [...r.data].sort((a, b) => (n(b.attributes.reserve_in_usd) ?? 0) - (n(a.attributes.reserve_in_usd) ?? 0));
  const q = query.toLowerCase();
  const exact = pools.find((p) => p.attributes.name.split('/')[0]?.trim().toLowerCase() === q) ?? pools[0];
  const id = exact?.relationships?.base_token?.data?.id; // "<network>_<address>"
  return id ? id.slice(id.indexOf('_') + 1) : null;
}

export async function getMarket(address: string): Promise<MarketSnapshot> {
  const r = await get<{
    data: { attributes: Record<string, any> };
    included?: GeckoPool[];
  }>(`/networks/${config.geckoNetwork}/tokens/${encodeURIComponent(address)}?include=top_pools`);
  const a = r.data.attributes;
  const pool = [...(r.included ?? [])].sort(
    (x, y) => (n(y.attributes.reserve_in_usd) ?? 0) - (n(x.attributes.reserve_in_usd) ?? 0),
  )[0];
  const price = n(a.price_usd);
  if (price === null) throw new MarketError('not_found', 'No price available for this token.');
  const pc = pool?.attributes.price_change_percentage ?? {};
  const tx = pool?.attributes.transactions?.h24;
  return {
    address,
    symbol: String(a.symbol ?? '?'),
    name: String(a.name ?? '?'),
    priceUsd: price,
    fdvUsd: n(a.fdv_usd),
    marketCapUsd: n(a.market_cap_usd),
    liquidityUsd: pool ? n(pool.attributes.reserve_in_usd) : n(a.total_reserve_in_usd),
    volume24hUsd: n(a.volume_usd?.h24),
    change: { h1: n(pc.h1), h6: n(pc.h6), h24: n(pc.h24) },
    txns24h: tx ? { buys: tx.buys, sells: tx.sells, buyers: tx.buyers ?? null, sellers: tx.sellers ?? null } : null,
    poolAddress: pool?.attributes.address ?? null,
    poolName: pool?.attributes.name ?? null,
    poolCreatedAt: pool?.attributes.pool_created_at ?? null,
  };
}

/** Hourly candles, oldest first, priced in USD for `tokenAddress`. */
export async function getCandles(poolAddress: string, tokenAddress: string, limit = 200): Promise<Candle[]> {
  const r = await get<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `/networks/${config.geckoNetwork}/pools/${encodeURIComponent(poolAddress)}/ohlcv/hour?aggregate=1&limit=${limit}&currency=usd&token=${encodeURIComponent(tokenAddress)}`,
  );
  return r.data.attributes.ohlcv_list
    .map((x) => ({ t: x[0]!, o: x[1]!, h: x[2]!, l: x[3]!, c: x[4]!, v: x[5]! }))
    .sort((a, b) => a.t - b.t);
}

export async function getMarketAndCandles(address: string): Promise<{ market: MarketSnapshot; candles: Candle[] }> {
  const market = await getMarket(address);
  let candles: Candle[] = [];
  if (market.poolAddress) {
    try {
      candles = await getCandles(market.poolAddress, address);
    } catch (e) {
      if (!(e instanceof MarketError)) throw e;
    }
  }
  return { market, candles };
}
