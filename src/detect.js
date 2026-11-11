// Recognises anti-bot responses so the fetcher can react correctly instead of saving a captcha page
// as data. Every verdict says WHO blocked (vendor), WHAT kind of block it is, and what helps:
//   challenge   - JavaScript / device check. A real browser usually passes it  -> escalate to browser
//   captcha     - interactive puzzle. Usually means the IP/fingerprint is distrusted -> new residential IP + browser
//   ban         - IP or fingerprint refused (403 / 1020 / Access Denied) -> new IP, better proxy type
//   rate_limit  - too many requests (429 / 1015) -> wait Retry-After, slow down, other IP
//   soft        - 200 OK but the page is empty or misses the content you expect -> retry other IP / browser

const SIGNATURES = [
  // ---- Cloudflare
  { vendor: 'cloudflare', kind: 'challenge', header: ['cf-mitigated', /challenge/i] },
  { vendor: 'cloudflare', kind: 'challenge', body: /<title>\s*(just a moment|un instant|einen moment|un momento|checking your browser)[^<]*<\/title>|_cf_chl_opt|window\._cf_chl|cdn-cgi\/challenge-platform\/h\/[bg]\/orchestrate/i },
  { vendor: 'cloudflare', kind: 'rate_limit', body: /error code:?\s*1015|you are being rate limited/i },
  { vendor: 'cloudflare', kind: 'ban', body: /error code:?\s*10(0[5-9]|1[0-2]|20)\b|access denied \| [^<]* used cloudflare|cf-error-details[\s\S]{0,400}(1020|access denied)/i },
  { vendor: 'cloudflare', kind: 'captcha', body: /<title>\s*attention required! \| cloudflare/i },
  // ---- DataDome
  { vendor: 'datadome', kind: 'challenge', body: /'rt'\s*:\s*'i'|"rt"\s*:\s*"i"/, statusMin: 400 },
  { vendor: 'datadome', kind: 'captcha', body: /(geo|ct|c)\.captcha-delivery\.com|<script[^>]*>\s*var dd\s*=/i, statusMin: 400 },
  { vendor: 'datadome', kind: 'ban', header: ['x-datadome', /./], statusMin: 401 },
  // ---- PerimeterX / HUMAN
  { vendor: 'perimeterx', kind: 'captcha', body: /px-captcha|_pxCaptcha|press (&amp;|&) hold|human challenge/i },
  { vendor: 'perimeterx', kind: 'ban', body: /window\._pxAppId|\/_px\/|captcha\.px-cdn\.net/i, statusMin: 403 },
  // ---- Akamai Bot Manager
  { vendor: 'akamai', kind: 'ban', body: /<title>\s*access denied\s*<\/title>[\s\S]*(errors\.edgesuite\.net|reference\s*#\s*[\d.a-f]+)/i },
  { vendor: 'akamai', kind: 'challenge', body: /bm-verify|_sec\/cp_challenge|sec-if-cpt-container/i },
  // ---- Imperva / Incapsula
  { vendor: 'imperva', kind: 'challenge', body: /_Incapsula_Resource|incapsula incident id|Request unsuccessful\. Incapsula/i },
  // ---- AWS WAF
  { vendor: 'aws-waf', kind: 'captcha', header: ['x-amzn-waf-action', /captcha/i] },
  { vendor: 'aws-waf', kind: 'challenge', header: ['x-amzn-waf-action', /challenge/i] },
  { vendor: 'aws-waf', kind: 'challenge', body: /awswaf\.com|AwsWafIntegration|gokuProps/i, statusMin: 202 },
  // ---- Kasada
  { vendor: 'kasada', kind: 'challenge', header: ['x-kpsdk-ct', /./], statusMin: 400 },
  { vendor: 'kasada', kind: 'challenge', body: /KPSDK|\/ips\.js\?/, statusMin: 400 },
  // ---- Sucuri
  { vendor: 'sucuri', kind: 'ban', body: /sucuri website firewall - access denied|sucuri_cloudproxy_js/i },
  // ---- Site-specific bot walls
  { vendor: 'amazon', kind: 'captcha', body: /\/errors\/validateCaptcha|to discuss automated access to amazon data|type the characters you see in this image/i },
  { vendor: 'google', kind: 'captcha', body: /our systems have detected unusual traffic|\/sorry\/index\?continue=/i },
  // ---- Generic captchas on an error page
  { vendor: 'captcha', kind: 'captcha', body: /g-recaptcha|hcaptcha\.com\/1\/api|challenges\.cloudflare\.com\/turnstile|verify (that )?you are (a )?human|are you a robot|i'?m not a robot/i, statusMin: 400 },
  { vendor: 'captcha', kind: 'captcha', body: /<title>[^<]*(captcha|robot check|bot check|security check|verify you are human)[^<]*<\/title>/i },
];

/** Which protection products a site uses, even when this response passed. */
const PRESENCE = [
  { vendor: 'cloudflare', test: (h, b, c) => h['cf-ray'] || /cloudflare/i.test(h.server || '') || c.some((n) => /^(__cf_bm|cf_clearance|__cflb)$/.test(n)) || /cdn-cgi\/challenge-platform/.test(b) },
  { vendor: 'datadome', test: (h, b, c) => h['x-datadome'] || h['x-dd-b'] || /datadome/i.test(h.server || '') || c.includes('datadome') || /js\.datadome\.co|captcha-delivery\.com/.test(b) },
  { vendor: 'perimeterx', test: (h, b, c) => c.some((n) => /^_px/.test(n)) || /_pxAppId|client\.perimeterx\.net|px-cdn\.net/.test(b) },
  { vendor: 'akamai', test: (h, b, c) => /akamai/i.test(h.server || '') || c.some((n) => /^(_abck|ak_bmsc|bm_sz|bm_sv)$/.test(n)) },
  { vendor: 'imperva', test: (h, b, c) => c.some((n) => /^(incap_ses_|visid_incap_|nlbi_)/.test(n)) || /_Incapsula_Resource/.test(b) || /incapsula/i.test(h['x-cdn'] || '') },
  { vendor: 'aws-waf', test: (h, b, c) => h['x-amzn-waf-action'] || c.includes('aws-waf-token') || /awswaf/.test(b) },
  { vendor: 'kasada', test: (h, b) => h['x-kpsdk-ct'] || /KPSDK/.test(b) },
  { vendor: 'sucuri', test: (h) => /sucuri/i.test(h.server || '') || h['x-sucuri-id'] },
  { vendor: 'recaptcha', test: (h, b) => /google\.com\/recaptcha|g-recaptcha/.test(b) },
  { vendor: 'hcaptcha', test: (h, b) => /hcaptcha\.com/.test(b) },
  { vendor: 'turnstile', test: (h, b) => /challenges\.cloudflare\.com\/turnstile/.test(b) },
];

const lower = (headers = {}) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join('\n') : String(v ?? '')]));

function cookieNames(h) {
  return String(h['set-cookie'] || '')
    .split('\n')
    .map((c) => c.split('=')[0].trim())
    .filter(Boolean);
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.min(3600000, Math.max(0, n * 1000));
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : Math.min(3600000, Math.max(0, t - now));
}

/**
 * @param {{status:number, headers?:object, body?:string, url?:string}} res
 * @param {{mustContain?: string|RegExp, minBytes?: number, extraCookies?: string[]}} opts
 */
export function detectBlock(res, opts = {}) {
  const status = Number(res.status) || 0;
  const h = lower(res.headers);
  const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
  // Only the start of the document matters for interstitials; keeps regexes fast on big pages.
  const head = body.length > 200000 ? body.slice(0, 120000) + body.slice(-20000) : body;
  const cookies = [...cookieNames(h), ...(opts.extraCookies || [])];
  const presence = PRESENCE.filter((p) => p.test(h, head, cookies)).map((p) => p.vendor);

  const verdict = (blocked, extra = {}) => ({ blocked, status, presence, vendor: null, kind: null, reason: '', retryAfterMs: 0, ...extra });

  for (const sig of SIGNATURES) {
    if (sig.statusMin && status < sig.statusMin) continue;
    let hit = false;
    if (sig.header) {
      const v = h[sig.header[0]];
      hit = v !== undefined && sig.header[1].test(v);
    }
    if (!hit && sig.body) hit = sig.body.test(head);
    if (hit) {
      // A 200 page that merely *contains* a vendor script is not a block, unless it is clearly an interstitial.
      if (status >= 200 && status < 300 && !sig.header && head.length > 60000 && sig.kind !== 'captcha') continue;
      return verdict(true, {
        vendor: sig.vendor,
        kind: sig.kind,
        reason: `${sig.vendor} ${sig.kind}${status ? ` (HTTP ${status})` : ''}`,
        retryAfterMs: sig.kind === 'rate_limit' ? parseRetryAfter(h['retry-after']) || 30000 : 0,
      });
    }
  }

  if (status === 429) {
    return verdict(true, { vendor: presence[0] || 'origin', kind: 'rate_limit', reason: 'HTTP 429 rate limited', retryAfterMs: parseRetryAfter(h['retry-after']) || 30000 });
  }
  if (status === 401 || status === 403 || status === 407 || status === 451) {
    if (status === 407) return verdict(true, { vendor: 'proxy', kind: 'proxy_auth', reason: 'HTTP 407 proxy authentication failed' });
    return verdict(true, { vendor: presence[0] || 'origin', kind: 'ban', reason: `HTTP ${status} access denied` });
  }
  if (status >= 200 && status < 400) {
    const min = opts.minBytes ?? 0;
    if (min && Buffer.byteLength(body) < min) return verdict(true, { vendor: presence[0] || 'origin', kind: 'soft', reason: `page too small (${Buffer.byteLength(body)} B < ${min} B)` });
    if (opts.mustContain) {
      const ok = opts.mustContain instanceof RegExp ? opts.mustContain.test(body) : body.includes(String(opts.mustContain));
      if (!ok) return verdict(true, { vendor: presence[0] || 'origin', kind: 'soft', reason: `expected content not found (${opts.mustContain})` });
    }
  }
  return verdict(false);
}

/** Should the next attempt use a stronger engine/proxy type rather than just another IP? */
export function shouldEscalate(v) {
  if (!v?.blocked) return false;
  return ['challenge', 'captcha', 'ban', 'soft'].includes(v.kind);
}
