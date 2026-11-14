import { type Account, actions, nearToYocto } from 'near-api-js';
import { config } from './config.js';
import { ftBalance, ONE_YOCTO, storageNeeded, TGAS, view } from './near.js';
import { applySlippage } from './units.js';

/** Spot swaps on Ref Finance (simple pools, single hop, "instant swap" via ft_transfer_call). */

interface RefPool {
  pool_kind: string;
  token_account_ids: string[];
  amounts: string[];
  total_fee: number;
}
interface IndexedPool extends RefPool {
  id: number;
}

let poolCache: { at: number; pools: IndexedPool[] } | null = null;
const POOL_TTL_MS = 30 * 60_000;
const PAGE = 100;

async function allPools(): Promise<IndexedPool[]> {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.pools;
  const total = await view<number>(config.refContract, 'get_number_of_pools');
  const pools: IndexedPool[] = [];
  const starts: number[] = [];
  for (let i = 0; i < total; i += PAGE) starts.push(i);
  for (let i = 0; i < starts.length; i += 5) {
    const batch = await Promise.all(
      starts.slice(i, i + 5).map(async (from) => {
        const page = await view<RefPool[]>(config.refContract, 'get_pools', { from_index: from, limit: PAGE });
        return page.map((p, k) => ({ ...p, id: from + k }));
      }),
    );
    for (const b of batch) pools.push(...b);
  }
  poolCache = { at: Date.now(), pools };
  return pools;
}

/** "This pair has no usable pool", as opposed to a network or RPC failure. */
export class NoRouteError extends Error {}
const noRouteOnly = (e: unknown) => {
  if (e instanceof NoRouteError) return null;
  throw e;
};

export interface Hop {
  poolId: number;
  tokenIn: string;
  tokenOut: string;
}

export interface Quote {
  /** First pool (kept for display); `hops` is the full route */
  poolId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  /** One pool, or two when routed through wNEAR (e.g. REF -> wNEAR -> USDC) */
  hops: Hop[];
}

/** Best single-pool quote among the deepest simple pools holding both tokens. */
export async function quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  if (tokenIn === tokenOut) throw new Error('Token in and token out are the same.');
  const candidates = (await allPools())
    .filter(
      (p) =>
        p.pool_kind === 'SIMPLE_POOL' &&
        p.token_account_ids.length === 2 &&
        p.token_account_ids.includes(tokenIn) &&
        p.token_account_ids.includes(tokenOut) &&
        p.amounts.every((a) => BigInt(a) > 0n),
    )
    .sort((a, b) => {
      const ra = BigInt(a.amounts[a.token_account_ids.indexOf(tokenIn)]!);
      const rb = BigInt(b.amounts[b.token_account_ids.indexOf(tokenIn)]!);
      return rb > ra ? 1 : rb < ra ? -1 : 0;
    })
    .slice(0, 3);
  if (!candidates.length) throw new NoRouteError('No Ref Finance pool with liquidity for this pair on this network.');
  const outs = await Promise.all(
    candidates.map(async (p) => ({
      id: p.id,
      out: BigInt(
        await view<string>(config.refContract, 'get_return', {
          pool_id: p.id,
          token_in: tokenIn,
          amount_in: amountIn.toString(),
          token_out: tokenOut,
        }),
      ),
    })),
  );
  const best = outs.reduce((a, b) => (b.out > a.out ? b : a));
  if (best.out <= 0n) throw new NoRouteError('Pool returned a zero quote; the amount is too small or the pool is empty.');
  return {
    poolId: best.id,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut: best.out,
    minOut: applySlippage(best.out, config.slippagePct),
    hops: [{ poolId: best.id, tokenIn, tokenOut }],
  };
}

/**
 * Best route for any token pair: a direct pool, or two pools through wNEAR (the hub most NEAR
 * tokens are paired with), whichever returns more. Both hops run in one Ref transaction.
 */
export async function quoteRoute(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  if (tokenIn === tokenOut) throw new Error('Token in and token out are the same.');
  const wrap = config.wrapContract;
  const direct = quote(tokenIn, tokenOut, amountIn).catch(noRouteOnly);
  const viaNear =
    tokenIn === wrap || tokenOut === wrap
      ? Promise.resolve(null)
      : quote(tokenIn, wrap, amountIn)
          .then(async (a) => {
            const b = await quote(wrap, tokenOut, a.amountOut);
            return {
              poolId: a.poolId,
              tokenIn,
              tokenOut,
              amountIn,
              amountOut: b.amountOut,
              minOut: applySlippage(b.amountOut, config.slippagePct),
              hops: [...a.hops, ...b.hops],
            } satisfies Quote;
          })
          .catch(noRouteOnly);
  const [d, v] = await Promise.all([direct, viaNear]);
  const best = d && v ? (v.amountOut > d.amountOut ? v : d) : (d ?? v);
  if (!best) throw new NoRouteError('No Ref Finance route with liquidity for this pair on this network (directly or through NEAR).');
  return best;
}

/** Ref "instant swap" message. In a multi-hop route each later hop takes the previous hop's output; only the last hop enforces the minimum. */
export function swapMsg(q: Quote): string {
  const hops = q.hops?.length ? q.hops : [{ poolId: q.poolId, tokenIn: q.tokenIn, tokenOut: q.tokenOut }];
  return JSON.stringify({
    force: 0,
    actions: hops.map((h, i) => ({
      pool_id: h.poolId,
      token_in: h.tokenIn,
      token_out: h.tokenOut,
      ...(i === 0 ? { amount_in: q.amountIn.toString() } : {}),
      min_amount_out: i === hops.length - 1 ? q.minOut.toString() : '0',
    })),
  });
}

function swapAction(q: Quote) {
  const msg = swapMsg(q);
  return actions.functionCall(
    'ft_transfer_call',
    { receiver_id: config.refContract, amount: q.amountIn.toString(), msg },
    180n * TGAS,
    ONE_YOCTO,
  );
}

const storageDeposit = (accountId: string, yocto: bigint) =>
  actions.functionCall('storage_deposit', { account_id: accountId, registration_only: true }, 30n * TGAS, yocto);

export interface SwapResult {
  received: bigint;
  txHash: string | null;
}

const GAS_RESERVE = nearToYocto('0.25');

/** Spend native NEAR to buy `tokenOut`. `q.tokenIn` must be the wNEAR contract. */
export async function buyWithNear(account: Account, q: Quote, availableYocto: bigint): Promise<SwapResult> {
  const wrap = config.wrapContract;
  const me = account.accountId;
  const [wrapStorage, outStorage] = await Promise.all([storageNeeded(wrap, me), storageNeeded(q.tokenOut, me)]);
  if (availableYocto < q.amountIn + wrapStorage + outStorage + GAS_RESERVE)
    throw new Error('Not enough NEAR: the bot keeps 0.25 NEAR back for network fees.');

  const before = await ftBalance(q.tokenOut, me).catch(() => 0n);
  const wrapActions = [];
  if (wrapStorage > 0n) wrapActions.push(storageDeposit(me, wrapStorage));
  wrapActions.push(actions.functionCall('near_deposit', {}, 30n * TGAS, q.amountIn));

  const txs = [{ receiverId: wrap, actions: wrapActions }];
  if (outStorage > 0n) txs.push({ receiverId: q.tokenOut, actions: [storageDeposit(me, outStorage)] });
  txs.push({ receiverId: wrap, actions: [swapAction(q)] });

  const results = await account.signAndSendTransactions({ transactions: txs });
  const txHash = txHashOf(results[results.length - 1]);
  const received = (await ftBalance(q.tokenOut, me)) - before;
  if (received <= 0n) {
    // The swap was rejected inside Ref (e.g. slippage) and the wNEAR was refunded. Turn it back into NEAR.
    await unwrapUpTo(account, q.amountIn).catch(() => undefined);
    throw new Error('Swap was rejected by the pool (price moved past your slippage limit). Your NEAR was returned.');
  }
  return { received, txHash };
}

/** Sell `q.tokenIn` for native NEAR. `q.tokenOut` must be the wNEAR contract. */
export async function sellForNear(account: Account, q: Quote): Promise<SwapResult> {
  const wrap = config.wrapContract;
  const me = account.accountId;
  const wrapStorage = await storageNeeded(wrap, me);
  const before = await ftBalance(wrap, me).catch(() => 0n);

  const txs = [];
  if (wrapStorage > 0n) txs.push({ receiverId: wrap, actions: [storageDeposit(me, wrapStorage)] });
  txs.push({ receiverId: q.tokenIn, actions: [swapAction(q)] });
  const results = await account.signAndSendTransactions({ transactions: txs });
  const txHash = txHashOf(results[results.length - 1]);

  const received = (await ftBalance(wrap, me)) - before;
  if (received <= 0n) throw new Error('Swap was rejected by the pool (price moved past your slippage limit). Your tokens were returned.');
  await account.callFunction({
    contractId: wrap,
    methodName: 'near_withdraw',
    args: { amount: received.toString() },
    gas: 30n * TGAS,
    deposit: ONE_YOCTO,
  });
  return { received, txHash };
}

/** Swap one token for another (any route from quoteRoute). Neither side may be wNEAR. */
export async function swapTokens(account: Account, q: Quote): Promise<SwapResult> {
  const me = account.accountId;
  const outStorage = await storageNeeded(q.tokenOut, me);
  const before = await ftBalance(q.tokenOut, me).catch(() => 0n);
  const txs = [];
  if (outStorage > 0n) txs.push({ receiverId: q.tokenOut, actions: [storageDeposit(me, outStorage)] });
  txs.push({ receiverId: q.tokenIn, actions: [swapAction(q)] });
  const results = await account.signAndSendTransactions({ transactions: txs });
  const txHash = txHashOf(results[results.length - 1]);
  const received = (await ftBalance(q.tokenOut, me)) - before;
  if (received <= 0n) throw new Error('Swap was rejected by the pool (price moved past your slippage limit). Your tokens were returned.');
  return { received, txHash };
}

async function unwrapUpTo(account: Account, max: bigint): Promise<void> {
  const held = await ftBalance(config.wrapContract, account.accountId);
  const bal = held < max ? held : max;
  if (bal > 0n)
    await account.callFunction({
      contractId: config.wrapContract,
      methodName: 'near_withdraw',
      args: { amount: bal.toString() },
      gas: 30n * TGAS,
      deposit: ONE_YOCTO,
    });
}

function txHashOf(r: unknown): string | null {
  return ((r as any)?.transaction?.hash as string | undefined) ?? null;
}
