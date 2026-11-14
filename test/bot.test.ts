import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.BOT_TOKEN = '123:TEST';
process.env.MASTER_KEY = 'c'.repeat(64);
process.env.NEAR_RPC_URL = 'https://rpc.invalid';
process.env.FLOOD_MS = '0';
const { createBot } = await import('../src/bot.js');
const { Db } = await import('../src/db.js');
const { monitorOnce } = await import('../src/monitor.js');

// --- Fake market + RPC ---
let nearPrice = 2;
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});
function candles(last: number) {
  const list: number[][] = [];
  for (let i = 0; i < 120; i++) {
    const c = last * (1 - (119 - i) * 0.002);
    list.push([i * 3600, c * 0.999, c * 1.004, c * 0.996, c, 100]);
  }
  return list.reverse();
}
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('rpc.invalid')) {
    const req = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          name: 'HANDLER_ERROR',
          cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: 'x', block_height: 1, block_hash: 'h' } },
          code: -32000,
          message: 'Server error',
          data: 'account x does not exist while viewing',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (u.includes('/ohlcv/')) return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: candles(nearPrice) } } }));
  if (u.includes('/tokens/wrap.near'))
    return new Response(
      JSON.stringify({
        data: { attributes: { name: 'Wrapped NEAR', symbol: 'wNEAR', price_usd: String(nearPrice), fdv_usd: '2000000000', volume_usd: { h24: '9000000' } } },
        included: [{ id: 'near_p1', attributes: { address: 'p1', name: 'wNEAR / USDT', pool_created_at: '2022-01-01T00:00:00Z', reserve_in_usd: '8000000', price_change_percentage: { h1: '0.4', h6: '1', h24: '3' }, transactions: { h24: { buys: 500, sells: 450 } } } }],
      }),
    );
  return new Response('{}', { status: 404 });
}) as typeof fetch;

// --- Fake Telegram ---
const db = new Db(':memory:', 10_000);
const bot = createBot(db);
bot.botInfo = { id: 1, is_bot: true, first_name: 'T', username: 'tbot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any;
const sent: string[] = [];
bot.api.config.use(async (_prev, method, payload: any) => {
  if (method === 'sendMessage') sent.push(payload.text);
  return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: payload.chat_id ?? 0, type: 'private' }, text: payload.text ?? '' } } as any;
});
let uid = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function say(text: string, from = 77, chatType: 'private' | 'group' = 'private'): Promise<string> {
  const before = sent.length;
  const cmd = text.split(' ')[0]!;
  await bot.handleUpdate({
    update_id: ++uid,
    message: {
      message_id: uid, date: 0, text,
      chat: chatType === 'private' ? { id: from, type: 'private', first_name: 'U' } : { id: -5, type: 'group', title: 'G' },
      from: { id: from, is_bot: false, first_name: 'U' },
      entities: [{ type: 'bot_command', offset: 0, length: cmd.length }],
    },
  } as any);
  return sent.slice(before).join('\n');
}

test('bot: help, wallet creation, privacy', async () => {
  assert.match(await say('/start'), /NEAR trading bot/);
  const w = await say('/wallet');
  assert.match(w, /Wallet created/);
  assert.match(w, /<code>[0-9a-f]{64}<\/code>/);
  assert.match(w, /not active yet/);
  const addr = /<code>([0-9a-f]{64})<\/code>/.exec(w)![1];
  assert.match(await say('/wallet'), new RegExp(addr!), 'same wallet on second call');
  assert.doesNotMatch(await say('/wallet'), /Wallet created/);
  assert.match(await say('/wallet', 77, 'group'), /private chat/);
  assert.match(await say('/export', 77, 'group'), /private chat/);
  const key = await say('/export');
  assert.match(key, /ed25519:/);
  assert.match(await say('/export', 78), /No bot wallet yet/);
  assert.doesNotMatch(db.user(77).enc_key!, /ed25519/, 'key is not stored in plain text');
});

test('bot: research commands', async () => {
  const t = await say('/token near');
  assert.match(t, /Wrapped NEAR/);
  assert.match(t, /\$2\.0000/);
  const a = await say('/analyze NEAR');
  assert.match(a, /Safety score: <b>85\/100<\/b>/);
  assert.match(a, /only 0.40% of fully diluted value/);
  assert.match(a, /Market bias/);
  assert.match(await say('/token'), /Usage/);
  assert.match(await say('/token <b>'), /not found/i);
});

test('bot: long -> check -> monitor alert -> close; liquidation', async () => {
  const o = await say('/long NEAR 100 5');
  assert.match(o, /Opened #1 WNEAR LONG 5x/);
  assert.match(o, /Liquidation: \$1\.6100/);
  assert.match(await say('/long NEAR 100 50'), /Leverage must be/);
  assert.match(await say('/long NEAR abc 2'), /Collateral/);
  assert.match(await say('/close 1', 78), /Usage/, 'cannot close another user\'s trade');

  nearPrice = 2.1;
  await sleep(0);
  const { config } = await import('../src/config.js');
  (await import('../src/market.js')); // cache is keyed by URL; bust it by changing network label
  config.geckoNetwork = 'near2';
  const p = await say('/positions');
  assert.match(p, /\+\$25\.00/);
  const c = await say('/check');
  assert.match(c, /Verdict: <b>/);
  assert.match(c, /PnL: <b>\+\$25\.00<\/b> \(\+25\.00%\)/);

  // Price collapses towards liquidation: monitor must alert once
  nearPrice = 1.63;
  config.geckoNetwork = 'near3';
  const alerts: string[] = [];
  await monitorOnce(db, async (_id, html) => void alerts.push(html));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /REDUCE/);
  assert.match(alerts[0]!, /1.23% away/);
  await monitorOnce(db, async (_id, html) => void alerts.push(html));
  assert.equal(alerts.length, 1, 'no repeat alert while the verdict is unchanged');

  // Past liquidation: monitor liquidates and tells the user
  nearPrice = 1.5;
  config.geckoNetwork = 'near4';
  await monitorOnce(db, async (_id, html) => void alerts.push(html));
  assert.match(alerts[1]!, /liquidated/);
  assert.equal(db.openPositions(77).length, 0);
  assert.ok(Math.abs(db.user(77).paper_usd - (10_000 - 100 - 0.25)) < 1e-9);

  // Short that wins, closed by hand
  await say('/short NEAR 200 2');
  nearPrice = 1.35;
  config.geckoNetwork = 'near5';
  const cl = await say('/close 2');
  assert.match(cl, /PnL: <b>\+\$40\.00<\/b>/);
  assert.match(await say('/close 2'), /Usage/);
  assert.match(await say('/positions'), /No open trades/);

  // Collateral typed with $ and commas, as the usage hint shows it
  assert.match(await say('/long NEAR $1,000 2x', 78), /Opened #3 WNEAR LONG 2x[\s\S]*\$1000\.00 collateral/);
  assert.match(await say('/close 3', 78), /#3/);

  // History: one liquidated long (-$100), one winning short (+$40)
  const h = await say('/history');
  assert.match(h, /Long\/short \(paper\)<\/b>: 2 closed \| 1 won, 1 lost \(50% wins\), 1 liquidated/);
  assert.match(h, /Total PnL: <b>-\$60\.00<\/b>/);
  assert.match(h, /Best \+\$40\.00 \| Worst -\$100\.00/);
  assert.match(h, /🟢 #2 WNEAR SHORT 2x: \$1\.5000 → \$1\.3500 {2}<b>\+\$40\.00<\/b> \+20\.0%/);
  assert.match(h, /💥 #1 WNEAR LONG 5x[\s\S]*liquidated/);
  assert.ok(h.indexOf('#2 WNEAR') < h.indexOf('#1 WNEAR'), 'most recent first');
  assert.doesNotMatch(h, /#3/, "another user's trade is not shown");
  assert.match(await say('/history 1'), /Showing 1 of 2\. \/history 2 shows more/);
  assert.match(await say('/history abc'), /Usage/);
  assert.match(await say('/history', 4242), /No closed trades or swaps yet/);
});

test('bot: free text without an AI key points to /help; unknown commands handled', async () => {
  assert.match(await say('hello, how far?'), /\/help/);
  assert.match(await say('/nonsense'), /Unknown command/);
});
