import { randomBytes } from 'node:crypto';
import { nearToYocto } from 'near-api-js';
import { config } from './config.js';
import type { Db } from './db.js';
import { esc, positionLine, price, signed } from './format.js';
import { getMarket } from './market.js';
import { ftBalance, ftMetadata, nearBalance, signerAccount, withUserLock } from './near.js';
import { closePosition, openPerp } from './paper.js';
import { fee, liquidationPrice, type Side } from './perps.js';
import { buyWithNear, quote, type Quote, sellForNear } from './ref.js';
import { knownSymbols, type TokenRef } from './tokens.js';
import { fromUnits, toUnits } from './units.js';

/**
 * Every action that moves money (real or paper) goes through here:
 *   prepare -> user sees a summary with Confirm/Cancel -> execute.
 * Both typed commands and the AI agent create proposals; only a tap by the same user executes one.
 */

export type Proposal =
  | { kind: 'buy'; token: TokenRef; q: Quote; decimals: number; nearAmount: string; symbol: string }
  | { kind: 'sell'; token: TokenRef; q: Quote; decimals: number; sellAll: boolean; symbol: string }
  | { kind: 'open'; side: Side; token: TokenRef; symbol: string; collateral: number; leverage: number }
  | { kind: 'close'; positionId: number };

interface Stored {
  tgId: number;
  p: Proposal;
  expires: number;
}

const TTL_MS = 60_000;
const store = new Map<string, Stored>();

export function register(tgId: number, p: Proposal): string {
  const id = randomBytes(6).toString('hex');
  store.set(id, { tgId, p, expires: Date.now() + TTL_MS });
  return id;
}

/** Single use: removed on first read so a double tap cannot execute twice. */
export function take(id: string, tgId: number): { ok: true; p: Proposal } | { ok: false; why: string } {
  const s = store.get(id);
  store.delete(id);
  if (!s || s.tgId !== tgId) return { ok: false, why: 'This confirmation is no longer valid.' };
  if (Date.now() > s.expires) return { ok: false, why: 'This quote expired (60s). Ask again for a fresh price.' };
  return { ok: true, p: s.p };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expires + TTL_MS) store.delete(k);
}, 60_000).unref();

export class UserError extends Error {}

// ---------- prepare ----------

export async function prepareBuy(db: Db, tgId: number, token: TokenRef | null, nearAmount: string): Promise<{ p: Proposal; summary: string }> {
  const user = db.user(tgId);
  if (!user.account_id) throw new UserError('Create a wallet first with /wallet.');
  if (!token?.tradeId) throw new UserError(`That token is not tradable on ${config.network}. Known symbols: ${knownSymbols().join(', ')}`);
  if (token.tradeId === config.wrapContract) throw new UserError('You already hold NEAR; pick another token to buy.');
  const amountIn = toUnits(nearAmount, 24);
  if (amountIn <= 0n) throw new UserError('Amount must be more than zero.');
  if (amountIn > nearToYocto(String(config.maxTradeNear) as `${number}`)) throw new UserError(`Max per trade is ${config.maxTradeNear} NEAR.`);
  const meta = await ftMetadata(token.tradeId);
  const q = await quote(config.wrapContract, token.tradeId, amountIn);
  return {
    p: { kind: 'buy', token, q, decimals: meta.decimals, nearAmount, symbol: meta.symbol },
    summary: `<b>Confirm buy</b>\nSpend: ${esc(nearAmount)} NEAR\nReceive: ~${fromUnits(q.amountOut, meta.decimals)} ${esc(meta.symbol)}\nMinimum (after ${config.slippagePct}% slippage): ${fromUnits(q.minOut, meta.decimals)}\nPool #${q.poolId} on Ref Finance (${config.network})`,
  };
}

export async function prepareSell(db: Db, tgId: number, token: TokenRef | null, amount: string): Promise<{ p: Proposal; summary: string }> {
  const user = db.user(tgId);
  if (!user.account_id) throw new UserError('Create a wallet first with /wallet.');
  if (!token?.tradeId || token.tradeId === config.wrapContract) throw new UserError(`That token is not sellable on ${config.network}.`);
  const meta = await ftMetadata(token.tradeId);
  const bal = await ftBalance(token.tradeId, user.account_id);
  let amountIn: bigint;
  const pm = /^(\d+(?:\.\d+)?)%$/.exec(amount.trim());
  if (pm) {
    const pct = Number(pm[1]);
    if (!(pct > 0 && pct <= 100)) throw new UserError('Percent must be between 0 and 100.');
    amountIn = (bal * BigInt(Math.round(pct * 100))) / 10_000n;
  } else amountIn = toUnits(amount, meta.decimals);
  if (amountIn <= 0n) throw new UserError('Nothing to sell.');
  if (amountIn > bal) throw new UserError(`You only hold ${fromUnits(bal, meta.decimals)} ${meta.symbol}.`);
  const q = await quote(token.tradeId, config.wrapContract, amountIn);
  return {
    p: { kind: 'sell', token, q, decimals: meta.decimals, sellAll: amountIn === bal, symbol: meta.symbol },
    summary: `<b>Confirm sell</b>\nSell: ${fromUnits(amountIn, meta.decimals)} ${esc(meta.symbol)}\nReceive: ~${fromUnits(q.amountOut, 24)} NEAR\nMinimum (after ${config.slippagePct}% slippage): ${fromUnits(q.minOut, 24)} NEAR`,
  };
}

export async function prepareOpen(
  db: Db,
  tgId: number,
  side: Side,
  token: TokenRef | null,
  collateral: number,
  leverage: number,
): Promise<{ p: Proposal; summary: string }> {
  if (!token?.marketId) throw new UserError('Token not found. Try its contract address.');
  if (!(collateral >= 1)) throw new UserError('Collateral must be at least $1.');
  if (!(leverage >= 1 && leverage <= config.maxLeverage)) throw new UserError(`Leverage must be between 1 and ${config.maxLeverage}.`);
  const m = await getMarket(token.marketId);
  if ((m.liquidityUsd ?? 0) < 25_000)
    throw new UserError(`Liquidity is too thin ($${(m.liquidityUsd ?? 0).toFixed(0)}) for a meaningful ${side}. Minimum is $25K.`);
  const size = collateral * leverage;
  const cost = collateral + fee(size);
  const bal = db.user(tgId).paper_usd;
  if (bal < cost) throw new UserError(`Not enough paper balance: need $${cost.toFixed(2)}, have $${bal.toFixed(2)}.`);
  const symbol = m.symbol.toUpperCase();
  return {
    p: { kind: 'open', side, token, symbol, collateral, leverage },
    summary: `<b>Confirm ${side.toUpperCase()} ${esc(symbol)} ${leverage}x</b> (paper)\nPrice now: $${price(m.priceUsd)}\nCollateral: $${collateral.toFixed(2)} → size $${size.toFixed(2)}\nLiquidation ≈ $${price(liquidationPrice(side, m.priceUsd, leverage))}\nFee: $${fee(size).toFixed(2)}`,
  };
}

export async function prepareClose(db: Db, tgId: number, positionId: number): Promise<{ p: Proposal; summary: string }> {
  const pos = db.position(positionId, tgId);
  if (!pos || pos.status !== 'open') throw new UserError('No open trade with that id. See /positions.');
  const px = (await getMarket(pos.market_id)).priceUsd;
  return {
    p: { kind: 'close', positionId },
    summary: `<b>Confirm close ${positionLine(pos)}</b>\nEntry $${price(pos.entry)} → now $${price(px)}`,
  };
}

// ---------- execute ----------

export async function execute(db: Db, tgId: number, p: Proposal): Promise<string> {
  switch (p.kind) {
    case 'buy':
    case 'sell':
      return executeSwap(db, tgId, p);
    case 'open': {
      const m = await getMarket(p.token.marketId!);
      const pos = openPerp(db, {
        tgId,
        side: p.side,
        symbol: p.symbol,
        marketId: p.token.marketId!,
        price: m.priceUsd,
        collateral: p.collateral,
        leverage: p.leverage,
        maxLeverage: config.maxLeverage,
      });
      return `✅ Opened ${positionLine(pos)} (paper) at $${price(pos.entry)}. Liquidation $${price(pos.liq!)}.\nI'm watching it; /check ${pos.id} any time.`;
    }
    case 'close': {
      const pos = db.position(p.positionId, tgId);
      if (!pos || pos.status !== 'open') return 'That trade is already closed.';
      const px = (await getMarket(pos.market_id)).priceUsd;
      const r = closePosition(db, pos, px);
      if (!r) return 'That trade is already closed.';
      if (pos.kind === 'spot')
        return `Stopped tracking ${positionLine(pos)} at $${price(px)} (${signed(r.pnl)}). Your tokens are still in your wallet; use /sell to sell them.`;
      return r.liquidated
        ? `💥 ${positionLine(pos)} was already past liquidation at $${price(px)}. Loss: ${signed(r.pnl)}.`
        : `✅ Closed ${positionLine(pos)} at $${price(px)}. PnL: ${signed(r.pnl)}. Returned $${r.returned.toFixed(2)} to your paper balance.`;
    }
  }
}

async function executeSwap(db: Db, tgId: number, p: Extract<Proposal, { kind: 'buy' | 'sell' }>): Promise<string> {
  const res = await withUserLock(tgId, async () => {
    const user = db.user(tgId);
    const account = signerAccount(user);
    if (p.kind === 'buy') {
      const avail = await nearBalance(user.account_id!);
      if (avail === null) throw new UserError('Your wallet is not active yet. Fund it first (/wallet).');
      return buyWithNear(account, p.q, avail);
    }
    return sellForNear(account, p.q);
  });
  const explorer = res.txHash ? `\nhttps://${config.network === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${res.txHash}` : '';
  db.logTrade({
    tg_id: tgId,
    action: p.kind,
    token_in: p.q.tokenIn,
    token_out: p.q.tokenOut,
    amount_in: p.q.amountIn.toString(),
    amount_out: res.received.toString(),
    tx_hash: res.txHash,
  });
  if (p.kind === 'buy') {
    let tracked = '';
    if (p.token.marketId) {
      try {
        const [tok, near] = await Promise.all([getMarket(p.token.marketId), getMarket('wrap.near')]);
        const usd = Number(p.nearAmount) * near.priceUsd;
        const pid = db.openPosition({ tg_id: tgId, kind: 'spot', side: 'long', symbol: p.symbol, market_id: p.token.marketId, entry: tok.priceUsd, size_usd: usd, collateral: usd, leverage: 1, liq: null });
        tracked = `\nTracking as position #${pid}. /check ${pid} for a hold-or-sell read.`;
      } catch {
        /* tracking is best-effort */
      }
    }
    return `✅ Bought ${fromUnits(res.received, p.decimals)} ${p.symbol} for ${p.nearAmount} NEAR.${tracked}${explorer}`;
  }
  if (p.sellAll && p.token.marketId) {
    const px = await getMarket(p.token.marketId).then((m) => m.priceUsd).catch(() => null);
    if (px !== null) for (const pos of db.openPositions(tgId)) if (pos.kind === 'spot' && pos.market_id === p.token.marketId) closePosition(db, pos, px);
  }
  return `✅ Sold for ${fromUnits(res.received, 24)} NEAR.${explorer}`;
}
