// Per-site politeness: a concurrency cap plus a jittered minimum gap between request starts.
// After a rate limit the gap for that site grows (x1.6, up to 20x) and shrinks again on success.
import { semaphore, sleep, jitter, siteOf } from './util.js';

export function createDomainLimiter({ delayMs = 1500, concurrency = 2 } = {}) {
  const sites = new Map();
  const get = (site) => {
    let s = sites.get(site);
    if (!s) {
      s = { limit: semaphore(concurrency), nextAt: 0, factor: 1, minDelay: delayMs };
      sites.set(site, s);
    }
    return s;
  };

  /** Run fn inside this site's slot, after waiting for its turn. */
  function run(url, fn) {
    const s = get(siteOf(url));
    return s.limit(async () => {
      const gap = Math.round(s.minDelay * s.factor);
      const wait = s.nextAt - Date.now();
      s.nextAt = Math.max(Date.now(), s.nextAt) + (gap ? jitter(gap) : 0);
      if (wait > 0) await sleep(wait);
      return fn();
    });
  }

  return {
    run,
    slowDown(url) {
      const s = get(siteOf(url));
      s.factor = Math.min(20, s.factor * 1.6);
    },
    speedUp(url) {
      const s = get(siteOf(url));
      s.factor = Math.max(1, s.factor * 0.9);
    },
    /** robots.txt Crawl-delay raises the floor for that site. */
    setMinDelay(url, ms) {
      const s = get(siteOf(url));
      s.minDelay = Math.max(delayMs, ms);
    },
    factor(url) {
      return get(siteOf(url)).factor;
    },
  };
}
