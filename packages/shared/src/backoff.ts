/**
 * Exponential backoff with "full jitter": delay = random(0, min(cap, base * 2^attempt)),
 * never below `min`. Jitter spreads reconnects so a server restart is not
 * hit by every client in the same millisecond.
 */
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  minMs?: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 30_000;
  const min = opts.minMs ?? 250;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt, 16)));
  return Math.max(min, Math.floor(random() * ceiling));
}
