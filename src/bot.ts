import { Bot, type Context, InlineKeyboard } from 'grammy';
import type { Agent } from './agent.js';
import { checkData } from './agent.js';
import { analyzeToken } from './analysis.js';
import { config } from './config.js';
import type { Db } from './db.js';
import { deepAnalysis, DISCLAIMER, esc, positionLine, positionReport, price, signed, tokenInfo } from './format.js';
import { buildHistory } from './history.js';
import { technicals } from './indicators.js';
import { findToken, noMarketReason, TOKEN_NOT_FOUND } from './lookup.js';
import { getMarket, getMarketAndCandles, MarketError } from './market.js';
import { evaluate, liveTechnicals } from './monitor.js';
import { createWalletFor, exportKey, ftBalance, ftMetadata, fundNewWallet, nearBalance } from './near.js';
import { closePosition, openPerp } from './paper.js';
import type { Side } from './perps.js';
import { newsData, newsFor } from './news.js';
import { execute, prepareBuy, prepareSell, prepareSwap, register, take, UserError } from './proposals.js';
import { reportHoursFor, sendReport } from './reports.js';
import { isAccountId, knownSymbols, resolveToken } from './tokens.js';
import { fromUnits } from './units.js';

const HELP = (ai: boolean) => `<b>NEAR trading bot</b> (${esc(config.network)})
${ai ? '\n💬 <b>Just talk to me in any language.</b> Ask about a token, your trades, or say what you want to do, e.g. "buy 2 NEAR of REF" or "should I close my short?". I always ask before any trade.\n' : ''}
<b>Wallet</b>
/wallet - create or view your bot wallet and balances
/export - show your private key (private chat only)
/connect &lt;account&gt; - watch a wallet you own (read-only)

<b>Research</b>
/token &lt;symbol or contract&gt; - price, liquidity, volume
/analyze &lt;symbol or contract&gt; - deep analysis with risk flags

<b>Spot</b>
/buy &lt;token&gt; &lt;NEAR to spend&gt;
/sell &lt;token&gt; &lt;amount or 50%&gt;
/swap &lt;amount or 50%&gt; &lt;from&gt; &lt;to&gt; - token for token, one transaction

<b>Long / short</b> (paper money for now)
/long &lt;token&gt; &lt;collateral $&gt; &lt;leverage&gt;
/short &lt;token&gt; &lt;collateral $&gt; &lt;leverage&gt;
/positions - open trades with live PnL
/check [id] - live analysis: hold or close?
/close &lt;id&gt;
/history - closed trades, wins/losses and total PnL

<b>Reports</b>
/report now - trend, odds and news for your open trades
/report &lt;hours&gt; - get one automatically every N hours (/report off to stop)

Known symbols: ${knownSymbols().join(', ')}`;

const confirmKb = (id: string) => new InlineKeyboard().text('✅ Confirm', `ok:${id}`).text('Cancel', `no:${id}`);

export function createBot(db: Db, agent: Agent | null = null): Bot {
  const bot = new Bot(config.botToken);
  const lastSeen = new Map<number, number>();
  const reply = (ctx: Context, html: string, extra: object = {}) =>
    ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const replyPlain = async (ctx: Context, text: string) => {
    for (let i = 0; i < text.length; i += 4000) await ctx.reply(text.slice(i, i + 4000), { link_preview_options: { is_disabled: true } });
  };
  const typing = (ctx: Context) => ctx.replyWithChatAction('typing').catch(() => undefined);

  // Access control, flood guard, first-seen language
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    if (config.allowedUserIds.length && !config.allowedUserIds.includes(id)) {
      if (ctx.message) await ctx.reply('This bot is invite-only.');
      return;
    }
    const now = Date.now();
    if (ctx.message && now - (lastSeen.get(id) ?? 0) < config.floodMs) return;
    lastSeen.set(id, now);
    const u = db.user(id);
    if (!u.lang && ctx.from?.language_code) db.setLang(id, ctx.from.language_code);
    await next();
  });

  const privateOnly = async (ctx: Context): Promise<boolean> => {
    if (ctx.chat?.type === 'private') return true;
    await ctx.reply('For your safety this command only works in a private chat with me.');
    return false;
  };

  const args = (ctx: Context): string[] => (typeof ctx.match === 'string' ? ctx.match.trim().split(/\s+/).filter(Boolean) : []);

  /** Optional AI paragraph under a command's fixed output. Never blocks or breaks the command. */
  async function aiNote(ctx: Context, kind: 'analysis' | 'check', data: unknown): Promise<void> {
    if (!agent) return;
    try {
      await typing(ctx);
      const note = await agent.commentary(ctx.from!.id, kind, data);
      if (note) await replyPlain(ctx, '🤖 ' + note);
    } catch (e) {
      console.error('[ai]', (e as Error).message);
    }
  }

  bot.command(['start', 'help'], (ctx) => reply(ctx, HELP(!!agent)));

  // ---------- Wallet ----------
  bot.command('wallet', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    await guard(ctx, async () => {
      const tgId = ctx.from!.id;
      const had = db.user(tgId).account_id;
      const accountId = createWalletFor(db, tgId);
      const lines: string[] = [];
      if (!had) {
        lines.push('✅ <b>Wallet created</b>');
        const funded = await fundNewWallet(accountId).catch((e) => (console.error('[funder]', e.message), false));
        if (funded) lines.push(`Sent you ${esc(config.funderAmountNear)} test NEAR to get started.`);
      }
      lines.push(`Address:\n<code>${accountId}</code>`);
      const bal = await nearBalance(accountId);
      if (bal === null) {
        lines.push(
          '',
          'Balance: 0 NEAR (not active yet)',
          config.network === 'testnet'
            ? 'Send test NEAR to the address above to activate it. Free faucet: https://near-faucet.io'
            : 'Send NEAR to the address above to activate it.',
        );
      } else {
        lines.push('', `NEAR: <b>${fromUnits(bal, 24, 4)}</b>`);
        for (const sym of knownSymbols()) {
          const t = resolveToken(sym);
          if (!t?.tradeId || sym === 'NEAR') continue;
          try {
            const b = await ftBalance(t.tradeId, accountId);
            if (b > 0n) lines.push(`${sym}: ${fromUnits(b, (await ftMetadata(t.tradeId)).decimals, 4)}`);
          } catch {
            /* token contract missing on this network */
          }
        }
      }
      const u = db.user(tgId);
      lines.push('', `Paper balance (long/short): $${u.paper_usd.toFixed(2)}`);
      if (u.watch_account) {
        const wb = await nearBalance(u.watch_account).catch(() => null);
        lines.push(`Watching <code>${esc(u.watch_account)}</code>: ${wb === null ? 'not found' : fromUnits(wb, 24, 4) + ' NEAR'}`);
      }
      lines.push('', 'The bot holds the key to this wallet. Use /export to back it up, and only keep here what you are willing to trade.');
      await reply(ctx, lines.join('\n'));
    });
  });

  bot.command('export', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    try {
      const key = exportKey(db.user(ctx.from!.id));
      const m = await reply(
        ctx,
        `🔑 <b>Private key</b> (this message deletes itself in 60 seconds)\n\n<tg-spoiler>${esc(key)}</tg-spoiler>\n\nAnyone with this key controls the wallet. Never share it. Import it into a NEAR wallet app to use the account outside the bot.`,
      );
      setTimeout(() => void ctx.api.deleteMessage(m.chat.id, m.message_id).catch(() => undefined), 60_000).unref();
    } catch (e) {
      await reply(ctx, esc((e as Error).message));
    }
  });

  bot.command('connect', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    const [acct] = args(ctx);
    if (!acct) return reply(ctx, 'Usage: /connect yourname.' + (config.network === 'testnet' ? 'testnet' : 'near') + '\nUse /connect off to stop watching.');
    if (acct === 'off') {
      db.setWatch(ctx.from!.id, null);
      return reply(ctx, 'Stopped watching.');
    }
    const id = acct.toLowerCase();
    if (!isAccountId(id)) return reply(ctx, 'That does not look like a NEAR account name.');
    return guard(ctx, async () => {
      const bal = await nearBalance(id);
      if (bal === null) return reply(ctx, `Account <code>${esc(id)}</code> was not found on ${config.network}.`);
      db.setWatch(ctx.from!.id, id);
      return reply(
        ctx,
        `👀 Watching <code>${esc(id)}</code> (${fromUnits(bal, 24, 4)} NEAR).\n\nThis is read-only: the bot never asks for this wallet's key and cannot trade from it. Analysis and paper long/short work as normal; on-chain buy/sell uses your bot wallet (/wallet).`,
      );
    });
  });

  // ---------- Research ----------
  bot.command('token', async (ctx) => {
    const [q] = args(ctx);
    if (!q) return reply(ctx, 'Usage: /token NEAR   (or a contract address or link)');
    await guard(ctx, async () => {
      const t = await findToken(q);
      if (!t) return reply(ctx, esc(TOKEN_NOT_FOUND));
      if (!t.marketId) return reply(ctx, esc(noMarketReason(t)!));
      return reply(ctx, tokenInfo(await getMarket(t.marketId)));
    });
  });

  bot.command('analyze', async (ctx) => {
    const [q] = args(ctx);
    if (!q) return reply(ctx, 'Usage: /analyze NEAR   (or a contract address or link)');
    await guard(ctx, async () => {
      const t = await findToken(q);
      if (!t) return reply(ctx, esc(TOKEN_NOT_FOUND));
      if (!t.marketId) return reply(ctx, esc(noMarketReason(t)!));
      const { market, candles } = await getMarketAndCandles(t.marketId);
      const tech = candles.length ? technicals(candles, market.priceUsd) : null;
      const report = analyzeToken(market, tech);
      await reply(ctx, deepAnalysis(market, report, tech));
      const news = await newsFor(market.symbol, market.name, 5).catch(() => []);
      await aiNote(ctx, 'analysis', { market, report, technicals: tech, recent_headlines: newsData(news) });
    });
  });

  // ---------- Spot (always confirmed) ----------
  bot.command('buy', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    const [sym, amt] = args(ctx);
    if (!sym || !amt) return reply(ctx, 'Usage: /buy REF 1   (spend 1 NEAR on REF)');
    await guard(ctx, async () => {
      const { p, summary } = await prepareBuy(db, ctx.from!.id, await findToken(sym), amt);
      return reply(ctx, summary, { reply_markup: confirmKb(register(ctx.from!.id, p)) });
    });
  });

  bot.command('sell', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    const [sym, amt] = args(ctx);
    if (!sym || !amt) return reply(ctx, 'Usage: /sell REF 50%   or   /sell REF 12.5');
    await guard(ctx, async () => {
      const { p, summary } = await prepareSell(db, ctx.from!.id, await findToken(sym), amt);
      return reply(ctx, summary, { reply_markup: confirmKb(register(ctx.from!.id, p)) });
    });
  });

  bot.command('swap', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    // Accept "/swap 10 REF USDC", "/swap 10 REF to USDC" and "/swap REF USDC 10"
    const a = args(ctx).filter((x) => !/^(to|for|->|→)$/i.test(x));
    const isAmount = (x: string) => /^[\d.,]+%?$/.test(x);
    let amt: string | undefined, from: string | undefined, to: string | undefined;
    if (a.length === 3 && isAmount(a[0]!)) [amt, from, to] = a;
    else if (a.length === 3 && isAmount(a[2]!)) [from, to, amt] = a;
    if (!amt || !from || !to) return reply(ctx, 'Usage: /swap 10 REF USDC   or   /swap 50% REF USDC\nSwaps one token for another in one transaction on Ref Finance.');
    await guard(ctx, async () => {
      const [f, t] = await Promise.all([findToken(from!), findToken(to!)]);
      const { p, summary } = await prepareSwap(db, ctx.from!.id, f, t, amt!);
      return reply(ctx, summary, { reply_markup: confirmKb(register(ctx.from!.id, p)) });
    });
  });

  bot.callbackQuery(/^(ok|no):([0-9a-f]+)$/, async (ctx) => {
    const [, verb, id] = ctx.match as RegExpMatchArray;
    await ctx.answerCallbackQuery();
    const got = take(id!, ctx.from.id);
    if (!got.ok) return void (await ctx.editMessageText(got.why).catch(() => undefined));
    if (verb === 'no') return void (await ctx.editMessageText('Cancelled.').catch(() => undefined));
    await ctx.editMessageText('⏳ Working on it...').catch(() => undefined);
    try {
      const msg = await execute(db, ctx.from.id, got.p);
      await ctx.editMessageText(msg, { link_preview_options: { is_disabled: true } });
    } catch (e) {
      console.error('[trade]', e);
      await ctx.editMessageText(`❌ Failed: ${(e as Error).message}`).catch(() => undefined);
    }
  });

  // ---------- Long / short (typed command = explicit instruction) ----------
  const openCmd = (side: Side) => async (ctx: Context) => {
    const [sym, coll, lev] = args(ctx);
    if (!sym || !coll) return reply(ctx, `Usage: /${side} NEAR 100 3   ($100 collateral at 3x)`);
    await guard(ctx, async () => {
      const token = await findToken(sym);
      if (!token) return reply(ctx, esc(TOKEN_NOT_FOUND));
      if (!token.marketId) return reply(ctx, esc(noMarketReason(token)! + ' Long/short needs a market price.'));
      const market = await getMarket(token.marketId);
      if ((market.liquidityUsd ?? 0) < 25_000) return reply(ctx, `Liquidity is too thin ($${(market.liquidityUsd ?? 0).toFixed(0)}) for a meaningful ${side}. Minimum is $25K.`);
      const pos = openPerp(db, {
        tgId: ctx.from!.id,
        side,
        symbol: market.symbol.toUpperCase(),
        marketId: token.marketId,
        price: market.priceUsd,
        collateral: Number(coll.replace(/[$,]/g, '')),
        leverage: lev ? Number(lev.replace(/x$/i, '')) : 1,
        maxLeverage: config.maxLeverage,
      });
      return reply(
        ctx,
        `✅ <b>Opened ${positionLine(pos)}</b> (paper)\nEntry: $${price(pos.entry)}\nSize: $${pos.size_usd.toFixed(2)} on $${pos.collateral.toFixed(2)} collateral\nLiquidation: $${price(pos.liq!)}\n\nI'll watch it and message you if the read changes. /check ${pos.id} any time.`,
      );
    });
  };
  bot.command('long', openCmd('long'));
  bot.command('short', openCmd('short'));

  bot.command('positions', async (ctx) => {
    await guard(ctx, async () => {
      const list = db.openPositions(ctx.from!.id);
      if (!list.length) return reply(ctx, 'No open trades. Try /long NEAR 100 3');
      const lines: string[] = ['<b>Open trades</b>'];
      const prices = new Map<string, number>();
      for (const p of list) {
        if (!prices.has(p.market_id)) prices.set(p.market_id, (await getMarket(p.market_id)).priceUsd);
        const px = prices.get(p.market_id)!;
        const a = evaluate(p, { price: px, ema20: null, ema50: null, rsi14: null, macd: null, atr14: null, atrPct: null, trendScore: 0, candles: 999 });
        lines.push(`${positionLine(p)}: $${price(p.entry)} → $${price(px)}  <b>${signed(a.pnlUsd)}</b> (${a.pnlPct >= 0 ? '+' : ''}${a.pnlPct.toFixed(1)}%)`);
      }
      lines.push('', `Paper balance: $${db.user(ctx.from!.id).paper_usd.toFixed(2)}`, '/check for hold-or-close analysis');
      return reply(ctx, lines.join('\n'));
    });
  });

  bot.command('check', async (ctx) => {
    await guard(ctx, async () => {
      const tgId = ctx.from!.id;
      const [idArg] = args(ctx);
      const list = idArg ? [db.position(Number(idArg), tgId)].filter((p) => p?.status === 'open') : db.openPositions(tgId).slice(0, 5);
      if (!list.length) return reply(ctx, idArg ? 'No open trade with that id.' : 'No open trades.');
      const parts: string[] = [];
      for (const p of list) {
        const t = await liveTechnicals(p!.market_id);
        const a = evaluate(p!, t);
        db.setVerdict(p!.id, a.verdict);
        parts.push(positionReport(p!, a, t));
      }
      await reply(ctx, parts.join('\n\n———\n\n') + '\n\n' + DISCLAIMER);
      if (agent) {
        const data = [];
        for (const p of list) data.push(await checkData(db, tgId, p!.id).catch(() => null));
        await aiNote(ctx, 'check', data.filter(Boolean));
      }
    });
  });

  bot.command('history', async (ctx) => {
    const [n] = args(ctx);
    if (n && !/^\d{1,2}$/.test(n)) return reply(ctx, 'Usage: /history  or  /history 20  (up to 30 trades)');
    await guard(ctx, async () => {
      const h = await buildHistory(db, ctx.from!.id, n ? Number(n) : 10);
      await reply(ctx, h.html);
    });
  });

  bot.command('report', async (ctx) => {
    const tgId = ctx.from!.id;
    const [arg] = args(ctx);
    const a = (arg ?? '').toLowerCase();
    if (a === 'off') {
      db.setReportHours(tgId, 0);
      return reply(ctx, 'Scheduled trade reports are off. /report now still works any time; /report 4 turns them back on.');
    }
    if (a && a !== 'now') {
      const h = Number(a.replace(/h$/, ''));
      if (!(h >= 1 && h <= 24)) return reply(ctx, 'Usage: /report now, /report 4 (every 4 hours, 1 to 24), or /report off');
      db.setReportHours(tgId, h);
      return reply(ctx, `✅ You'll get a trade report every ${h} hour${h === 1 ? '' : 's'} while you have open trades. Send /report now for one straight away.`);
    }
    if (!a) {
      const h = reportHoursFor(db, tgId);
      const status = h > 0 ? `Scheduled reports: every ${h} hour${h === 1 ? '' : 's'} while you have open trades.` : 'Scheduled reports: off.';
      if (!db.openPositions(tgId).length) return reply(ctx, `${status}
You have no open trades right now.

/report 4 sets the interval, /report off stops them.`);
    }
    await guard(ctx, async () => {
      await typing(ctx);
      const sent = await sendReport(db, tgId, agent, async (_id, text, plain) => {
        if (plain) await replyPlain(ctx, text);
        else await reply(ctx, text);
      });
      if (!sent) return reply(ctx, 'You have no open trades to report on. Try /long NEAR 100 3');
      if (!a) await reply(ctx, '/report 4 changes how often these arrive; /report off stops them.');
    });
  });

  bot.command('close', async (ctx) => {
    await guard(ctx, async () => {
      const tgId = ctx.from!.id;
      const [idArg] = args(ctx);
      const p = idArg ? db.position(Number(idArg), tgId) : undefined;
      if (!p || p.status !== 'open') return reply(ctx, 'Usage: /close <id>  (see /positions)');
      const px = (await getMarket(p.market_id)).priceUsd;
      const r = closePosition(db, p, px);
      if (!r) return reply(ctx, 'That trade is already closed.');
      if (p.kind === 'spot')
        return reply(ctx, `Stopped tracking ${positionLine(p)} at $${price(px)} (${signed(r.pnl)}). Your tokens are still in your wallet; use /sell to sell them.`);
      return reply(
        ctx,
        r.liquidated
          ? `💥 ${positionLine(p)} was already past liquidation at $${price(px)}. Loss: ${signed(r.pnl)}.`
          : `✅ Closed ${positionLine(p)} at $${price(px)}. PnL: <b>${signed(r.pnl)}</b>. Returned $${r.returned.toFixed(2)} to your paper balance.`,
      );
    });
  });

  // ---------- AI chat: any other text, any language ----------
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return reply(ctx, 'Unknown command. /help lists them all.');
    if (ctx.chat.type !== 'private') return; // wallet and trade data stay out of group chats
    if (!agent) return reply(ctx, 'Use /help to see what I can do.');
    if (text.length > 2000) return reply(ctx, 'That message is too long; please shorten it.');
    await typing(ctx);
    const keepTyping = setInterval(() => void typing(ctx), 4500);
    try {
      const r = await agent.chat(ctx.from.id, text);
      if (r.text) await replyPlain(ctx, r.text);
      for (const p of r.proposals) await reply(ctx, p.summary, { reply_markup: confirmKb(p.id) });
    } catch (e) {
      console.error('[ai]', e);
      await reply(ctx, 'The AI assistant is unavailable right now. Commands still work: /help');
    } finally {
      clearInterval(keepTyping);
    }
  });

  async function guard(ctx: Context, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof MarketError) && !(e instanceof UserError)) console.error('[cmd]', e);
      const msg = (e as Error)?.message ?? String(e);
      await reply(ctx, '❌ ' + esc(msg.length > 300 ? msg.slice(0, 300) + '...' : msg)).catch(() => undefined);
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of lastSeen) if (now - v > 3_600_000) lastSeen.delete(k);
  }, 60_000).unref();

  bot.catch((err) => console.error('[bot]', err.error));
  return bot;
}
