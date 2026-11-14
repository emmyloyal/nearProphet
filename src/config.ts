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
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  aiModel: str('AI_MODEL', 'claude-sonnet-5-5'),
  aiFastModel: str('AI_FAST_MODEL', 'claude-haiku-5-5'),
  aiDailyLimit: num('AI_DAILY_LIMIT', 60),
  aiWebSearch: str('AI_WEB_SEARCH', 'on') !== 'off',
  /** Minimum gap between messages from one user */
  floodMs: num('FLOOD_MS', 700),
};

export function assertRuntimeConfig(): void {
  if (!config.botToken) throw new Error('BOT_TOKEN is missing. Get one from @BotFather and put it in .env');
  if (!/^[0-9a-fA-F]{64}$/.test(config.masterKeyHex))
    throw new Error('MASTER_KEY must be 64 hex characters. Generate one with: npm run genkey');
  if (config.network === 'mainnet' && process.env.I_UNDERSTAND_MAINNET_RISK !== 'yes')
    throw new Error('Refusing to start on mainnet. Read the "Before mainnet" section of the README first.');
}
