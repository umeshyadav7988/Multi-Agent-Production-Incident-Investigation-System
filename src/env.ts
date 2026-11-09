/**
 * Loads `.env` for CLI and test runs.
 *
 * Next.js loads `.env` itself, so this is only for entry points outside it.
 * Uses the Node built-in rather than a dependency, and never overrides a
 * variable already present in the real environment — CI and `vercel env` must
 * win over a stray local file.
 */
export function loadEnv(): void {
  const before = new Set(Object.keys(process.env));
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile('.env');
  } catch {
    // No .env, or an older Node without loadEnvFile. Both are fine.
    return;
  }
  void before;
}

/** Reports which provider a run will use, without ever printing the key. */
export function describeCredentials(): string {
  const present = [
    process.env.GROQ_API_KEY && 'GROQ_API_KEY',
    process.env.AI_GATEWAY_API_KEY && 'AI_GATEWAY_API_KEY',
    process.env.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY',
  ].filter(Boolean);
  return present.length ? present.join(', ') : 'none';
}
