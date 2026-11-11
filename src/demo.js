// Offline playground: a fake "protected" website plus fake proxies on 127.0.0.1, so the whole
// ladder can be shown and tested with no internet, no real proxies and no client data.
//
// Site routes (behaviour depends on which fake proxy the request came through):
//   /open/:id   always works
//   /cf/:id     Cloudflare-like JS challenge: 403 "Just a moment..." until a browser runs the script that
//               sets cf_clearance; the cookie is bound to exit IP + User-Agent, like the real thing
//   /dd/:id     DataDome-like: datacenter IPs get a 403 captcha page, residential/mobile pass
//   /rate/:id   429 + Retry-After after 3 requests per exit IP in 10 s
//   /flaky/:id  every other request answers 503
//   /private/*  disallowed in robots.txt
//   /ip         JSON { ip } of the exit, for "proxies check"
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

function productPage(id, extra = '') {
  const price = (19 + (Number(String(id).replace(/\D/g, '')) || 1) * 3.5).toFixed(2);
  return `<!doctype html><html><head><title>Demo product ${id}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Demo product ${id}","offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD"}}</script>
</head><body><h1>Demo product ${id}</h1><span class="price">$${price}</span><a class="more" href="/open/${id}-more">more</a>
<p>${'Lorem ipsum dolor sit amet. '.repeat(30)}</p>${extra}</body></html>`;
}

function cookieMap(header = '') {
  return Object.fromEntries(String(header).split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
}

const solve = (c) => {
  let x = 0;
  for (let i = 0; i < c.length; i++) x = (x * 31 + c.charCodeAt(i)) % 1000003;
  return String(x);
};

export function startDemoSite() {
  const challenges = new Map(); // challenge -> { exit, ua }
  const clearances = new Set(); // "token|exit|ua"
  const rate = new Map();
  let flaky = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const exit = req.headers['x-demo-exit'] || 'home-ip';
    const type = req.headers['x-demo-type'] || 'home';
    const ua = req.headers['user-agent'] || '';
    const html = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    const [, section, id = '1'] = u.pathname.split('/');

    if (u.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /private\n');
    }
    if (u.pathname === '/ip') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ip: exit, type }));
    }
    if (section === 'open' || section === 'private') return html(200, productPage(id));
    if (section === 'flaky') return ++flaky % 2 ? html(503, '<h1>Service temporarily unavailable</h1>') : html(200, productPage(id));
    if (section === 'rate') {
      const now = Date.now();
      const hits = (rate.get(exit) || []).filter((t) => now - t < 10000);
      hits.push(now);
      rate.set(exit, hits);
      if (hits.length > 3) return html(429, '<h1>Too Many Requests</h1>', { 'retry-after': '2' });
      return html(200, productPage(id));
    }
    if (section === 'dd') {
      if (type === 'datacenter' || type === 'home') {
        return html(403, `<html><head><title>example.com</title></head><body><script>var dd={'rt':'c','cid':'AHrlqAAAAAMA','hsh':'demo','host':'geo.captcha-delivery.com'}</script><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>`, { 'x-datadome': 'protected', 'set-cookie': 'datadome=blocked; Path=/' });
      }
      return html(200, productPage(id), { 'x-dd-b': '1', 'set-cookie': `datadome=${crypto.randomBytes(8).toString('hex')}; Path=/; Max-Age=3600` });
    }
    if (section === 'cf') {
      const cookies = cookieMap(req.headers.cookie);
      const token = cookies.cf_clearance;
      if (token && clearances.has(`${token}|${exit}|${ua}`)) return html(200, productPage(id), { 'cf-ray': `${crypto.randomBytes(8).toString('hex')}-DEMO`, server: 'cloudflare' });
      if (token && challenges.has(token.split('.')[0])) {
        const [c, answer] = token.split('.');
        const ch = challenges.get(c);
        if (answer === solve(c) && ch.exit === exit && ch.ua === ua) {
          clearances.add(`${token}|${exit}|${ua}`);
          return html(200, productPage(id), { 'cf-ray': `${crypto.randomBytes(8).toString('hex')}-DEMO`, server: 'cloudflare' });
        }
      }
      const c = crypto.randomBytes(6).toString('hex');
      challenges.set(c, { exit, ua });
      // The answer needs JavaScript; a plain HTTP client only ever sees this interstitial.
      return html(403, `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
<div id="challenge-body">Checking your browser before accessing the site.</div>
<script>window._cf_chl_opt={cType:'managed'};
(function(){ if (navigator.webdriver) return; var c='${c}',x=0; for (var i=0;i<c.length;i++) x=(x*31+c.charCodeAt(i))%1000003;
setTimeout(function(){ document.cookie='cf_clearance='+c+'.'+x+'; path=/'; location.reload(); }, 800); })();</script>
</body></html>`, { 'cf-mitigated': 'challenge', 'cf-ray': `${crypto.randomBytes(8).toString('hex')}-DEMO`, server: 'cloudflare' });
    }
    return html(404, '<h1>Not found</h1>');
  });
  return listen(server);
}

/** Fake forward proxy. Adds x-demo-exit / x-demo-type so the demo site knows the "IP". */
export function startDemoProxy({ id, type, auth = null, gateway = false }) {
  const exitFor = (req) => {
    if (!gateway) return id;
    const user = decodeAuth(req.headers['proxy-authorization'])?.user || '';
    const s = /session-([\w]+)/.exec(user)?.[1] || 'none';
    return `${id}-${crypto.createHash('md5').update(s).digest('hex').slice(0, 6)}`; // new "IP" per session
  };
  const checkAuth = (req) => {
    if (!auth) return true;
    const a = decodeAuth(req.headers['proxy-authorization']);
    if (!a) return false;
    return gateway ? a.user.startsWith(auth.user) && a.pass === auth.pass : a.user === auth.user && a.pass === auth.pass;
  };
  const server = http.createServer((req, res) => {
    if (!checkAuth(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="demo"' });
      return res.end('Proxy auth required');
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      return res.end('absolute URL required');
    }
    const headers = { ...req.headers, 'x-demo-exit': exitFor(req), 'x-demo-type': type };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = http.request({ host: mapHost(target.hostname), port: target.port || 80, path: target.pathname + target.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    req.pipe(up);
  });
  server.on('connect', (req, socket, head) => {
    if (!checkAuth(req)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="demo"\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port) || 443, mapHost(host), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return listen(server);
}

// *.test hostnames are the demo sites; they all live on 127.0.0.1.
const mapHost = (h) => (/\.test$/i.test(h) ? '127.0.0.1' : h);

function decodeAuth(h) {
  const m = /^Basic\s+(.+)$/i.exec(h || '');
  if (!m) return null;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  return { user, pass: rest.join(':') };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const sockets = new Set();
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

/** A port nothing listens on: a "dead" proxy. */
async function deadPort() {
  const s = await listen(http.createServer());
  await s.close();
  return s.port;
}

/** Whole lab: 1 site, 2 good datacenter proxies, 1 dead one, a residential gateway with auth, 1 mobile. */
export async function startDemoLab() {
  const site = await startDemoSite();
  const dc1 = await startDemoProxy({ id: 'dc-a', type: 'datacenter' });
  const dc2 = await startDemoProxy({ id: 'dc-b', type: 'datacenter', auth: { user: 'demo', pass: 'secret' } });
  const resi = await startDemoProxy({ id: 'resi', type: 'residential', auth: { user: 'customer-demo', pass: 'resipass' }, gateway: true });
  const mob = await startDemoProxy({ id: 'mob', type: 'mobile' });
  const dead = await deadPort();
  const proxyLines = [
    `http://127.0.0.1:${dc1.port} type=datacenter id=dc-a cost=0.5`,
    `127.0.0.1:${dc2.port}:demo:secret type=datacenter id=dc-b cost=0.5`,
    `http://127.0.0.1:${dead} type=datacenter id=dc-dead cost=0.5`,
    `http://customer-demo-session-{session}:resipass@127.0.0.1:${resi.port} type=residential id=resi-gw cost=4`,
    `http://127.0.0.1:${mob.port} type=mobile id=mob-1 cost=9`,
  ];
  return {
    site,
    proxyLines,
    servers: [site, dc1, dc2, resi, mob],
    async close() {
      await Promise.all(this.servers.map((s) => s.close()));
    },
  };
}

export function demoUrls(siteUrl) {
  const port = new URL(siteUrl).port;
  const at = (name) => `http://${name}.demo.test:${port}`;
  return [
    ...[1, 2, 3].map((i) => `${at('open')}/open/${i}`),
    ...[1, 2, 3, 4, 5, 6].map((i) => `${at('rate')}/rate/${i}`),
    ...[1, 2, 3].map((i) => `${at('dd')}/dd/${i}`),
    ...[1, 2, 3].map((i) => `${at('cf')}/cf/${i}`),
    `${at('flaky')}/flaky/1`,
    `${at('open')}/private/secret-page`,
  ];
}
