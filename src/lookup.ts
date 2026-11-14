import { config } from './config.js';
import { searchToken } from './market.js';
import { knownSymbols, normalizeTokenInput, resolveToken, type TokenRef } from './tokens.js';

export const TOKEN_NOT_FOUND =
  'Token not found. Send its symbol (REF), contract address (token.v2.ref-finance.near) or a NearBlocks / Rhea link.';

/** Why a found token cannot be used for research, or null if it can. */
export function noMarketReason(t: TokenRef): string | null {
  if (t.marketId) return null;
  return `${t.symbol} is a ${config.network} test token, so it has no market price. You can still /buy and /sell it here.`;
}

/** Why a found token cannot be swapped on this network, or null if it can. */
export function notTradableReason(t: TokenRef): string | null {
  if (t.tradeId) return null;
  return `That token only trades on mainnet. On ${config.network} you can still /analyze it and paper-trade it with /long or /short. Swaps on ${config.network} work for: ${knownSymbols().join(', ')}.`;
}

/** Symbol, contract id, 0x address or link -> token, falling back to a market search by name. */
export async function findToken(input: string): Promise<TokenRef | null> {
  const direct = resolveToken(input);
  if (direct) return direct;
  const q = normalizeTokenInput(input);
  if (!/^[\w.$-]{2,32}$/.test(q)) return null;
  const found = await searchToken(q);
  if (!found) return null;
  // The search may land on a token we know (e.g. "ref-finance"): use its testnet mapping too.
  const knownToken = resolveToken(found);
  if (knownToken) return knownToken;
  return { symbol: q.toUpperCase(), marketId: found, tradeId: config.network === 'mainnet' ? found : null };
}
