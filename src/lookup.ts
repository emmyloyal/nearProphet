import { config } from './config.js';
import { searchToken } from './market.js';
import { resolveToken, type TokenRef } from './tokens.js';

/** Symbol/contract -> token, falling back to a market search by name. */
export async function findToken(input: string): Promise<TokenRef | null> {
  const direct = resolveToken(input);
  if (direct) return direct;
  if (!/^[\w.$-]{2,32}$/.test(input)) return null;
  const found = await searchToken(input);
  return found ? { symbol: input.toUpperCase(), marketId: found, tradeId: config.network === 'mainnet' ? found : null } : null;
}
