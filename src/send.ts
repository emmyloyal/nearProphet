import { type Account, actions, nearToYocto } from 'near-api-js';
import { config } from './config.js';
import { ftBalance, nearBalance, ONE_YOCTO, storageNeeded, TGAS } from './near.js';
import { isAccountId } from './tokens.js';

/** Sending NEAR or a token from the bot wallet to another account. */

/** NEAR kept back on every send so the wallet can still pay gas afterwards. */
export const SEND_RESERVE = nearToYocto('0.05');

const IMPLICIT = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT = /^0x[0-9a-f]{40}$/;

/** Lowercased recipient from user input ("@alice.testnet" and stray punctuation are tolerated). */
export function normalizeRecipient(input: string): string {
  return input.trim().replace(/^@/, '').replace(/[.,;:!?]+$/, '').toLowerCase();
}

/** Why `to` cannot receive a send from `me`, or null if it looks fine. Pure: no network calls. */
export function recipientProblem(to: string, me: string): string | null {
  if (!isAccountId(to)) return `"${to}" is not a valid NEAR address.`;
  if (to === me) return 'That is your own bot wallet.';
  if (to === config.wrapContract || to === config.refContract)
    return `${to} is a contract, not a wallet. Anything sent there would be lost.`;
  if (IMPLICIT.test(to) || ETH_IMPLICIT.test(to)) return null;
  const testnetName = to.endsWith('.testnet');
  if (config.network === 'testnet' && !testnetName) return `This bot runs on testnet; named addresses end in .testnet (got ${to}).`;
  if (config.network === 'mainnet' && testnetName) return `${to} is a testnet address; this bot runs on mainnet.`;
  return null;
}

export interface SendResult {
  txHash: string | null;
}

/** Native NEAR transfer. Balance is re-checked right before signing. */
export async function sendNear(account: Account, to: string, amount: bigint): Promise<SendResult> {
  const avail = await nearBalance(account.accountId);
  if (avail === null || avail < amount + SEND_RESERVE) throw new Error('Not enough NEAR any more (the bot keeps 0.05 NEAR back for fees).');
  const r = await account.signAndSendTransaction({ receiverId: to, actions: [actions.transfer(amount)] });
  return { txHash: txHashOf(r) };
}

/**
 * Fungible-token transfer. If the recipient has never held this token, the bot pays its one-time
 * storage registration (about 0.00125 NEAR) in the same transaction; otherwise ft_transfer would fail.
 */
export async function sendToken(account: Account, tokenId: string, to: string, amount: bigint): Promise<SendResult> {
  const me = account.accountId;
  const [bal, storage, avail] = await Promise.all([ftBalance(tokenId, me), storageNeeded(tokenId, to), nearBalance(me)]);
  if (bal < amount) throw new Error('You no longer hold that much of this token.');
  if (avail === null || avail < storage + nearToYocto('0.01')) throw new Error('Not enough NEAR in your wallet to pay the network fee.');
  const acts = [];
  if (storage > 0n) acts.push(actions.functionCall('storage_deposit', { account_id: to, registration_only: true }, 30n * TGAS, storage));
  acts.push(actions.functionCall('ft_transfer', { receiver_id: to, amount: amount.toString() }, 30n * TGAS, ONE_YOCTO));
  const r = await account.signAndSendTransaction({ receiverId: tokenId, actions: acts });
  return { txHash: txHashOf(r) };
}

function txHashOf(r: unknown): string | null {
  return ((r as any)?.transaction?.hash as string | undefined) ?? null;
}
