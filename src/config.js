// Settings from environment variables (.env) with CLI overrides on top.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDuration, toBool } from './util.js';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let envLoaded = false;
export function loadEnv() {
  if (envLoaded || process.env.ANTIBOT_SKIP_DOTENV === '1') return;
  envLoaded = true;
  for (const file of [path.resolve('.env'), path.join(PROJECT_DIR, '.env')]) {
    if (fs.existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch { /* malformed .env: ignore, env vars still work */ }
      break;
    }
  }
}

/** Default escalation ladder: cheap and fast first, expensive and slow last. */
export const DEFAULT_LADDER = 'http:datacenter,http:residential,browser:residential,browser:mobile';

export function parseLadder(spec = DEFAULT_LADDER) {
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [engine, type = 'any'] = s.split(':').map((x) => x.trim().toLowerCase());
      if (!['http', 'browser'].includes(engine)) throw new Error(`Unknown engine in LADDER: "${s}" (use http or browser)`);
      if (!['datacenter', 'residential', 'mobile', 'isp', 'any', 'direct'].includes(type)) throw new Error(`Unknown proxy type in LADDER: "${s}"`);
      return { engine, type };
    });
}

export function loadSettings(overrides = {}) {
  loadEnv();
  const env = process.env;
  const pick = (key, envKey, fallback) => (overrides[key] !== undefined ? overrides[key] : env[envKey] !== undefined && env[envKey] !== '' ? env[envKey] : fallback);

  const s = {
    proxies: pick('proxies', 'PROXIES', ''), // inline list, comma or newline separated
    proxyFile: pick('proxyFile', 'PROXY_FILE', ''),
    ladder: parseLadder(pick('ladder', 'LADDER', DEFAULT_LADDER)),
    strategy: pick('strategy', 'ROTATION_STRATEGY', 'weighted'), // weighted | round-robin | random | least-used
    allowDirect: toBool(pick('allowDirect', 'ALLOW_DIRECT', 'false')),
    retriesPerStep: Number(pick('retriesPerStep', 'RETRIES_PER_STEP', 2)),
    maxAttempts: Number(pick('maxAttempts', 'MAX_ATTEMPTS', 8)),
    timeoutMs: parseDuration(pick('timeoutMs', 'TIMEOUT', '25s'), 25000),
    browserTimeoutMs: parseDuration(pick('browserTimeoutMs', 'BROWSER_TIMEOUT', '45s'), 45000),
    domainDelayMs: parseDuration(pick('domainDelayMs', 'DOMAIN_DELAY', '1500ms'), 1500),
    domainConcurrency: Number(pick('domainConcurrency', 'DOMAIN_CONCURRENCY', 2)),
    concurrency: Number(pick('concurrency', 'CONCURRENCY', 4)),
    browserConcurrency: Number(pick('browserConcurrency', 'BROWSER_CONCURRENCY', 2)),
    sessionMaxRequests: Number(pick('sessionMaxRequests', 'SESSION_MAX_REQUESTS', 60)),
    sessionTtlMs: parseDuration(pick('sessionTtlMs', 'SESSION_TTL', '20m'), 20 * 60000),
    banBaseMs: parseDuration(pick('banBaseMs', 'BAN_COOLDOWN', '2m'), 120000),
    banMaxMs: parseDuration(pick('banMaxMs', 'BAN_COOLDOWN_MAX', '2h'), 7200000),
    deadAfterErrors: Number(pick('deadAfterErrors', 'DEAD_AFTER_ERRORS', 5)),
    respectRobots: toBool(pick('respectRobots', 'RESPECT_ROBOTS', 'true'), true),
    budgetUsd: Number(pick('budgetUsd', 'BUDGET_USD', 0)) || 0, // 0 = unlimited
    country: pick('country', 'PROXY_COUNTRY', ''),
    chromePath: pick('chromePath', 'CHROME_PATH', undefined),
    headless: !toBool(pick('headful', 'HEADFUL', 'false')),
    blockAssets: toBool(pick('blockAssets', 'BROWSER_BLOCK_ASSETS', 'true'), true),
    stateFile: pick('stateFile', 'STATE_FILE', path.resolve('data', 'state.json')),
    debugDir: pick('debugDir', 'DEBUG_DIR', ''),
    apiKey: pick('apiKey', 'API_KEY', ''),
    port: Number(pick('port', 'PORT', 8787)),
    host: pick('host', 'HOST', '127.0.0.1'),
    log: overrides.log || (toBool(env.ANTIBOT_QUIET) ? () => {} : (msg) => process.stderr.write(`${msg}\n`)),
  };
  if (!['weighted', 'round-robin', 'random', 'least-used'].includes(s.strategy)) {
    throw new Error(`ROTATION_STRATEGY must be weighted, round-robin, random or least-used (got "${s.strategy}")`);
  }
  return s;
}
