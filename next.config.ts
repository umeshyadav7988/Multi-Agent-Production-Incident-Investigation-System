import type { NextConfig } from 'next';

const config: NextConfig = {
  // The agent system is server-only; nothing from src/ should be bundled for
  // the browser beyond the plain types the page uses.
  serverExternalPackages: ['ai', '@ai-sdk/anthropic'],
  typedRoutes: false,
};

export default config;
