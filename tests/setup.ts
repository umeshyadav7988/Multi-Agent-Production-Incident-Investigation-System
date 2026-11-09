import { loadEnv } from '../src/env.ts';

// Tests must not depend on a developer's local credentials: they run against
// the deterministic engine regardless of what is in .env.
loadEnv();
process.env.ENGINE = 'heuristic';
