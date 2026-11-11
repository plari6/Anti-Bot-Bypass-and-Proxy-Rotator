// A session = one "visitor": one exit IP, one header fingerprint, one cookie jar.
// Sessions are kept per site + ladder step (+ optional caller session name + country), reused until
// they get blocked, reach SESSION_MAX_REQUESTS or SESSION_TTL, then replaced by a fresh one.
import { createCookieJar } from './cookies.js';
import { createFingerprint, fromUserAgent } from './fingerprint.js';
import { resolveProxyUrl } from './proxy/parse.js';
import { randomId, siteOf } from './util.js';

export function createSessionManager({ pool, settings }) {
  const active = new Map(); // key -> session
  const cleared = new Map(); // site -> session that passed a browser challenge (cookies reusable over HTTP)

  const keyOf = (site, step, opts) => `${site}|${step.engine}:${step.type}|${opts.session || ''}|${opts.country || ''}`;

  function expired(s) {
    return s.requests >= settings.sessionMaxRequests || Date.now() - s.createdAt > settings.sessionTtlMs;
  }

  /** Get or create a session for this url and ladder step; null when no proxy of that type is free. */
  function acquire(url, step, opts = {}, exclude = new Set()) {
    const site = siteOf(url);
    const key = keyOf(site, step, opts);
    const cur = active.get(key);
    if (cur && !cur.retired && !expired(cur) && !exclude.has(cur.proxy?.id ?? 'direct')) {
      cur.requests++;
      return cur;
    }
    let proxy = null;
    if (step.type !== 'direct') {
      proxy = pool.pick(url, { type: step.type, country: opts.country || settings.country, exclude });
      if (!proxy) return null;
    }
    const country = opts.country || settings.country || proxy?.country || '';
    const id = randomId(10);
    const s = {
      id,
      key,
      site,
      step,
      proxy,
      proxyUrl: proxy ? resolveProxyUrl(proxy, { session: id, country }) : null,
      fingerprint: createFingerprint({ country }),
      jar: createCookieJar(),
      country,
      requests: 1,
      createdAt: Date.now(),
      retired: false,
      cleared: false,
    };
    active.set(key, s);
    return s;
  }

  function retire(s) {
    if (!s) return;
    s.retired = true;
    if (active.get(s.key) === s) active.delete(s.key);
    if (cleared.get(s.site) === s) cleared.delete(s.site);
  }

  /** A browser solved the challenge: keep this IP + its real UA + clearance cookies for fast HTTP. */
  function markCleared(s, userAgent) {
    if (userAgent) s.fingerprint = fromUserAgent(userAgent, s.country);
    s.cleared = true;
    cleared.set(s.site, s);
  }

  function getCleared(url) {
    const s = cleared.get(siteOf(url));
    if (!s || s.retired || expired(s)) {
      if (s) cleared.delete(s.site);
      return null;
    }
    s.requests++;
    return s;
  }

  return { acquire, retire, markCleared, getCleared, get size() { return active.size; } };
}
