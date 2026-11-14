/**
 * Long/short maths. Pure functions, used by the paper venue today and
 * usable as a cross-check against a real venue later.
 */
export type Side = 'long' | 'short';

export const MAINTENANCE_MARGIN = 0.005; // 0.5% of notional
export const TAKER_FEE = 0.0005; // 0.05% of notional per side

export function liquidationPrice(side: Side, entry: number, leverage: number): number {
  const im = 1 / leverage;
  return side === 'long' ? entry * (1 - im + MAINTENANCE_MARGIN) : entry * (1 + im - MAINTENANCE_MARGIN);
}

/** PnL in USD for a position of `sizeUsd` notional. */
export function pnlUsd(side: Side, entry: number, price: number, sizeUsd: number): number {
  const move = price / entry - 1;
  return side === 'long' ? sizeUsd * move : -sizeUsd * move;
}

export function isLiquidated(side: Side, liq: number, price: number): boolean {
  return side === 'long' ? price <= liq : price >= liq;
}

/** Distance from price to liquidation as % of current price (always >= 0 while alive). */
export function liqDistancePct(side: Side, liq: number, price: number): number {
  return side === 'long' ? ((price - liq) / price) * 100 : ((liq - price) / price) * 100;
}

export function fee(sizeUsd: number): number {
  return sizeUsd * TAKER_FEE;
}
