import type { Db, PositionRow } from './db.js';
import { fee, isLiquidated, liquidationPrice, pnlUsd, type Side } from './perps.js';

/**
 * Paper long/short venue: positions are simulated against live market prices with play money.
 * Swap this module for a real venue adapter (see README) when moving to real leverage.
 */

export interface OpenParams {
  tgId: number;
  side: Side;
  symbol: string;
  marketId: string;
  price: number;
  collateral: number;
  leverage: number;
  maxLeverage: number;
}

export function openPerp(db: Db, p: OpenParams): PositionRow {
  if (!(p.price > 0)) throw new Error('No valid price for this token.');
  if (!(p.collateral >= 1)) throw new Error('Collateral must be at least $1.');
  if (!(p.leverage >= 1 && p.leverage <= p.maxLeverage)) throw new Error(`Leverage must be between 1 and ${p.maxLeverage}.`);
  const size = p.collateral * p.leverage;
  const cost = p.collateral + fee(size);
  return db.tx(() => {
    const u = db.user(p.tgId);
    if (u.paper_usd < cost) throw new Error(`Not enough paper balance: need $${cost.toFixed(2)}, have $${u.paper_usd.toFixed(2)}.`);
    db.addPaper(p.tgId, -cost);
    const id = db.openPosition({
      tg_id: p.tgId,
      kind: 'perp',
      side: p.side,
      symbol: p.symbol,
      market_id: p.marketId,
      entry: p.price,
      size_usd: size,
      collateral: p.collateral,
      leverage: p.leverage,
      liq: liquidationPrice(p.side, p.price, p.leverage),
    });
    return db.position(id, p.tgId)!;
  });
}

export interface CloseResult {
  pnl: number;
  returned: number;
  liquidated: boolean;
}

/** Close at `price`. Losses are capped at the collateral. Returns null if it was already closed. */
export function closePosition(db: Db, pos: PositionRow, price: number): CloseResult | null {
  return db.tx(() => {
    const liquidated = pos.kind === 'perp' && pos.liq !== null && isLiquidated(pos.side, pos.liq, price);
    let pnl = pnlUsd(pos.side, pos.entry, price, pos.size_usd);
    if (pos.kind === 'spot') {
      // Spot holdings live on-chain; this row only tracks performance.
      return db.closePosition(pos.id, 'closed', price, pnl) ? { pnl, returned: 0, liquidated: false } : null;
    }
    let returned: number;
    if (liquidated) {
      pnl = -pos.collateral;
      returned = 0;
    } else {
      pnl = Math.max(pnl, -pos.collateral);
      returned = Math.max(0, pos.collateral + pnl - fee(pos.size_usd));
    }
    if (!db.closePosition(pos.id, liquidated ? 'liquidated' : 'closed', price, pnl)) return null;
    if (returned > 0) db.addPaper(pos.tg_id, returned);
    return { pnl, returned, liquidated };
  });
}
