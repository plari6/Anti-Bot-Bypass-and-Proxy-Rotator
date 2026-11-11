// REST gateway: lets any scraper, n8n / Make workflow or Python script use the rotator over HTTP.
//   GET  /health
//   GET  /v1/fetch?url=...&render=1&country=de&session=abc&must_contain=Price&wait_for=.price&raw=1&fields=title=h1,price=.price
//   POST /v1/fetch  { url, render, country, session, mustContain, waitForSelector, fields: ["title=h1"], method, headers, data, raw }
//   GET  /v1/stats     per-site success, blocks by vendor, bandwidth and spend
//   GET  /v1/proxies   proxy health
// Auth: header "x-api-key: <API_KEY>" or ?api_key= (required when API_KEY is set).
import http from 'node:http';
import crypto from 'node:crypto';
import { extractFields, parseFieldSpecs } from './extract.js';
import { semaphore } from './util.js';
import { siteReport } from './report.js';

function send(res, status, body, headers = {}) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(json);
}

async function readBody(req, max = 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('body must be JSON'), { status: 400 });
  }
}

const truthy = (v) => v === true || /^(1|true|yes)$/i.test(String(v ?? ''));

export function createServer(fetcher, { apiKey = fetcher.settings.apiKey, maxQueue = 200 } = {}) {
  const limit = semaphore(fetcher.settings.concurrency || 4);
  const keyBuf = apiKey ? Buffer.from(apiKey) : null;

  function authorized(req, url) {
    if (!keyBuf) return true;
    const given = Buffer.from(String(req.headers['x-api-key'] || url.searchParams.get('api_key') || ''));
    return given.length === keyBuf.length && crypto.timingSafeEqual(given, keyBuf);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true, proxies: fetcher.pool.size, queue: limit.pending });
      if (!authorized(req, url)) return send(res, 401, { ok: false, error: 'missing or wrong API key' });

      if (url.pathname === '/v1/stats') return send(res, 200, siteReport(fetcher.state.data));
      if (url.pathname === '/v1/proxies') return send(res, 200, { proxies: fetcher.pool.status(url.searchParams.get('url') || undefined) });

      if (url.pathname === '/v1/fetch' && (req.method === 'GET' || req.method === 'POST')) {
        const q = Object.fromEntries(url.searchParams);
        const b = req.method === 'POST' ? await readBody(req) : {};
        const target = b.url || q.url;
        if (!target || !/^https?:\/\//i.test(target)) return send(res, 400, { ok: false, error: 'url (http or https) is required' });
        if (limit.pending >= maxQueue) return send(res, 503, { ok: false, error: 'queue full, retry later' }, { 'retry-after': '5' });
        const fieldsRaw = b.fields || (q.fields ? q.fields.split(/,(?=\s*\w+=)/) : []);
        const fields = parseFieldSpecs(fieldsRaw);
        const opts = {
          render: truthy(b.render ?? q.render),
          country: b.country || q.country || undefined,
          session: b.session || q.session || undefined,
          mustContain: b.mustContain || q.must_contain || undefined,
          waitForSelector: b.waitForSelector || q.wait_for || undefined,
          method: b.method || 'GET',
          headers: b.headers,
          data: b.data,
          referer: b.referer || q.referer || undefined,
        };
        const r = await limit(() => fetcher.fetch(target, opts));
        const raw = truthy(b.raw ?? q.raw);
        if (raw && r.ok) {
          const body = r.encoding === 'base64' ? Buffer.from(r.body, 'base64') : r.body;
          res.writeHead(r.status, {
            'content-type': r.contentType || 'text/html; charset=utf-8',
            'x-antibot-step': r.step,
            'x-antibot-proxy-type': r.proxyType,
            'x-antibot-attempts': String(r.attempts.length),
            'x-antibot-final-url': encodeURI(r.finalUrl || target),
          });
          return res.end(body);
        }
        const payload = {
          ok: r.ok,
          url: target,
          finalUrl: r.finalUrl,
          status: r.status ?? null,
          step: r.step,
          proxyType: r.proxyType,
          protection: r.protection || [],
          attempts: r.attempts,
          bytes: r.bytes,
          costUsd: r.costUsd,
          ms: r.ms,
          error: r.ok ? undefined : r.error,
          block: r.block ? { vendor: r.block.vendor, kind: r.block.kind, reason: r.block.reason } : undefined,
          fields: r.ok && fields.length ? extractFields(r.body, fields, r.finalUrl || target) : undefined,
          body: r.ok && !truthy(b.noBody ?? q.no_body) ? r.body : undefined,
          encoding: r.ok ? r.encoding : undefined,
        };
        return send(res, r.ok ? 200 : 502, payload);
      }
      return send(res, 404, { ok: false, error: 'not found', endpoints: ['/health', '/v1/fetch', '/v1/stats', '/v1/proxies'] });
    } catch (err) {
      return send(res, err.status || 500, { ok: false, error: err.message });
    }
  });
  server.requestTimeout = 0; // browser fetches can be slow; each fetch has its own timeouts
  return server;
}
