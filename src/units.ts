/** Decimal string <-> integer base units, without floating point. */
export function toUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`"${amount}" is not a valid amount`);
  const [whole, frac = ''] = s.split('.') as [string, string?];
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

export function fromUnits(units: bigint, decimals: number, maxFrac = 6): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

export function applySlippage(amount: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.round(slippagePct * 100));
  return (amount * (10_000n - bps)) / 10_000n;
}
