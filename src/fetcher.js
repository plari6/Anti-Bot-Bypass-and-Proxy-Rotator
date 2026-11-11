// The core: fetch(url) walks an escalation ladder until a real page comes back.
//
//   0. cleared session  - an IP whose browser already passed this site's challenge: reuse its cookies over HTTP
//   1. http:datacenter  - cheapest, fastest
//   2. http:residential - fresh residential session (new IP, new fingerprint, empty jar)
//   3. browser:residential - stealth Chrome solves JS challenges, its cookies are kept for step 0
//   4. browser:mobile   - last resort, most trusted and most expensive IPs
//
// Each site remembers the step that worked last time and starts there; after 25 successes in a row it
// probes one step cheaper again, so spend falls when a site relaxes its protection.
import { loadProxies, resolveProxyUrl } from './proxy/parse.js';
import { createProxyPool } from './proxy/pool.js';
import { createSessionManager } from './sessions.js';
import { detectBlock } from './detect.js';
import { httpRequest, closeAgents } from './engines/http.js';
import { createBrowserEngine } from './engines/browser.js';
import { createRobotsCache } from './robots.js';
import { createDomainLimiter } from './limiter.js';
import { createState } from './state.js';
import { navigationHeaders } from './fingerprint.js';
import { loadSettings } from './config.js';
import { maskProxy, siteOf, sleep } from './util.js';

const PROBE_DOWN_AFTER = 25;

export class FetchError extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

/**
 * @param {object} [overrides] settings overrides (see config.js); extra: proxyList (array), persist (bool),
 *                             browserEngine / httpEngine (for tests), noBrowser (bool)
 */
export function createFetcher(overrides = {}) {
  const settings = loadSettings(overrides);
  const log = settings.log;
  const persist = overrides.persist !== false;
  const state = createState(settings.stateFile, { persist });

  let proxies;
  let proxyErrors = [];
  if (overrides.proxyList) {
    proxies = overrides.proxyList;
  } else {
    const loaded = loadProxies(settings);
    proxies = loaded.proxies;
    proxyErrors = loaded.errors;
    for (const e of proxyErrors) log(`[proxies] skipped: ${e}`);
  }
  const pool = createProxyPool(proxies, settings, state.data.proxies);
  const sessions = createSessionManager({ pool, settings });
  const limiter = createDomainLimiter({ delayMs: settings.domainDelayMs, concurrency: settings.domainConcurrency });
  const http = overrides.httpEngine || httpRequest;
  const browser = overrides.noBrowser ? null : overrides.browserEngine || createBrowserEngine(settings);
  const bypassLoopback = Boolean(overrides.bypassLoopback);

  // robots.txt goes through the cheapest proxies (up to 3 tries, a dead proxy must not hide the rules).
  const robots = createRobotsCache(async (robotsUrl) => {
    const exclude = new Set();
    let lastErr;
    for (let i = 0; i < 3; i++) {
      const proxy = pool.size ? pool.pick(robotsUrl, { type: 'datacenter', exclude }) || pool.pick(robotsUrl, { type: 'any', exclude }) : null;
      if (pool.size && !proxy) break;
      if (proxy) exclude.add(proxy.id);
      try {
        const res = await http({ url: robotsUrl, proxyUrl: proxy ? resolveProxyUrl(proxy, { session: 'robots', country: settings.country }) : null, headers: { 'user-agent': 'Mozilla/5.0 (compatible; data-collector)' }, timeoutMs: 10000 });
        return { status: res.status, body: res.body };
      } catch (err) {
        lastErr = err;
        pool.report(proxy, robotsUrl, { kind: 'error' });
        if (!proxy) break;
      }
    }
    throw lastErr || new Error('no proxy for robots.txt');
  });

  /** Ladder steps that can actually run with the proxies we have. */
  function stepsFor(opts) {
    const types = pool.types();
    let ladder = opts.ladder || settings.ladder;
    if (!pool.size) {
      // No proxies configured: same engines, straight from this machine.
      ladder = [...new Set(ladder.map((s) => s.engine))].map((engine) => ({ engine, type: 'direct' }));
    } else if (settings.allowDirect && !ladder.some((s) => s.type === 'direct')) {
      ladder = [{ engine: 'http', type: 'direct' }, ...ladder];
    }
    return ladder.filter((s) => {
      if (s.engine === 'browser' && !browser) return false;
      if (opts.render && s.engine !== 'browser') return false;
      if (opts.engine && s.engine !== opts.engine) return false;
      if (s.type === 'direct') return !pool.size || settings.allowDirect;
      return s.type === 'any' ? pool.size > 0 : types.has(s.type);
    });
  }

  function costOf(proxy, bytes) {
    return proxy ? (bytes / 1e9) * (proxy.costPerGb || 0) : 0;
  }

  async function attempt(url, step, session, opts) {
    const headers = { ...navigationHeaders(session.fingerprint, { referer: opts.referer, url }), ...(opts.headers || {}) };
    if (step.engine === 'http') {
      return http({ url, method: opts.method, headers, data: opts.data, proxyUrl: session.proxyUrl, jar: session.jar, timeoutMs: opts.timeoutMs || settings.timeoutMs });
    }
    return browser.fetchPage({
      url,
      proxyUrl: session.proxyUrl,
      jar: session.jar,
      acceptLanguage: session.fingerprint.headers['accept-language'],
      timeoutMs: opts.timeoutMs || settings.browserTimeoutMs,
      waitForSelector: opts.waitForSelector,
      bypassLoopback,
    });
  }

  /**
   * Fetch one URL. Never throws for blocks/network errors; returns { ok:false, error, block, attempts } instead.
   * @param {string} url
   * @param {{method?, headers?, data?, render?, engine?, country?, session?, referer?, mustContain?, minBytes?,
   *          waitForSelector?, timeoutMs?, maxAttempts?, ignoreRobots?, ladder?}} [opts]
   */
  async function fetch(url, opts = {}) {
    const t0 = Date.now();
    const site = siteOf(url);
    const attempts = [];
    const fail = (error, extra = {}) => ({ ok: false, url, error, attempts, ms: Date.now() - t0, costUsd: sumCost(attempts), bytes: sumBytes(attempts), ...extra });
    if (!site) return fail('invalid url');

    if (settings.budgetUsd && state.data.totals.costUsd >= settings.budgetUsd) {
      return fail(`proxy budget reached ($${state.data.totals.costUsd.toFixed(2)} of $${settings.budgetUsd})`, { budgetExceeded: true });
    }
    if (settings.respectRobots && !opts.ignoreRobots) {
      const r = await robots.check(url);
      if (!r.allowed) return fail('disallowed by robots.txt', { robots: true });
      if (r.crawlDelayMs) limiter.setMinDelay(url, r.crawlDelayMs);
    }

    const steps = stepsFor(opts);
    if (!steps.length) return fail('no usable ladder step (check proxies, LADDER and --no-browser)');
    const maxAttempts = opts.maxAttempts || settings.maxAttempts;
    const profile = state.site(site);
    let start = Math.min(profile.tier || 0, steps.length - 1);
    if (start > 0 && profile.okSinceEscalation >= PROBE_DOWN_AFTER && !opts.render) {
      start -= 1; // cost probe: maybe the site relaxed
      profile.okSinceEscalation = 0;
    }
    let lastBlock = null;
    let lastError = null;
    let lastResponse = null;

    const runOne = async (step, session, label, tier) => {
      const a = { step: label, proxy: session.proxy ? `${session.proxy.id} ${maskProxy(session.proxyUrl)}` : 'direct', session: session.id };
      attempts.push(a);
      const tA = Date.now();
      let res;
      try {
        res = await limiter.run(url, () => attempt(url, step, session, opts));
      } catch (err) {
        a.error = shortError(err);
        a.ms = Date.now() - tA;
        lastError = a.error;
        pool.report(session.proxy, url, { kind: 'error' });
        sessions.retire(session);
        state.recordAttempt(site, { outcome: 'error', bytes: 0 });
        log(`  x ${label} ${a.proxy} -> ${a.error}`);
        return { next: 'retry' };
      }
      const verdict = detectBlock(res, { mustContain: opts.mustContain, minBytes: opts.minBytes, extraCookies: res.cookies });
      const cost = costOf(session.proxy, res.bytes || 0);
      Object.assign(a, { status: res.status, ms: Date.now() - tA, bytes: res.bytes || 0, costUsd: +cost.toFixed(6) });
      lastResponse = res;

      if (verdict.blocked) {
        Object.assign(a, { blocked: verdict.kind, vendor: verdict.vendor, reason: verdict.reason });
        lastBlock = verdict;
        state.recordAttempt(site, { outcome: 'blocked', vendor: verdict.vendor, kind: verdict.kind, bytes: res.bytes, costUsd: cost, presence: verdict.presence });
        if (verdict.kind === 'proxy_auth') {
          pool.report(session.proxy, url, { kind: 'error' });
          pool.report(session.proxy, url, { kind: 'error' });
        } else {
          pool.report(session.proxy, url, { kind: 'blocked', retryAfterMs: verdict.retryAfterMs, bytes: res.bytes, latencyMs: a.ms });
        }
        sessions.retire(session);
        if (verdict.kind === 'rate_limit') {
          limiter.slowDown(url);
          if (!session.proxy || session.step.type === 'direct') await sleep(Math.min(verdict.retryAfterMs, 15000));
        }
        log(`  ! ${label} ${a.proxy} -> ${verdict.reason}`);
        // JS challenges and captchas will not go away with another identical HTTP request: climb.
        const climb = ['challenge', 'captcha'].includes(verdict.kind) || (verdict.kind === 'soft' && step.engine === 'browser');
        return { next: climb ? 'escalate' : 'retry' };
      }

      if (res.status >= 500 && res.status !== 501) {
        a.error = `HTTP ${res.status}`;
        lastError = a.error;
        pool.report(session.proxy, url, { kind: 'neutral', bytes: res.bytes });
        state.recordAttempt(site, { outcome: 'error', bytes: res.bytes, costUsd: cost });
        log(`  ~ ${label} ${a.proxy} -> origin error ${res.status}`);
        return { next: 'retry' };
      }

      pool.report(session.proxy, url, { kind: 'ok', bytes: res.bytes, latencyMs: a.ms });
      state.recordAttempt(site, { outcome: 'ok', bytes: res.bytes, costUsd: cost, presence: verdict.presence });
      limiter.speedUp(url);
      if (step.engine === 'browser') sessions.markCleared(session, res.userAgent);
      if (tier !== null) state.recordSuccess(site, tier, label);
      state.setProxyHealth(pool.snapshot());
      return {
        next: 'done',
        result: {
          ok: res.status < 400,
          url,
          finalUrl: res.finalUrl || url,
          status: res.status,
          headers: res.headers,
          contentType: res.contentType,
          encoding: res.encoding || 'utf8',
          body: res.body,
          engine: step.engine,
          step: label,
          proxy: a.proxy,
          proxyType: session.proxy?.type || 'direct',
          session: session.id,
          protection: verdict.presence,
          attempts,
          bytes: sumBytes(attempts),
          costUsd: sumCost(attempts),
          ms: Date.now() - t0,
        },
      };
    };

    // Step 0: a session whose cookies already passed a challenge on this site.
    if (!opts.render && opts.engine !== 'browser' && !opts.session) {
      const s = sessions.getCleared(url);
      if (s) {
        const out = await runOne({ engine: 'http', type: s.step.type }, s, 'http:cleared', null);
        if (out.next === 'done') return out.result;
      }
    }

    for (let i = start; i < steps.length && attempts.length < maxAttempts; i++) {
      const step = steps[i];
      const label = `${step.engine}:${step.type}`;
      const exclude = new Set();
      for (let t = 0; t < settings.retriesPerStep && attempts.length < maxAttempts; t++) {
        const session = sessions.acquire(url, step, opts, exclude);
        if (!session) break; // nothing of that proxy type is free right now
        if (session.proxy && !session.proxy.sticky) exclude.add(session.proxy.id);
        const out = await runOne(step, session, label, i);
        if (out.next === 'done') return out.result;
        if (out.next === 'escalate') break;
      }
    }

    state.setProxyHealth(pool.snapshot());
    if (lastBlock) return fail(`blocked: ${lastBlock.reason}`, { block: lastBlock, status: lastBlock.status, protection: lastBlock.presence, body: opts.returnBlockedBody ? lastResponse?.body : undefined });
    return fail(lastError || 'all attempts failed', { status: lastResponse?.status });
  }

  /** fetch() that throws when the page could not be retrieved. */
  async function fetchOrThrow(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new FetchError(`${url}: ${r.error}`, r);
    return r;
  }

  return {
    settings,
    pool,
    state,
    proxyErrors,
    fetch,
    fetchOrThrow,
    stepsFor,
    async close() {
      state.setProxyHealth(pool.snapshot());
      state.save();
      await browser?.close?.();
      if (!overrides.httpEngine) closeAgents();
    },
  };
}

function sumBytes(attempts) {
  return attempts.reduce((n, a) => n + (a.bytes || 0), 0);
}
function sumCost(attempts) {
  return +attempts.reduce((n, a) => n + (a.costUsd || 0), 0).toFixed(6);
}

function shortError(err) {
  const code = err?.code || err?.cause?.code;
  const msg = String(err?.message || err).split('\n')[0].slice(0, 200);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}
