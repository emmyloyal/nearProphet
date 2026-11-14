import 'dotenv/config';

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}
function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

// --- AI provider: Anthropic directly, NEAR AI Cloud, or any OpenAI-compatible API ---
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
const nearAiKey = process.env.NEAR_AI_API_KEY ?? '';
const genericKey = process.env.AI_API_KEY ?? '';
const aiProvider = str('AI_PROVIDER', nearAiKey ? 'nearai' : genericKey ? 'openai' : 'anthropic') as 'anthropic' | 'nearai' | 'openai';
if (!['anthropic', 'nearai', 'openai'].includes(aiProvider)) throw new Error('AI_PROVIDER must be anthropic, nearai or openai');
/** NEAR AI names Claude models "anthropic/<id>"; accept the plain id too. */
const modelFor = (m: string) => (aiProvider === 'nearai' && !m.includes('/') && m.startsWith('claude-') ? `anthropic/${m}` : m);

const DEFAULT_FEEDS = ['https://cointelegraph.com/rss', 'https://decrypt.co/feed', 'https://www.theblock.co/rss.xml', 'https://www.coindesk.com/arc/outboundfeeds/rss/'];

export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  masterKeyHex: process.env.MASTER_KEY ?? '',
  network: str('NEAR_NETWORK', 'testnet') as 'testnet' | 'mainnet',
  rpcUrl: str('NEAR_RPC_URL', 'https://test.rpc.fastnear.com'),
  refContract: str('REF_CONTRACT_ID', 'ref-finance-101.testnet'),
  wrapContract: str('WRAP_CONTRACT_ID', 'wrap.testnet'),
  geckoBase: str('GECKO_BASE_URL', 'https://api.geckoterminal.com/api/v2'),
  geckoNetwork: str('GECKO_NETWORK', 'near'),
  allowedUserIds: str('ALLOWED_USER_IDS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  funderAccountId: process.env.FUNDER_ACCOUNT_ID ?? '',
  funderPrivateKey: process.env.FUNDER_PRIVATE_KEY ?? '',
  funderAmountNear: str('FUNDER_AMOUNT_NEAR', '1'),
  maxTradeNear: num('MAX_TRADE_NEAR', 50),
  maxLeverage: num('MAX_LEVERAGE', 10),
  slippagePct: num('SLIPPAGE_PCT', 1),
  paperStartUsd: num('PAPER_START_USD', 10_000),
  monitorIntervalSec: num('MONITOR_INTERVAL_SEC', 300),
  dbPath: str('DB_PATH', './data/bot.db'),
  // --- AI agent (optional: without a key the bot runs on rules only) ---
  aiProvider,
  anthropicKey,
  /** Key for nearai/openai providers */
  aiApiKey: aiProvider === 'nearai' ? nearAiKey || genericKey : genericKey,
  aiBaseUrl: str('AI_BASE_URL', aiProvider === 'nearai' ? 'https://cloud-api.near.ai/v1' : ''),
  aiModel: modelFor(str('AI_MODEL', 'claude-sonnet-5-5')),
  aiFastModel: modelFor(str('AI_FAST_MODEL', 'claude-haiku-5-5')),
  aiDailyLimit: num('AI_DAILY_LIMIT', 60),
  aiWebSearch: str('AI_WEB_SEARCH', 'on') !== 'off',
  // --- Scheduled trade reports and news ---
  /** Default hours between trade reports for each trader with open trades; 0 = off. Users can change theirs with /report. */
  reportHours: num('REPORT_INTERVAL_HOURS', 4),
  newsFeeds: str('NEWS_FEEDS', DEFAULT_FEEDS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s)),
  /** Minimum gap between messages from one user */
  floodMs: num('FLOOD_MS', 700),
};

export function assertRuntimeConfig(): void {
  if (!config.botToken) throw new Error('BOT_TOKEN is missing. Get one from @BotFather and put it in .env');
  if (!/^[0-9a-fA-F]{64}$/.test(config.masterKeyHex))
    throw new Error('MASTER_KEY must be 64 hex characters. Generate one with: npm run genkey');
  if (config.network === 'mainnet' && process.env.I_UNDERSTAND_MAINNET_RISK !== 'yes')
    throw new Error('Refusing to start on mainnet. Read the "Before mainnet" section of the README first.');
  if (config.aiProvider === 'openai' && config.aiApiKey && !config.aiBaseUrl)
    throw new Error('AI_PROVIDER=openai needs AI_BASE_URL, e.g. https://openrouter.ai/api/v1');
}
