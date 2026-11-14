import { Account, JsonRpcProvider, KeyPair, type KeyPairString, keyToImplicitAddress, nearToYocto } from 'near-api-js';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import type { Db, UserRow } from './db.js';

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;

/** Read-only contract call. */
export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

/** Generate a fresh keypair. The account id is the "implicit" address derived from the public key; it becomes live on-chain once it receives NEAR. */
export function generateWallet(): { accountId: string; privateKey: KeyPairString } {
  const kp = KeyPair.fromRandom('ed25519');
  return { accountId: keyToImplicitAddress(kp.getPublicKey()), privateKey: kp.toString() };
}

export function createWalletFor(db: Db, tgId: number): string {
  const existing = db.user(tgId);
  if (existing.account_id) return existing.account_id;
  const w = generateWallet();
  db.setWallet(tgId, w.accountId, encrypt(w.privateKey, config.masterKeyHex, String(tgId)));
  return w.accountId;
}

export function exportKey(user: UserRow): string {
  if (!user.enc_key) throw new Error('No bot wallet yet. Use /wallet first.');
  return decrypt(user.enc_key, config.masterKeyHex, String(user.tg_id));
}

export function signerAccount(user: UserRow): Account {
  if (!user.account_id || !user.enc_key) throw new Error('No bot wallet yet. Use /wallet first.');
  return new Account(user.account_id, provider, exportKey(user) as KeyPairString);
}

/** Available NEAR in yocto, or null if the account does not exist on-chain yet (never funded). */
export async function nearBalance(accountId: string): Promise<bigint | null> {
  try {
    const s = await new Account(accountId, provider).getState();
    return s.balance.available;
  } catch (e) {
    if (isAccountMissing(e)) return null;
    throw e;
  }
}

function isAccountMissing(e: unknown): boolean {
  const s = String((e as any)?.type ?? '') + ' ' + String((e as any)?.name ?? '') + ' ' + String((e as Error)?.message ?? '');
  return /AccountDoesNotExist|UNKNOWN_ACCOUNT|does not exist|doesn't exist/i.test(s);
}

export async function ftBalance(tokenId: string, accountId: string): Promise<bigint> {
  return BigInt(await view<string>(tokenId, 'ft_balance_of', { account_id: accountId }));
}

export interface FtMeta {
  symbol: string;
  name: string;
  decimals: number;
}
const metaCache = new Map<string, FtMeta>();
export async function ftMetadata(tokenId: string): Promise<FtMeta> {
  const hit = metaCache.get(tokenId);
  if (hit) return hit;
  const m = await view<FtMeta>(tokenId, 'ft_metadata');
  const meta = { symbol: m.symbol, name: m.name, decimals: m.decimals };
  metaCache.set(tokenId, meta);
  return meta;
}

/** Yocto needed to register `accountId` on a token contract, or 0n if already registered. */
export async function storageNeeded(tokenId: string, accountId: string): Promise<bigint> {
  const bal = await view<{ total: string } | null>(tokenId, 'storage_balance_of', { account_id: accountId });
  if (bal) return 0n;
  try {
    const b = await view<{ min: string }>(tokenId, 'storage_balance_bounds');
    return BigInt(b.min);
  } catch {
    return nearToYocto('0.00125');
  }
}

/** Optional: top up a brand-new wallet from the operator's funder account so it can pay gas. */
export async function fundNewWallet(accountId: string): Promise<boolean> {
  if (!config.funderAccountId || !config.funderPrivateKey) return false;
  const funder = new Account(config.funderAccountId, provider, config.funderPrivateKey as KeyPairString);
  await funder.transfer({ receiverId: accountId, amount: nearToYocto(config.funderAmountNear as `${number}`) });
  return true;
}

/** One chain operation per user at a time (avoids nonce clashes and double-spends from double taps). */
const locks = new Map<number, Promise<unknown>>();
export function withUserLock<T>(tgId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tgId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(tgId, next);
  void next.catch(() => undefined).finally(() => {
    if (locks.get(tgId) === next) locks.delete(tgId);
  });
  return next;
}
