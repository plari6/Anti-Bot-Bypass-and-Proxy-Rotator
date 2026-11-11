// Turns the many proxy list formats sold by providers into one shape:
// { id, url, type, country, costPerGb, sticky, label }
//
// Accepted lines (txt) or entries (json):
//   http://user:pass@host:port            socks5://host:port         host:port
//   host:port:user:pass                   user:pass@host:port
//   http://user-session-{session}-country-{country}:pass@gate.example.com:7000   (rotating gateway)
// Optional tags after a space or "#": type=residential country=us cost=4.5
//   e.g.  http://u:p@1.2.3.4:8080 type=datacenter cost=0.5
import fs from 'node:fs';

const TYPES = new Set(['datacenter', 'residential', 'mobile', 'isp']);

export function normalizeProxyUrl(raw) {
  let s = String(raw).trim();
  if (!s) throw new Error('empty proxy');
  if (/^[a-z0-9]+:\/\//i.test(s)) {
    const u = new URL(s.replace(/\{(\w+)\}/g, 'PLACEHOLDER$1')); // validate even with templates
    if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks:', 'socks5h:'].includes(u.protocol)) throw new Error(`unsupported proxy protocol ${u.protocol}`);
    // URL drops default ports (http :80), so check the raw text too.
    if (!u.port && !/:\d+\/?$/.test(s)) throw new Error(`proxy has no port: ${s}`);
    return s;
  }
  if (s.includes('@')) return normalizeProxyUrl(`http://${s}`);
  const parts = s.split(':');
  if (parts.length === 2) return normalizeProxyUrl(`http://${parts[0]}:${parts[1]}`);
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    // host:port:user:pass is the common export format; user:pass:host:port also appears.
    if (/^\d+$/.test(port)) return normalizeProxyUrl(`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`);
    if (/^\d+$/.test(parts[3])) return normalizeProxyUrl(`http://${encodeURIComponent(parts[0])}:${encodeURIComponent(parts[1])}@${parts[2]}:${parts[3]}`);
  }
  throw new Error(`cannot parse proxy "${s}"`);
}

function guessType(url) {
  const host = (() => {
    try {
      return new URL(url.replace(/\{(\w+)\}/g, 'x')).hostname;
    } catch {
      return '';
    }
  })();
  // Well-known residential/mobile gateways. Anything else defaults to datacenter.
  if (/mobile|4g|5g|lte/i.test(host)) return 'mobile';
  if (/brd\.superproxy|brightdata|oxylabs|pr\.oxylabs|smartproxy|decodo|iproyal|soax|netnut|packetstream|geonode|proxyempire|rayobyte|webshare.*resi|residential|resi\./i.test(host)) return 'residential';
  return 'datacenter';
}

function parseTags(text) {
  const tags = {};
  for (const m of String(text || '').matchAll(/(\w+)=([^\s,]+)/g)) tags[m[1].toLowerCase()] = m[2];
  return tags;
}

export function makeProxy(entry, index = 0) {
  const obj = typeof entry === 'string' ? lineToEntry(entry) : { ...entry };
  if (!obj) return null;
  const url = normalizeProxyUrl(obj.url || obj.proxy || obj.server);
  const type = String(obj.type || guessType(url)).toLowerCase();
  if (!TYPES.has(type)) throw new Error(`proxy type must be datacenter, residential, mobile or isp (got "${type}")`);
  return {
    id: obj.id || `${type.slice(0, 3)}-${index + 1}`,
    url,
    type,
    country: obj.country ? String(obj.country).toLowerCase() : '',
    costPerGb: Number(obj.costPerGb ?? obj.cost ?? defaultCost(type)),
    sticky: /\{session\}/.test(url), // gateway: every session gets a fresh exit IP
    label: obj.label || '',
  };
}

function defaultCost(type) {
  // Typical 2026 list prices in USD per GB, used only for the cost report.
  return { datacenter: 0.5, isp: 2, residential: 4, mobile: 9 }[type] ?? 0;
}

function lineToEntry(line) {
  const clean = line.replace(/\r/g, '').trim();
  if (!clean || clean.startsWith('#') || clean.startsWith('//')) return null;
  const [first, ...rest] = clean.split(/\s+/);
  const tags = parseTags(rest.join(' ').replace(/^#/, ''));
  return { url: first, type: tags.type, country: tags.country, cost: tags.cost, id: tags.id, label: tags.label };
}

/** Parse text (txt lines or JSON array) into proxy objects. Bad lines are reported, not fatal. */
export function parseProxyList(text) {
  const errors = [];
  const out = [];
  const trimmed = String(text || '').trim();
  if (!trimmed) return { proxies: out, errors };
  let entries;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    entries = Array.isArray(json) ? json : json.proxies || [];
  } else {
    entries = trimmed.split(/\n|,(?=\s*(?:[a-z0-9]+:\/\/|[\w.-]+:\d))/i);
  }
  entries.forEach((e) => {
    try {
      const p = makeProxy(e, out.length);
      if (p) out.push(p);
    } catch (err) {
      errors.push(`${typeof e === 'string' ? e.trim() : JSON.stringify(e)} -> ${err.message}`);
    }
  });
  // Unique ids even when the file mixes tagged and untagged lines.
  const seen = new Map();
  for (const p of out) {
    const n = seen.get(p.id) || 0;
    seen.set(p.id, n + 1);
    if (n) p.id = `${p.id}-${n + 1}`;
  }
  return { proxies: out, errors };
}

export function loadProxies(settings) {
  let text = '';
  if (settings.proxyFile) {
    if (!fs.existsSync(settings.proxyFile)) throw new Error(`PROXY_FILE not found: ${settings.proxyFile}`);
    text = fs.readFileSync(settings.proxyFile, 'utf8');
  }
  const fromFile = parseProxyList(text);
  const fromEnv = parseProxyList(settings.proxies || '');
  const proxies = [...fromFile.proxies];
  for (const p of fromEnv.proxies) {
    if (proxies.some((x) => x.id === p.id)) p.id = `${p.id}-env`;
    proxies.push(p);
  }
  return { proxies, errors: [...fromFile.errors, ...fromEnv.errors] };
}

/** Fill {session} / {country} placeholders for one concrete connection. */
export function resolveProxyUrl(proxy, { session = '', country = '' } = {}) {
  if (!proxy) return null;
  return proxy.url
    .replace(/\{session\}/g, session || 'default')
    .replace(/\{country\}/g, (country || proxy.country || 'us').toLowerCase());
}
