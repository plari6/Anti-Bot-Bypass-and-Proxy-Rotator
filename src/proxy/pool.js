// Proxy pool with health scoring, per-site bans and global dead detection.
//
// - A block on site A only cools that proxy down for site A (exponential backoff), it stays usable elsewhere.
// - Network errors count globally; after DEAD_AFTER_ERRORS in a row the proxy rests for banMaxMs.
// - "weighted" picks proxies by a Bayesian success rate for this site, blended with the global rate,
//   with a small latency penalty, so good exits get most of the traffic but new ones still get tried.
import { siteOf } from '../util.js';

export function createProxyPool(proxies, settings = {}, savedHealth = {}) {
  const banBaseMs = settings.banBaseMs ?? 120000;
  const banMaxMs = settings.banMaxMs ?? 7200000;
  const deadAfter = settings.deadAfterErrors ?? 5;
  const strategy = settings.strategy || 'weighted';
  const now = settings.now || (() => Date.now());
  let rr = 0;

  const health = new Map();
  for (const p of proxies) {
    const h = savedHealth[p.id];
    health.set(p.id, {
      ok: h?.ok || 0,
      fail: h?.fail || 0,
      errors: h?.errors || 0,
      consecutiveErrors: 0,
      deadUntil: h?.deadUntil || 0,
      latencyMs: h?.latencyMs || 0,
      used: h?.used || 0,
      bytes: h?.bytes || 0,
      lastUsed: 0,
      sites: h?.sites ? structuredClone(h.sites) : {}, // site -> { ok, fail, strikes, bannedUntil }
    });
  }

  const siteStats = (h, site) => (h.sites[site] ||= { ok: 0, fail: 0, strikes: 0, bannedUntil: 0 });

  function available(p, site) {
    const h = health.get(p.id);
    const t = now();
    if (h.deadUntil > t) return false;
    const s = h.sites[site];
    return !(s && s.bannedUntil > t);
  }

  function score(p, site) {
    const h = health.get(p.id);
    const s = h.sites[site] || { ok: 0, fail: 0 };
    const siteRate = (s.ok + 1) / (s.ok + s.fail + 2);
    const globalRate = (h.ok + 1) / (h.ok + h.fail + h.errors + 2);
    const latency = h.latencyMs ? Math.min(1, 1500 / (h.latencyMs + 500)) : 0.8;
    return Math.max(0.02, siteRate * 0.6 + globalRate * 0.3 + latency * 0.1);
  }

  function matchesType(p, type) {
    if (!type || type === 'any') return true;
    return p.type === type;
  }

  /**
   * Pick a proxy for this url. Returns null when nothing of that type is usable right now.
   * @param {{type?: string, country?: string, exclude?: Set<string>}} opts
   */
  function pick(url, { type = 'any', country = '', exclude } = {}) {
    const site = siteOf(url);
    let candidates = proxies.filter((p) => matchesType(p, type) && available(p, site) && !exclude?.has(p.id));
    if (country) {
      const byCountry = candidates.filter((p) => !p.country || p.country === country.toLowerCase() || /\{country\}/.test(p.url));
      if (byCountry.length) candidates = byCountry;
    }
    if (!candidates.length) return null;
    let chosen;
    if (strategy === 'round-robin') {
      chosen = candidates[rr++ % candidates.length];
    } else if (strategy === 'random') {
      chosen = candidates[Math.floor(Math.random() * candidates.length)];
    } else if (strategy === 'least-used') {
      chosen = [...candidates].sort((a, b) => health.get(a.id).used - health.get(b.id).used)[0];
    } else {
      const weights = candidates.map((p) => score(p, site) ** 2);
      let r = Math.random() * weights.reduce((a, b) => a + b, 0);
      chosen = candidates[candidates.length - 1];
      for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          chosen = candidates[i];
          break;
        }
      }
    }
    const h = health.get(chosen.id);
    h.used++;
    h.lastUsed = now();
    return chosen;
  }

  function report(proxy, url, outcome) {
    if (!proxy) return;
    const h = health.get(proxy.id);
    if (!h) return;
    const site = siteOf(url);
    const s = siteStats(h, site);
    h.bytes += outcome.bytes || 0;
    if (outcome.latencyMs) h.latencyMs = h.latencyMs ? Math.round(h.latencyMs * 0.7 + outcome.latencyMs * 0.3) : outcome.latencyMs;
    if (outcome.kind === 'ok') {
      h.ok++;
      s.ok++;
      s.strikes = 0;
      h.consecutiveErrors = 0;
    } else if (outcome.kind === 'blocked') {
      h.fail++;
      s.fail++;
      h.consecutiveErrors = 0;
      // A rotating gateway ({session} in the URL) gives a new exit IP per session, so one burned IP
      // must not bench the whole gateway (the session is retired instead).
      if (proxy.sticky) return;
      s.strikes++;
      // Rate limits honor Retry-After; bans back off exponentially per site.
      const wait = outcome.retryAfterMs || Math.min(banMaxMs, banBaseMs * 2 ** (s.strikes - 1));
      s.bannedUntil = now() + wait;
      h.consecutiveErrors = 0;
    } else if (outcome.kind === 'error') {
      h.errors++;
      h.consecutiveErrors++;
      if (h.consecutiveErrors >= deadAfter) {
        h.deadUntil = now() + banMaxMs;
        h.consecutiveErrors = 0;
      }
    }
  }

  function status(url) {
    const site = url ? siteOf(url) : '';
    const t = now();
    return proxies.map((p) => {
      const h = health.get(p.id);
      const s = site ? h.sites[site] : null;
      return {
        id: p.id,
        type: p.type,
        country: p.country,
        sticky: p.sticky,
        ok: h.ok,
        fail: h.fail,
        errors: h.errors,
        used: h.used,
        bytes: h.bytes,
        latencyMs: h.latencyMs,
        successRate: h.ok + h.fail + h.errors ? +(h.ok / (h.ok + h.fail + h.errors)).toFixed(3) : null,
        dead: h.deadUntil > t,
        bannedOn: Object.entries(h.sites).filter(([, v]) => v.bannedUntil > t).map(([k]) => k),
        ...(s ? { siteOk: s.ok, siteFail: s.fail, bannedHere: s.bannedUntil > t } : {}),
      };
    });
  }

  function snapshot() {
    const out = {};
    for (const [id, h] of health) {
      out[id] = { ok: h.ok, fail: h.fail, errors: h.errors, deadUntil: h.deadUntil, latencyMs: h.latencyMs, used: h.used, bytes: h.bytes, sites: h.sites };
    }
    return out;
  }

  function types() {
    return new Set(proxies.map((p) => p.type));
  }

  /** Clear bans and dead flags (CLI "proxies reset"). */
  function reset() {
    for (const h of health.values()) {
      h.deadUntil = 0;
      h.consecutiveErrors = 0;
      for (const s of Object.values(h.sites)) {
        s.bannedUntil = 0;
        s.strikes = 0;
      }
    }
  }

  return { proxies, pick, report, status, snapshot, types, reset, get size() { return proxies.length; } };
}
