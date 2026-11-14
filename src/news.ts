import { config } from './config.js';

/**
 * Free crypto news from publishers' public RSS feeds (no key). Headlines are third-party text:
 * they are passed to the AI as data and HTML-escaped before users see them.
 */

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number;
}

const TTL_MS = 10 * 60_000;
let cache: { at: number; items: NewsItem[] } | null = null;
let inflight: Promise<NewsItem[]> | null = null;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1]! : null;
};

export function parseFeed(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0];
    const title = decode(tag(it, 'title') ?? '').slice(0, 200);
    let link = decode(tag(it, 'link') ?? '');
    const at = Date.parse(decode(tag(it, 'pubDate') ?? ''));
    if (!title || !Number.isFinite(at)) continue;
    try {
      const u = new URL(link);
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
      link = u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
    } catch {
      link = '';
    }
    items.push({ title, link, source, publishedAt: at });
  }
  return items;
}

async function fetchAll(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    config.newsFeeds.map(async (url) => {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; rss-reader)', accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(8_000), redirect: 'follow' });
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      return parseFeed(await res.text(), new URL(url).hostname.replace(/^www\./, ''));
    }),
  );
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const it of r.value) {
      const k = it.title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  }
  return items.sort((a, b) => b.publishedAt - a.publishedAt);
}

/** All recent headlines from every feed, newest first (cached 10 minutes). */
export async function allNews(): Promise<NewsItem[]> {
  if (!config.newsFeeds.length) return [];
  if (cache && Date.now() - cache.at < TTL_MS) return cache.items;
  inflight ??= fetchAll().finally(() => (inflight = null));
  const items = await inflight;
  cache = { at: Date.now(), items };
  return items;
}

export function _resetNewsCache(): void {
  cache = null;
}

/** Search terms for a token: its plain symbol (case-sensitive word) and a cleaned-up name. */
export function keywordsFor(symbol: string, name?: string): RegExp[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let sym = symbol.toUpperCase().replace(/^\$/, '');
  if (/^W(NEAR|ETH|BTC)$/.test(sym)) sym = sym.slice(1);
  const out: RegExp[] = [];
  if (sym.length >= 3) out.push(new RegExp(`(^|[^A-Za-z0-9])\\$?${esc(sym)}([^A-Za-z0-9]|$)`));
  if (sym === 'NEAR') out.push(/NEAR Protocol|NEAR Intents|NEAR AI|Illia Polosukhin/i);
  const clean = (name ?? '').replace(/\b(wrapped|fungible|token|coin)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (clean.length >= 4 && clean.toUpperCase() !== sym) out.push(new RegExp(`\\b${esc(clean)}\\b`, 'i'));
  return out;
}

/** Headlines about one token from the last `hours`. */
export async function newsFor(symbol: string, name?: string, max = 5, hours = 72): Promise<NewsItem[]> {
  const kws = keywordsFor(symbol, name);
  if (!kws.length) return [];
  const since = Date.now() - hours * 3_600_000;
  return (await allNews()).filter((n) => n.publishedAt >= since && kws.some((k) => k.test(n.title))).slice(0, max);
}

/** Latest general crypto headlines, for market mood. */
export async function marketNews(max = 5, hours = 24): Promise<NewsItem[]> {
  const since = Date.now() - hours * 3_600_000;
  return (await allNews()).filter((n) => n.publishedAt >= since).slice(0, max);
}

export function ago(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Compact form for the AI. */
export const newsData = (items: NewsItem[], now = Date.now()) => items.map((n) => ({ title: n.title, source: n.source, age: ago(n.publishedAt, now) }));
