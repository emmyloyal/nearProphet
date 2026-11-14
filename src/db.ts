import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface UserRow {
  tg_id: number;
  account_id: string | null;
  enc_key: string | null;
  watch_account: string | null;
  paper_usd: number;
  created_at: number;
  lang: string | null;
  report_hours: number | null;
  last_report_at: number | null;
}

export interface PositionRow {
  id: number;
  tg_id: number;
  kind: 'perp' | 'spot';
  side: 'long' | 'short';
  symbol: string;
  market_id: string;
  entry: number;
  size_usd: number;
  collateral: number;
  leverage: number;
  liq: number | null;
  status: 'open' | 'closed' | 'liquidated';
  exit: number | null;
  pnl: number | null;
  last_verdict: string | null;
  opened_at: number;
  closed_at: number | null;
}

export class Db {
  private db: DatabaseSync;

  constructor(path: string, private paperStartUsd: number) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        tg_id INTEGER PRIMARY KEY,
        account_id TEXT,
        enc_key TEXT,
        watch_account TEXT,
        paper_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        side TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market_id TEXT NOT NULL,
        entry REAL NOT NULL,
        size_usd REAL NOT NULL,
        collateral REAL NOT NULL,
        leverage REAL NOT NULL,
        liq REAL,
        status TEXT NOT NULL DEFAULT 'open',
        exit REAL,
        pnl REAL,
        last_verdict TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS positions_open ON positions(status, tg_id);
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        token_in TEXT NOT NULL,
        token_out TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        amount_out TEXT NOT NULL,
        tx_hash TEXT,
        at INTEGER NOT NULL
      );
    `);
    const cols = (this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('lang')) this.db.exec('ALTER TABLE users ADD COLUMN lang TEXT');
    if (!cols.includes('report_hours')) this.db.exec('ALTER TABLE users ADD COLUMN report_hours REAL');
    if (!cols.includes('last_report_at')) this.db.exec('ALTER TABLE users ADD COLUMN last_report_at INTEGER');
  }

  /** null = use the default interval; 0 = off. */
  setReportHours(tgId: number, hours: number | null): void {
    this.user(tgId);
    this.db.prepare('UPDATE users SET report_hours = ? WHERE tg_id = ?').run(hours, tgId);
  }

  markReported(tgId: number, at = Date.now()): void {
    this.db.prepare('UPDATE users SET last_report_at = ? WHERE tg_id = ?').run(at, tgId);
  }

  /** Remember the language a user last wrote in (free text, e.g. "French" or "Nigerian Pidgin"). */
  setLang(tgId: number, lang: string): void {
    this.user(tgId);
    this.db.prepare('UPDATE users SET lang = ? WHERE tg_id = ?').run(lang.slice(0, 40), tgId);
  }

  user(tgId: number): UserRow {
    const row = this.db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) as unknown as UserRow | undefined;
    if (row) return row;
    this.db
      .prepare('INSERT INTO users (tg_id, paper_usd, created_at) VALUES (?, ?, ?)')
      .run(tgId, this.paperStartUsd, Date.now());
    return this.user(tgId);
  }

  setWallet(tgId: number, accountId: string, encKey: string): void {
    this.user(tgId);
    this.db.prepare('UPDATE users SET account_id = ?, enc_key = ? WHERE tg_id = ?').run(accountId, encKey, tgId);
  }

  setWatch(tgId: number, account: string | null): void {
    this.user(tgId);
    this.db.prepare('UPDATE users SET watch_account = ? WHERE tg_id = ?').run(account, tgId);
  }

  addPaper(tgId: number, delta: number): void {
    this.db.prepare('UPDATE users SET paper_usd = paper_usd + ? WHERE tg_id = ?').run(delta, tgId);
  }

  openPosition(p: Omit<PositionRow, 'id' | 'status' | 'exit' | 'pnl' | 'last_verdict' | 'opened_at' | 'closed_at'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO positions (tg_id, kind, side, symbol, market_id, entry, size_usd, collateral, leverage, liq, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.tg_id, p.kind, p.side, p.symbol, p.market_id, p.entry, p.size_usd, p.collateral, p.leverage, p.liq, Date.now());
    return Number(r.lastInsertRowid);
  }

  position(id: number, tgId: number): PositionRow | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE id = ? AND tg_id = ?').get(id, tgId) as unknown as PositionRow | undefined;
  }

  openPositions(tgId?: number): PositionRow[] {
    const q = tgId === undefined
      ? this.db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY id").all()
      : this.db.prepare("SELECT * FROM positions WHERE status = 'open' AND tg_id = ? ORDER BY id").all(tgId);
    return q as unknown as PositionRow[];
  }

  /** Returns false if the position was already closed (guards against double-close). */
  closePosition(id: number, status: 'closed' | 'liquidated', exit: number, pnl: number): boolean {
    const r = this.db
      .prepare("UPDATE positions SET status = ?, exit = ?, pnl = ?, closed_at = ? WHERE id = ? AND status = 'open'")
      .run(status, exit, pnl, Date.now(), id);
    return Number(r.changes) === 1;
  }

  setVerdict(id: number, verdict: string): void {
    this.db.prepare('UPDATE positions SET last_verdict = ? WHERE id = ?').run(verdict, id);
  }

  logTrade(t: { tg_id: number; action: string; token_in: string; token_out: string; amount_in: string; amount_out: string; tx_hash: string | null }): void {
    this.db
      .prepare('INSERT INTO trades (tg_id, action, token_in, token_out, amount_in, amount_out, tx_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.tg_id, t.action, t.token_in, t.token_out, t.amount_in, t.amount_out, t.tx_hash, Date.now());
  }

  /** Run fn atomically. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
