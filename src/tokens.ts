import { config } from './config.js';

/**
 * A token has up to two identities:
 *  - marketId: its mainnet contract, used for prices and analysis
 *  - tradeId:  the contract the bot actually swaps on the configured network
 * On testnet these differ (test tokens have no real market), so known symbols are mapped here.
 */
export interface TokenRef {
  symbol: string;
  marketId: string | null;
  tradeId: string | null;
}

const REGISTRY: Record<string, { mainnet: string; testnet: string | null }> = {
  NEAR: { mainnet: 'wrap.near', testnet: 'wrap.testnet' },
  REF: { mainnet: 'token.v2.ref-finance.near', testnet: 'ref.fakes.testnet' },
  USDT: { mainnet: 'usdt.tether-token.near', testnet: 'usdt.fakes.testnet' },
  USDC: { mainnet: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', testnet: 'usdc.fakes.testnet' },
  ETH: { mainnet: 'eth.bridge.near', testnet: 'eth.fakes.testnet' },
  AURORA: { mainnet: 'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near', testnet: 'aurora.fakes.testnet' },
};

export function knownSymbols(): string[] {
  return Object.keys(REGISTRY);
}

const ACCOUNT_RE = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;

export function isAccountId(s: string): boolean {
  return ACCOUNT_RE.test(s);
}

/** Resolve user input (symbol or contract id) without any network calls. */
export function resolveToken(input: string): TokenRef | null {
  const raw = input.trim();
  const known = REGISTRY[raw.toUpperCase()];
  if (known) {
    return {
      symbol: raw.toUpperCase(),
      marketId: known.mainnet,
      tradeId: config.network === 'mainnet' ? known.mainnet : known.testnet,
    };
  }
  const id = raw.toLowerCase();
  if (!isAccountId(id) || !(id.includes('.') || /^[0-9a-f]{64}$/.test(id))) return null;
  const isTestnetId = id.endsWith('.testnet');
  if (config.network === 'mainnet') return isTestnetId ? null : { symbol: id, marketId: id, tradeId: id };
  return isTestnetId ? { symbol: id, marketId: null, tradeId: id } : { symbol: id, marketId: id, tradeId: null };
}
