/**
 * Client-side token-rate throttle.
 *
 * Hosted inference is usually capped on tokens-per-minute, not just requests.
 * Discovering that by firing requests and absorbing 429s wastes the whole
 * retry budget on arithmetic we can do ourselves, and the resulting failures
 * look like the model reasoning badly rather than never having run.
 *
 * A sliding 60-second window of spent tokens; a call that would exceed the
 * limit waits for the oldest entries to age out instead of being rejected.
 */
export class TokenRateLimiter {
  private readonly window: { at: number; tokens: number }[] = [];

  /** Fraction of the provider cap we aim to stay under. Riding the ceiling
   *  exactly still produces 429s, because the provider's window and ours are
   *  not aligned and our token estimate is only approximate. */
  private readonly headroom = 0.8;

  constructor(
    private readonly tokensPerMinute: number,
    private readonly onWait?: (ms: number, reason: string) => void,
  ) {}

  private spentInWindow(now: number): number {
    while (this.window.length && now - (this.window[0] as { at: number }).at > 60_000) {
      this.window.shift();
    }
    return this.window.reduce((a, e) => a + e.tokens, 0);
  }

  /** Blocks until `estimated` tokens fit inside the window. */
  async acquire(estimated: number): Promise<void> {
    if (this.tokensPerMinute <= 0) return;
    const ceiling = Math.floor(this.tokensPerMinute * this.headroom);
    // A single call larger than the whole budget can never fit; let it through
    // and let the provider decide, rather than waiting forever.
    const want = Math.min(estimated, ceiling);

    for (;;) {
      const now = Date.now();
      const spent = this.spentInWindow(now);
      if (spent + want <= ceiling) return;
      const oldest = this.window[0];
      if (!oldest) return;
      const waitMs = Math.max(250, 60_000 - (now - oldest.at) + 100);
      this.onWait?.(waitMs, `${spent}/${this.tokensPerMinute} tokens used in the last minute`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  /** Records what a call actually cost, replacing the estimate. */
  record(tokens: number): void {
    this.window.push({ at: Date.now(), tokens });
  }
}

/** Rough token estimate from character count. Deliberately conservative: it is
 *  used to decide whether to wait, where over-estimating costs a little time
 *  and under-estimating costs a rejected request. */
export function estimateTokens(...texts: string[]): number {
  const chars = texts.reduce((a, t) => a + t.length, 0);
  return Math.ceil(chars / 3.3);
}
