// Fast engine: Axios through HTTP(S)/SOCKS proxy agents with browser-like headers and a cookie jar.
// Redirects are followed by hand so cookies set on 30x hops (clearance cookies often are) are kept,
// and bodies are decompressed here so we know the real bytes paid for on metered proxies.
import axios from 'axios';
import zlib from 'node:zlib';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import http from 'node:http';
import https from 'node:https';

const agentCache = new Map();
const directHttp = new http.Agent({ keepAlive: true });
const directHttps = new https.Agent({ keepAlive: true });

export const SUPPORTS_ZSTD = typeof zlib.zstdDecompressSync === 'function';

function agentsFor(proxyUrl) {
  if (!proxyUrl) return { httpAgent: directHttp, httpsAgent: directHttps };
  let a = agentCache.get(proxyUrl);
  if (!a) {
    if (/^socks/i.test(proxyUrl)) {
      const s = new SocksProxyAgent(proxyUrl.replace(/^socks:/i, 'socks5:'), { keepAlive: true });
      a = { httpAgent: s, httpsAgent: s };
    } else {
      a = { httpAgent: new HttpProxyAgent(proxyUrl, { keepAlive: true }), httpsAgent: new HttpsProxyAgent(proxyUrl, { keepAlive: true }) };
    }
    agentCache.set(proxyUrl, a);
    if (agentCache.size > 500) {
      const [oldKey, old] = agentCache.entries().next().value;
      agentCache.delete(oldKey);
      old.httpAgent.destroy?.();
      old.httpsAgent.destroy?.();
    }
  }
  return a;
}

export function closeAgents() {
  for (const a of agentCache.values()) {
    a.httpAgent.destroy?.();
    a.httpsAgent.destroy?.();
  }
  agentCache.clear();
  directHttp.destroy();
  directHttps.destroy();
}

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!buf.length || !enc || enc === 'identity') return buf;
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (enc.includes('deflate')) {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
    if (enc.includes('zstd') && SUPPORTS_ZSTD) return zlib.zstdDecompressSync(buf);
  } catch {
    /* wrong header from server: return raw bytes */
  }
  return buf;
}

function decodeText(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const sniff = buf.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1];
  }
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * @param {{url:string, method?:string, headers?:object, data?:any, proxyUrl?:string|null,
 *          jar?:ReturnType<import('../cookies.js').createCookieJar>, timeoutMs?:number, maxRedirects?:number}} req
 */
export async function httpRequest(req) {
  const t0 = Date.now();
  const { httpAgent, httpsAgent } = agentsFor(req.proxyUrl);
  let url = req.url;
  let method = (req.method || 'GET').toUpperCase();
  let data = req.data;
  let bytes = 0;
  const redirects = [];
  const maxRedirects = req.maxRedirects ?? 8;
  const baseHeaders = { ...(req.headers || {}) };
  if (!SUPPORTS_ZSTD && baseHeaders['accept-encoding']) baseHeaders['accept-encoding'] = baseHeaders['accept-encoding'].replace(/,\s*zstd/, '');
  else if (SUPPORTS_ZSTD && baseHeaders['accept-encoding'] && /chrome|edge/i.test(baseHeaders['user-agent'] || '') && !/zstd/.test(baseHeaders['accept-encoding'])) {
    baseHeaders['accept-encoding'] += ', zstd';
  }

  for (let hop = 0; ; hop++) {
    const headers = { ...baseHeaders };
    const cookie = req.jar?.header(url);
    if (cookie) headers.cookie = cookie;
    const res = await axios.request({
      url,
      method,
      data,
      headers,
      httpAgent,
      httpsAgent,
      proxy: false,
      timeout: req.timeoutMs || 25000,
      signal: AbortSignal.timeout((req.timeoutMs || 25000) + 2000),
      maxRedirects: 0,
      decompress: false,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      maxContentLength: 50 * 1024 * 1024,
    });
    const raw = Buffer.from(res.data || []);
    const resHeaders = typeof res.headers?.toJSON === 'function' ? res.headers.toJSON() : { ...res.headers };
    bytes += raw.length + estimateHeaderBytes(resHeaders);
    req.jar?.setFromResponse(resHeaders, url);
    const loc = resHeaders.location;
    if (res.status >= 300 && res.status < 400 && loc && hop < maxRedirects) {
      const next = new URL(loc, url).toString();
      redirects.push({ status: res.status, from: url, to: next });
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        data = undefined;
      }
      baseHeaders.referer = url;
      url = next;
      continue;
    }
    const body = decompress(raw, resHeaders['content-encoding']);
    const contentType = resHeaders['content-type'] || '';
    const isText = !contentType || /text|json|xml|javascript|html/i.test(contentType);
    return {
      status: res.status,
      headers: resHeaders,
      body: isText ? decodeText(body, contentType) : body.toString('base64'),
      encoding: isText ? 'utf8' : 'base64',
      contentType,
      finalUrl: url,
      redirects,
      bytes,
      ms: Date.now() - t0,
    };
  }
}

function estimateHeaderBytes(headers = {}) {
  let n = 20;
  for (const [k, v] of Object.entries(headers)) n += k.length + String(v).length + 4;
  return n;
}
