import type { VercelConfig } from '@vercel/config/v1';

/**
 * Vercel project configuration.
 *
 * The investigation runs server-side on Fluid Compute: a full multi-agent run
 * with a real model can take well over a minute, which is why maxDuration is
 * raised on the route itself rather than relying on the default.
 */
export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'next build',
  installCommand: 'npm install',
  regions: ['iad1'],
};

export default config;
