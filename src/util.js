// Small helpers shared by every module.
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Random value in [ms * (1 - spread), ms * (1 + spread)]. */
export function jitter(ms, spread = 0.35) {
  return Math.round(ms * (1 - spread + Math.random() * spread * 2));
}

export function randomId(len = 10) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

/** Registrable-ish host used as the "site" key (www. stripped). */
export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Concurrency limiter: limit(fn) runs at most `max` fns at once. */
export function semaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  const limit = (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
  Object.defineProperty(limit, 'pending', { get: () => queue.length + active });
  return limit;
}

/** Hide credentials before a proxy URL is logged or returned by the API. */
export function maskProxy(url) {
  if (!url) return 'direct';
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? `${decodeURIComponent(u.username).slice(0, 4)}***` : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).replace(/:[^:@/]+@/, ':***@');
  }
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function parseDuration(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  return Math.round(n * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit]);
}

export function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
