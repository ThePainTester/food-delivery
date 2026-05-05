export function minorToDecimal(minor: string | number): string {
  const n = BigInt(typeof minor === "number" ? Math.trunc(minor) : minor);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export function decimalToMinor(v: string | number): number {
  const n = Number(v);
  if (!isFinite(n)) throw new Error(`invalid decimal: ${v}`);
  return Math.round(n * 100);
}
