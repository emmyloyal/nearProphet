import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from './agent.js';

/**
 * Lets the agent talk to any OpenAI-compatible chat API (NEAR AI Cloud, OpenRouter, Groq, Gemini's
 * OpenAI endpoint...). The agent keeps speaking Anthropic's message format; this class translates
 * each request to /chat/completions and the reply back. Anthropic-only server tools (web search)
 * are dropped, since these providers cannot run them.
 */

interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export class OpenAiCompatClient implements LlmClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  messages = {
    create: async (p: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      const body: Record<string, unknown> = {
        model: p.model,
        max_tokens: p.max_tokens,
        messages: toOpenAi(p),
      };
      const tools = (p.tools ?? []).filter((t): t is Anthropic.Tool => 'input_schema' in t);
      if (tools.length) {
        body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
      }
      const res = await this.fetchFn(this.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          msg = String(j?.error?.message ?? j?.message ?? j?.detail ?? msg).slice(0, 300);
        } catch {
          /* not JSON */
        }
        throw new Error(`AI provider returned ${res.status}: ${msg}`);
      }
      return fromOpenAi(JSON.parse(text), p.model);
    },
  };
}

function systemText(system: Anthropic.MessageCreateParamsNonStreaming['system']): string {
  if (!system) return '';
  return typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');
}

export function toOpenAi(p: Anthropic.MessageCreateParamsNonStreaming): OaMessage[] {
  const out: OaMessage[] = [];
  const sys = systemText(p.system);
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of p.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become "tool" messages, any text a normal user message
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => (x.type === 'text' ? x.text : '')).join('');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: c });
      } else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

export function fromOpenAi(j: any, model: string): Anthropic.Message {
  const choice = j?.choices?.[0];
  if (!choice) throw new Error('AI provider returned no choices.');
  const msg = choice.message ?? {};
  const content: any[] = [];
  // Some reasoning models put their thinking inline; never show it to users.
  const text = String(msg.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (text) content.push({ type: 'text', text, citations: null });
  for (const c of msg.tool_calls ?? []) {
    if (c?.type && c.type !== 'function') continue;
    let input: unknown = {};
    try {
      input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      input = { _unparsed_arguments: String(c.function?.arguments).slice(0, 500) };
    }
    content.push({ type: 'tool_use', id: String(c.id ?? `call_${content.length}`), name: String(c.function?.name ?? ''), input });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  const stop_reason = hasTools ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: String(j.id ?? 'oa'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
  } as unknown as Anthropic.Message;
}
