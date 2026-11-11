// Library entry: use the rotator inside any Node scraper.
//   import { createFetcher } from 'anti-bot-bypass-and-proxy-rotator';
//   const f = createFetcher({ proxyFile: 'proxies.txt' });
//   const r = await f.fetch('https://example.com/item/1', { mustContain: 'price' });
//   if (r.ok) parse(r.body); await f.close();
export { createFetcher, FetchError } from './fetcher.js';
export { detectBlock, shouldEscalate, parseRetryAfter } from './detect.js';
export { createProxyPool } from './proxy/pool.js';
export { parseProxyList, loadProxies, makeProxy, resolveProxyUrl, normalizeProxyUrl } from './proxy/parse.js';
export { checkProxies } from './proxy/check.js';
export { createFingerprint, fromUserAgent, chromeMajor } from './fingerprint.js';
export { createCookieJar } from './cookies.js';
export { runJob, readJobInput } from './job.js';
export { extractFields, parseFieldSpecs } from './extract.js';
export { createServer } from './server.js';
export { siteReport } from './report.js';
export { loadSettings, parseLadder, DEFAULT_LADDER } from './config.js';
