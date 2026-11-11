// Minimal cookie jar: enough to keep anti-bot clearance cookies (cf_clearance, datadome, _px*, _abck)
// and session cookies across requests of one session. Domain/path/expiry/secure are respected.

export function createCookieJar(now = () => Date.now()) {
  /** @type {Map<string, {name, value, domain, path, expires, secure, hostOnly}>} */
  const store = new Map();
  const key = (c) => `${c.domain}|${c.path}|${c.name}`;

  function setFromHeader(header, url) {
    const u = new URL(url);
    const parts = String(header).split(';').map((s) => s.trim());
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    if (eq < 1) return;
    const c = { name: nv.slice(0, eq).trim(), value: nv.slice(eq + 1).trim(), domain: u.hostname, path: '/', expires: 0, secure: false, hostOnly: true };
    for (const a of attrs) {
      const [k, ...rest] = a.split('=');
      const v = rest.join('=').trim();
      const kl = k.trim().toLowerCase();
      if (kl === 'domain' && v) {
        c.domain = v.replace(/^\./, '').toLowerCase();
        c.hostOnly = false;
      } else if (kl === 'path' && v) c.path = v;
      else if (kl === 'expires' && v) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) c.expires = t;
      } else if (kl === 'max-age' && v) c.expires = now() + Number(v) * 1000;
      else if (kl === 'secure') c.secure = true;
    }
    // Ignore cookies for unrelated domains.
    if (!c.hostOnly && !(u.hostname === c.domain || u.hostname.endsWith(`.${c.domain}`))) return;
    if (c.expires && c.expires <= now()) store.delete(key(c));
    else store.set(key(c), c);
  }

  function setFromResponse(headers, url) {
    const raw = headers?.['set-cookie'];
    if (!raw) return;
    for (const h of Array.isArray(raw) ? raw : [raw]) setFromHeader(h, url);
  }

  /** Import cookies from Puppeteer (page.cookies()). */
  function importBrowserCookies(list) {
    for (const c of list || []) {
      const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
      if (!domain || !c.name) continue;
      store.set(key({ domain, path: c.path || '/', name: c.name }), {
        name: c.name,
        value: c.value,
        domain,
        path: c.path || '/',
        expires: c.expires && c.expires > 0 ? Math.round(c.expires * 1000) : 0,
        secure: Boolean(c.secure),
        hostOnly: !String(c.domain).startsWith('.'),
      });
    }
  }

  function matching(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const t = now();
    return [...store.values()].filter((c) => {
      if (c.expires && c.expires <= t) return false;
      if (c.secure && u.protocol !== 'https:') return false;
      const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
      return domainOk && u.pathname.startsWith(c.path);
    });
  }

  function header(url) {
    return matching(url).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Puppeteer-ready cookie objects (to seed a browser page with an existing session). */
  function toBrowserCookies(url) {
    return matching(url).map((c) => ({ name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path, secure: c.secure, ...(c.expires ? { expires: c.expires / 1000 } : {}) }));
  }

  function names(url) {
    return matching(url).map((c) => c.name);
  }

  return { setFromHeader, setFromResponse, importBrowserCookies, header, toBrowserCookies, names, clear: () => store.clear(), get size() { return store.size; } };
}
