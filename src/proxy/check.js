// Health check for a proxy list: exit IP, latency, and (optionally) whether a target site accepts it.
// Rotating gateways are checked twice with two session ids to prove the exit IP really changes.
import { httpRequest } from '../engines/http.js';
import { createFingerprint } from '../fingerprint.js';
import { resolveProxyUrl } from './parse.js';
import { detectBlock } from '../detect.js';
import { semaphore, randomId } from '../util.js';

export const DEFAULT_IP_URL = 'https://api.ipify.org?format=json';

function exitIp(body) {
  try {
    const j = JSON.parse(body);
    return j.ip || j.origin || j.query || j.ip_addr || '';
  } catch {
    return (String(body).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/i) || [''])[0];
  }
}

export async function checkProxies(proxies, { ipUrl = DEFAULT_IP_URL, target, timeoutMs = 15000, concurrency = 8, request = httpRequest } = {}) {
  const limit = semaphore(concurrency);
  return Promise.all(proxies.map((p) => limit(async () => {
    const row = { id: p.id, type: p.type, country: p.country, sticky: p.sticky, ok: false, ip: '', latencyMs: null, rotates: null, target: null, error: '' };
    try {
      const s1 = randomId(8);
      const t0 = Date.now();
      const r = await request({ url: ipUrl, proxyUrl: resolveProxyUrl(p, { session: s1 }), headers: { accept: 'application/json' }, timeoutMs });
      row.latencyMs = Date.now() - t0;
      if (r.status === 407) throw new Error('407 proxy authentication failed (check user/password)');
      if (r.status >= 400) throw new Error(`IP check answered HTTP ${r.status}`);
      row.ip = exitIp(r.body);
      row.ok = Boolean(row.ip);
      if (!row.ok) row.error = 'no IP in answer';
      if (p.sticky && row.ok) {
        const r2 = await request({ url: ipUrl, proxyUrl: resolveProxyUrl(p, { session: randomId(8) }), headers: { accept: 'application/json' }, timeoutMs });
        row.rotates = exitIp(r2.body) !== row.ip;
      }
      if (target && row.ok) {
        const fp = createFingerprint({ country: p.country });
        const t = await request({ url: target, proxyUrl: resolveProxyUrl(p, { session: s1 }), headers: fp.headers, timeoutMs });
        const v = detectBlock(t);
        row.target = v.blocked ? `blocked: ${v.reason}` : `ok (HTTP ${t.status})`;
      }
    } catch (err) {
      row.error = String(err.code || '') + (err.code ? ': ' : '') + String(err.message || err).slice(0, 160);
    }
    return row;
  })));
}
