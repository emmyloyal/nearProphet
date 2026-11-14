import { Agent } from './agent.js';
import { createBot } from './bot.js';
import { assertRuntimeConfig, config } from './config.js';
import { Db } from './db.js';
import { startMonitor } from './monitor.js';

assertRuntimeConfig();
const db = new Db(config.dbPath, config.paperStartUsd);
const agent = Agent.fromConfig(db);
const bot = createBot(db, agent);
const stopMonitor = startMonitor(db, bot, config.monitorIntervalSec, agent);

await bot.api.setMyCommands([
  { command: 'wallet', description: 'Create or view your wallet' },
  { command: 'token', description: 'Token price and liquidity' },
  { command: 'analyze', description: 'Deep token analysis' },
  { command: 'buy', description: 'Buy a token with NEAR' },
  { command: 'sell', description: 'Sell a token for NEAR' },
  { command: 'swap', description: 'Swap one token for another' },
  { command: 'long', description: 'Open a long' },
  { command: 'short', description: 'Open a short' },
  { command: 'positions', description: 'Open trades and PnL' },
  { command: 'check', description: 'Hold or close? Live analysis' },
  { command: 'close', description: 'Close a trade' },
  { command: 'history', description: 'Closed trades and total PnL' },
  { command: 'report', description: 'Trend, odds and news for your trades' },
  { command: 'help', description: 'All commands' },
]);

const shutdown = () => {
  stopMonitor();
  void bot.stop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

console.log(`Bot starting on ${config.network}; monitoring every ${config.monitorIntervalSec}s; AI ${agent ? 'on (' + config.aiModel + ')' : 'off (no ANTHROPIC_API_KEY)'}`);
await bot.start({ onStart: (me) => console.log(`Running as @${me.username}`) });
