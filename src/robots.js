// robots.txt support (on by default, RESPECT_ROBOTS=false to turn off for sites you are allowed to crawl).
// Longest matching rule wins, Allow beats Disallow on ties, * and $ wildcards, Crawl-delay is read.

export function parseRobots(text, agent = '*') {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') current.rules.push({ allow: key === 'allow', path: value });
    else if (key === 'crawl-delay') current.crawlDelay = Number(value) || 0;
  }
  const a = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const crawlDelay = Math.max(0, ...chosen.map((g) => g.crawlDelay));
  return { rules, crawlDelayMs: crawlDelay * 1000 };
}

function ruleRegex(p) {
  const anchored = p.endsWith('$');
  const core = anchored ? p.slice(0, -1) : p;
  const esc = core.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}${anchored ? '$' : ''}`);
}

export function isAllowed(robots, url) {
  if (!robots) return true;
  const u = new URL(url);
  const target = u.pathname + u.search;
  let best = null;
  for (const r of robots.rules) {
    if (r.path === '') {
      continue; // "Disallow:" with nothing = allow all
    }
    if (ruleRegex(r.path).test(target)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

/** Cached robots per origin. `fetchText(url)` returns {status, body} or throws. */
export function createRobotsCache(fetchText, { agent = '*', ttlMs = 6 * 3600000 } = {}) {
  const cache = new Map();
  async function get(url) {
    const origin = new URL(url).origin;
    const hit = cache.get(origin);
    if (hit && hit.expires > Date.now()) return hit.robots;
    const p = (async () => {
      try {
        const res = await fetchText(`${origin}/robots.txt`);
        if (res.status >= 200 && res.status < 300 && !/<html/i.test(res.body.slice(0, 500))) return parseRobots(res.body, agent);
        return null; // 4xx/5xx or a bot wall instead of robots.txt -> no rules known
      } catch {
        return null;
      }
    })();
    cache.set(origin, { robots: p, expires: Date.now() + ttlMs });
    return p;
  }
  return {
    async check(url) {
      const robots = await get(url);
      return { allowed: isAllowed(robots, url), crawlDelayMs: robots?.crawlDelayMs || 0 };
    },
  };
}
