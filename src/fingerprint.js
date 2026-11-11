// Consistent browser header profiles. Anti-bot systems compare the User-Agent with sec-ch-ua,
// platform, Accept and Accept-Language; a mismatch is an instant flag. One profile is kept for
// the whole session (same proxy + same cookies + same headers), like one real visitor.

const DAY = 86400000;

/** Current stable major version, estimated from the 4-week release train (overridable). */
export function chromeMajor(date = new Date()) {
  if (process.env.CHROME_VERSION) return Number(process.env.CHROME_VERSION);
  return 131 + Math.floor((date - Date.UTC(2024, 10, 12)) / (28 * DAY));
}
export function firefoxMajor(date = new Date()) {
  return 133 + Math.floor((date - Date.UTC(2024, 10, 26)) / (28 * DAY));
}

const LANG_BY_COUNTRY = {
  us: 'en-US,en;q=0.9', gb: 'en-GB,en;q=0.9', uk: 'en-GB,en;q=0.9', ca: 'en-CA,en;q=0.9,fr-CA;q=0.8', au: 'en-AU,en;q=0.9',
  de: 'de-DE,de;q=0.9,en;q=0.8', at: 'de-AT,de;q=0.9,en;q=0.8', ch: 'de-CH,de;q=0.9,fr;q=0.8,en;q=0.7',
  fr: 'fr-FR,fr;q=0.9,en;q=0.8', be: 'fr-BE,fr;q=0.9,nl;q=0.8,en;q=0.7', es: 'es-ES,es;q=0.9,en;q=0.8',
  it: 'it-IT,it;q=0.9,en;q=0.8', nl: 'nl-NL,nl;q=0.9,en;q=0.8', pt: 'pt-PT,pt;q=0.9,en;q=0.8', br: 'pt-BR,pt;q=0.9,en;q=0.8',
  ma: 'fr-MA,fr;q=0.9,ar;q=0.8,en;q=0.7', ae: 'en-AE,en;q=0.9,ar;q=0.8', sa: 'ar-SA,ar;q=0.9,en;q=0.8', mx: 'es-MX,es;q=0.9,en;q=0.8',
};

export function acceptLanguageFor(country) {
  return LANG_BY_COUNTRY[String(country || '').toLowerCase()] || 'en-US,en;q=0.9';
}

const PROFILES = [
  { name: 'chrome-windows', weight: 46, family: 'chrome', platform: 'Windows', os: 'Windows NT 10.0; Win64; x64' },
  { name: 'chrome-mac', weight: 18, family: 'chrome', platform: 'macOS', os: 'Macintosh; Intel Mac OS X 10_15_7' },
  { name: 'edge-windows', weight: 14, family: 'edge', platform: 'Windows', os: 'Windows NT 10.0; Win64; x64' },
  { name: 'chrome-linux', weight: 4, family: 'chrome', platform: 'Linux', os: 'X11; Linux x86_64' },
  { name: 'firefox-windows', weight: 12, family: 'firefox', platform: 'Windows', os: 'Windows NT 10.0; Win64; x64' },
  { name: 'firefox-mac', weight: 6, family: 'firefox', platform: 'macOS', os: 'Macintosh; Intel Mac OS X 10.15' },
];

function brands(major, family) {
  const name = family === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
  return `"Chromium";v="${major}", "Not_A Brand";v="24", "${name}";v="${major}"`;
}

/** Build a header profile. `family` can force chrome/firefox/edge (the browser engine always is Chrome). */
export function createFingerprint({ country = '', family, userAgent } = {}) {
  if (userAgent) return fromUserAgent(userAgent, country);
  const pool = family ? PROFILES.filter((p) => p.family === family) : PROFILES;
  let r = Math.random() * pool.reduce((a, p) => a + p.weight, 0);
  let prof = pool[0];
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) {
      prof = p;
      break;
    }
  }
  const lang = acceptLanguageFor(country);
  if (prof.family === 'firefox') {
    const v = firefoxMajor();
    return {
      name: prof.name,
      family: 'firefox',
      userAgent: `Mozilla/5.0 (${prof.os}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
      headers: {
        'user-agent': `Mozilla/5.0 (${prof.os}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': lang,
        'accept-encoding': 'gzip, deflate, br',
        'upgrade-insecure-requests': '1',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        priority: 'u=0, i',
        te: 'trailers',
      },
    };
  }
  const v = chromeMajor();
  const edge = prof.family === 'edge' ? ` Edg/${v}.0.0.0` : '';
  const ua = `Mozilla/5.0 (${prof.os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36${edge}`;
  return {
    name: prof.name,
    family: prof.family,
    userAgent: ua,
    headers: chromeHeaders(ua, v, prof.family, prof.platform, lang),
  };
}

function chromeHeaders(ua, v, family, platform, lang) {
  return {
    'sec-ch-ua': brands(v, family),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`,
    'upgrade-insecure-requests': '1',
    'user-agent': ua,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': lang,
    priority: 'u=0, i',
  };
}

/** Profile that matches a real browser's UA, used after the browser cleared a challenge. */
export function fromUserAgent(ua, country = '') {
  const lang = acceptLanguageFor(country);
  const chrome = ua.match(/Chrome\/(\d+)/);
  if (chrome) {
    const v = Number(chrome[1]);
    const platform = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : 'Linux';
    const family = /Edg\//.test(ua) ? 'edge' : 'chrome';
    return { name: `${family}-from-browser`, family, userAgent: ua, headers: chromeHeaders(ua, v, family, platform, lang) };
  }
  return {
    name: 'custom',
    family: 'other',
    userAgent: ua,
    headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': lang, 'accept-encoding': 'gzip, deflate, br' },
  };
}

/** Headers for a follow-up request inside the same site (referer + same-origin fetch metadata). */
export function navigationHeaders(fp, { referer, url } = {}) {
  const h = { ...fp.headers };
  if (referer) {
    h.referer = referer;
    let same = false;
    try {
      same = new URL(referer).origin === new URL(url).origin;
    } catch { /* ignore */ }
    h['sec-fetch-site'] = same ? 'same-origin' : 'cross-site';
  }
  return h;
}
