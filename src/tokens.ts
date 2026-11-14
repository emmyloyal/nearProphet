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

const HEX64 = /^[0-9a-f]{64}$/;
const ETH_ADDR = /^0x([0-9a-f]{40})$/;
const looksLikeContract = (s: string) => isAccountId(s) && (/\.(near|testnet)$/.test(s) || HEX64.test(s));

/**
 * Turn what people paste into a contract id: a plain id, a $SYMBOL, an Ethereum address of a
 * bridged token (0x… → <hex>.factory.bridge.near), or a link that contains the id
 * (NearBlocks, Rhea/Ref swap links "…#a.near|b.near", explorers). Returns the input unchanged
 * when nothing better is found.
 */
export function normalizeTokenInput(input: string): string {
  let s = input.trim().replace(/^\$(?=[A-Za-z])/, '');
  const eth = ETH_ADDR.exec(s.toLowerCase());
  if (eth) return `${eth[1]}.factory.bridge.near`;
  if (/^https?:\/\//i.test(s) || s.includes('|')) {
    let rest = s;
    try {
      const u = new URL(s);
      rest = `${u.pathname} ${u.search} ${u.hash}`;
    } catch {
      /* not a URL: a Rhea-style "a|b" pair */
    }
    const parts = rest
      .split(/[\s/|#?&=,]+/)
      .map((p) => {
        try {
          return decodeURIComponent(p).toLowerCase();
        } catch {
          return p.toLowerCase();
        }
      })
      .map((p) => (ETH_ADDR.test(p) ? `${p.slice(2)}.factory.bridge.near` : p))
      .filter(looksLikeContract);
    // In a swap link the token being bought comes last.
    if (parts.length) s = parts[parts.length - 1]!;
  }
  return s;
}

function known(symbol: string, k: { mainnet: string; testnet: string | null }): TokenRef {
  return { symbol, marketId: k.mainnet, tradeId: config.network === 'mainnet' ? k.mainnet : k.testnet };
}

/** Resolve user input (symbol, contract id, 0x address or link) without any network calls. */
export function resolveToken(input: string): TokenRef | null {
  const raw = normalizeTokenInput(input);
  const bySymbol = REGISTRY[raw.toUpperCase()];
  if (bySymbol) return known(raw.toUpperCase(), bySymbol);
  const id = raw.toLowerCase();
  // A known token's contract (mainnet or testnet) maps to both identities, so e.g. pasting
  // token.v2.ref-finance.near on testnet still trades the testnet REF.
  for (const [sym, k] of Object.entries(REGISTRY)) if (k.mainnet === id || k.testnet === id) return known(sym, k);
  if (!isAccountId(id) || !(id.includes('.') || /^[0-9a-f]{64}$/.test(id))) return null;
  const isTestnetId = id.endsWith('.testnet');
  if (config.network === 'mainnet') return isTestnetId ? null : { symbol: id, marketId: id, tradeId: id };
  return isTestnetId ? { symbol: id, marketId: null, tradeId: id } : { symbol: id, marketId: id, tradeId: null };
}
