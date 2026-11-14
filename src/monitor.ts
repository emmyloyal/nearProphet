import type { Bot } from 'grammy';
import { type Agent, checkData } from './agent.js';
import { advise, type Advice } from './advisor.js';
import type { Db, PositionRow } from './db.js';
import { DISCLAIMER, esc, positionLine, positionReport, price, signed } from './format.js';
import { technicals, type Technicals } from './indicators.js';
import { getMarketAndCandles } from './market.js';
import { closePosition } from './paper.js';
import { isLiquidated } from './perps.js';

export function evaluate(p: PositionRow, t: Technicals): Advice {
  return advise(
    { kind: p.kind, side: p.side, entry: p.entry, sizeUsd: p.size_usd, collateral: p.collateral, leverage: p.leverage, liq: p.liq },
    t,
  );
}

export async function liveTechnicals(marketId: string): Promise<Technicals> {
  const { market, candles } = await getMarketAndCandles(marketId);
  return technicals(candles, market.priceUsd);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One pass over every open position: liquidate what is past its liquidation price, and message users whose verdict changed. */
export async function monitorOnce(db: Db, notify: (tgId: number, html: string) => Promise<void>, agent: Agent | null = null): Promise<void> {
  const byMarket = new Map<string, PositionRow[]>();
  for (const p of db.openPositions()) {
    const list = byMarket.get(p.market_id) ?? [];
    list.push(p);
    byMarket.set(p.market_id, list);
  }
  for (const [marketId, positions] of byMarket) {
    let t: Technicals;
    try {
      t = await liveTechnicals(marketId);
    } catch (e) {
      console.error(`[monitor] ${marketId}: ${(e as Error).message}`);
      await sleep(2500);
      continue;
    }
    for (const p of positions) {
      try {
        if (p.kind === 'perp' && p.liq !== null && isLiquidated(p.side, p.liq, t.price)) {
          const r = closePosition(db, p, t.price);
          if (r) await notify(p.tg_id, `💥 <b>${positionLine(p)} was liquidated</b> at $${price(t.price)}. Loss: ${signed(r.pnl)}.`);
          continue;
        }
        const a = evaluate(p, t);
        const changed = a.verdict !== p.last_verdict;
        const worthSending = changed && (a.verdict !== 'HOLD' || p.last_verdict !== null);
        db.setVerdict(p.id, a.verdict);
        if (worthSending) {
          let ai = '';
          if (agent) {
            const note = await checkData(db, p.tg_id, p.id)
              .then((d) => agent.commentary(p.tg_id, 'alert', d))
              .catch((e) => (console.error('[ai alert]', (e as Error).message), null));
            if (note) ai = `\n\n🤖 ${esc(note)}`;
          }
          await notify(p.tg_id, `🔔 <b>Trade update</b>\n\n${positionReport(p, a, t)}${ai}\n\n${DISCLAIMER}`);
        }
      } catch (e) {
        console.error(`[monitor] position ${p.id}: ${(e as Error).message}`);
      }
    }
    await sleep(2500); // stay under the market data rate limit
  }
}

export function startMonitor(db: Db, bot: Bot, intervalSec: number, agent: Agent | null = null): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await monitorOnce(db, async (tgId, html) => {
        await bot.api.sendMessage(tgId, html, { parse_mode: 'HTML' }).catch((e) => console.error(`[monitor] notify ${tgId}: ${e.message}`));
      }, agent);
    } finally {
      running = false;
    }
  };
  const h = setInterval(tick, intervalSec * 1000);
  return () => clearInterval(h);
}
