import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';

process.env.MASTER_KEY = 'd'.repeat(64);
process.env.AI_DAILY_LIMIT = '5';
process.env.AI_PROVIDER = 'anthropic'; // these tests cover the Anthropic path, whatever .env says
const { Agent, stripLang } = await import('../src/agent.js');
const { Db } = await import('../src/db.js');
const { take, execute } = await import('../src/proposals.js');
const { config } = await import('../src/config.js');

const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/ohlcv/')) {
    const list = Array.from({ length: 120 }, (_, i) => { const c = 2 * (1 - i * 0.001); return [ (120 - i) * 3600, c, c * 1.003, c * 0.997, c, 10 ]; });
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }));
  }
  if (u.includes('/tokens/wrap.near'))
    return new Response(JSON.stringify({
      data: { attributes: { name: 'Wrapped NEAR', symbol: 'wNEAR', price_usd: '2', fdv_usd: '2000000000', volume_usd: { h24: '9000000' } } },
      included: [{ id: 'near_p1', attributes: { address: 'p1', name: 'wNEAR / USDT', pool_created_at: '2022-01-01T00:00:00Z', reserve_in_usd: '8000000' } }],
    }));
  return new Response('{}', { status: 404 });
}) as typeof fetch;

type Step = (req: Anthropic.MessageCreateParamsNonStreaming) => Partial<Anthropic.Message>;
function fakeClient(steps: Step[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(req: Anthropic.MessageCreateParamsNonStreaming) {
        calls.push(structuredClone(req));
        const step = steps.shift();
        if (!step) throw new Error('unexpected extra call');
        return { id: 'm', type: 'message', role: 'assistant', model: req.model, usage: {} as any, stop_sequence: null, ...step(req) } as Anthropic.Message;
      },
    },
  };
}
const text = (t: string) => () => ({ stop_reason: 'end_turn' as const, content: [{ type: 'text', text: t, citations: null }] as any });
const toolUse = (name: string, input: object) => () => ({ stop_reason: 'tool_use' as const, content: [{ type: 'tool_use', id: 'tu_' + name, name, input }] as any });

test('stripLang', () => {
  assert.deepEqual(stripLang('Bonjour <lang>French</lang>'), { clean: 'Bonjour', lang: 'French' });
  assert.deepEqual(stripLang('Hello'), { clean: 'Hello', lang: null });
});

test('chat: French request becomes a proposal, not a trade; language is remembered', async () => {
  const db = new Db(':memory:', 10_000);
  const fc = fakeClient([
    toolUse('propose_open_position', { side: 'long', token: 'NEAR', collateral_usd: 100, leverage: 3 }),
    (req) => {
      const last = req.messages[req.messages.length - 1]!;
      const tr = (last.content as any[])[0];
      assert.equal(tr.type, 'tool_result');
      assert.equal(tr.is_error, false);
      assert.match(tr.content, /not executed until they tap/);
      return text("J'ai préparé un long NEAR 3x. Appuyez sur Confirmer. <lang>French</lang>")();
    },
  ]);
  const agent = new Agent(db, fc);
  const r = await agent.chat(7, 'ouvre un long sur NEAR avec 100$ en levier 3');
  assert.equal(r.text, "J'ai préparé un long NEAR 3x. Appuyez sur Confirmer.");
  assert.equal(r.proposals.length, 1);
  assert.match(r.proposals[0]!.summary, /Confirm LONG WNEAR 3x/);
  assert.equal(db.openPositions(7).length, 0, 'nothing executed by the AI');
  assert.equal(db.user(7).lang, 'French');

  // Tools, web search and system prompt were sent
  const req = fc.calls[0]!;
  assert.equal(req.model, config.aiModel);
  assert.ok((req.tools as any[]).some((t) => t.type === 'web_search_20250305'));
  assert.match(JSON.stringify(req.system), /same language as the user's latest message/);

  // Another user cannot use this proposal; the owner can
  assert.equal(take(r.proposals[0]!.id, 8).ok, false);
});

test('chat: user confirms -> position opens', async () => {
  const db = new Db(':memory:', 10_000);
  const agent = new Agent(db, fakeClient([toolUse('propose_open_position', { side: 'short', token: 'near', collateral_usd: 50, leverage: 2 }), text('ok <lang>English</lang>')]));
  const r = await agent.chat(9, 'short near 50 2x');
  const got = take(r.proposals[0]!.id, 9);
  assert.ok(got.ok);
  const msg = await execute(db, 9, (got as any).p);
  assert.match(msg, /Opened #\d+ WNEAR SHORT 2x/);
  assert.equal(db.openPositions(9).length, 1);
  assert.equal(take(r.proposals[0]!.id, 9).ok, false, 'single use');
});

test('chat: tool errors go back to the model; history kept; daily limit', async () => {
  const db = new Db(':memory:', 10_000);
  const fc = fakeClient([
    toolUse('check_position', { position_id: 999 }),
    (req) => {
      const tr = ((req.messages.at(-1)!.content) as any[])[0];
      assert.equal(tr.is_error, true);
      assert.match(tr.content, /No open trade/);
      return text('Ce trade n\'existe pas. <lang>French</lang>')();
    },
    (req) => {
      assert.equal(req.messages.length, 3, 'previous turn is in history');
      return text('ok')();
    },
    text('a'), text('b'), text('c'),
  ]);
  const agent = new Agent(db, fc);
  assert.match((await agent.chat(3, 'vérifie le trade 999')).text, /n'existe pas/);
  await agent.chat(3, 'merci');
  for (let i = 0; i < 3; i++) await agent.chat(3, 'x');
  assert.match((await agent.chat(3, 'y')).text, /today's AI limit/);
});

test('commentary: alert uses the fast model and no tools; analysis may search', async () => {
  const db = new Db(':memory:', 10_000);
  db.setLang(4, 'Nigerian Pidgin');
  const fc = fakeClient([text('Price don drop near your liquidation. Close am now. <lang>Nigerian Pidgin</lang>'), text('Na solid token.')]);
  const agent = new Agent(db, fc);
  const a = await agent.commentary(4, 'alert', { rule_verdict: { verdict: 'CLOSE', urgent: true } });
  assert.equal(a, 'Price don drop near your liquidation. Close am now.');
  assert.equal(fc.calls[0]!.model, config.aiFastModel);
  assert.equal(fc.calls[0]!.tools, undefined);
  assert.match(JSON.stringify(fc.calls[0]!.system), /Nigerian Pidgin/);
  await agent.commentary(4, 'analysis', {});
  assert.deepEqual((fc.calls[1]!.tools as any[]).map((t) => t.name), ['web_search']);
});

test('check_position data carries the rule verdict', async () => {
  const db = new Db(':memory:', 10_000);
  const { openPerp } = await import('../src/paper.js');
  const pos = openPerp(db, { tgId: 5, side: 'long', symbol: 'WNEAR', marketId: 'wrap.near', price: 2.02, collateral: 100, leverage: 50, maxLeverage: 100 });
  const fc = fakeClient([toolUse('check_position', { position_id: pos.id }), (req) => {
    const data = JSON.parse(((req.messages.at(-1)!.content) as any[])[0].content);
    assert.equal(data.rule_verdict.verdict, 'CLOSE');
    assert.equal(data.rule_verdict.urgent, true);
    return text('Close now.')();
  }]);
  await new Agent(db, fc).chat(5, 'how is my trade?');
});
