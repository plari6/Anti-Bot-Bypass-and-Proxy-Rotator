import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { parseProxyList, resolveProxyUrl, normalizeProxyUrl } from '../src/proxy/parse.js';
import { createProxyPool } from '../src/proxy/pool.js';
import { detectBlock, parseRetryAfter, shouldEscalate } from '../src/detect.js';
import { createCookieJar } from '../src/cookies.js';
import { parseRobots, isAllowed } from '../src/robots.js';
import { createFingerprint, fromUserAgent, chromeMajor, acceptLanguageFor } from '../src/fingerprint.js';
import { parseLadder } from '../src/config.js';
import { extractFields, parseFieldSpecs } from '../src/extract.js';
import { parseCsv } from '../src/job.js';
import { maskProxy, parseDuration } from '../src/util.js';

test('proxy list: every common provider format', () => {
  const { proxies, errors } = parseProxyList(`
# comment
http://u:p@1.2.3.4:8080
5.6.7.8:3128
9.9.9.9:8000:alice:s3cr3t type=residential country=DE cost=3
bob:pw@10.0.0.1:9000
socks5://11.11.11.11:1080
http://user-session-{session}-country-{country}:pw@gate.example.com:7000 type=residential
http://x:y@pr.oxylabs.io:7777
not a proxy
`);
  assert.equal(proxies.length, 7);
  assert.equal(errors.length, 1);
  assert.equal(proxies[2].url, 'http://alice:s3cr3t@9.9.9.9:8000');
  assert.equal(proxies[2].type, 'residential');
  assert.equal(proxies[2].country, 'de');
  assert.equal(proxies[2].costPerGb, 3);
  assert.equal(proxies[3].url, 'http://bob:pw@10.0.0.1:9000');
  assert.equal(proxies[4].url, 'socks5://11.11.11.11:1080');
  assert.equal(proxies[0].type, 'datacenter');
  assert.equal(proxies[5].sticky, true);
  assert.equal(proxies[6].type, 'residential', 'known residential gateway host');
  assert.equal(new Set(proxies.map((p) => p.id)).size, 7, 'unique ids');
  assert.equal(resolveProxyUrl(proxies[5], { session: 'abc', country: 'FR' }), 'http://user-session-abc-country-fr:pw@gate.example.com:7000');
});

test('proxy list: JSON input and validation', () => {
  const { proxies } = parseProxyList(JSON.stringify([{ url: 'http://1.1.1.1:80', type: 'mobile', id: 'm1' }]));
  assert.equal(proxies[0].id, 'm1');
  assert.equal(proxies[0].type, 'mobile');
  assert.throws(() => normalizeProxyUrl('ftp://1.1.1.1:21'), /unsupported/);
  assert.throws(() => normalizeProxyUrl('http://1.1.1.1'), /no port/);
});

test('pool: a block bans the proxy on that site only, with exponential backoff', () => {
  let now = 1000;
  const { proxies } = parseProxyList('1.1.1.1:80 id=a\n2.2.2.2:80 id=b');
  const pool = createProxyPool(proxies, { banBaseMs: 1000, banMaxMs: 10000, now: () => now });
  pool.report(proxies[0], 'https://shop.com/x', { kind: 'blocked' });
  for (let i = 0; i < 20; i++) assert.equal(pool.pick('https://shop.com/y').id, 'b');
  assert.ok(['a', 'b'].includes(pool.pick('https://other.com/').id));
  const st = pool.status().find((p) => p.id === 'a');
  assert.deepEqual(st.bannedOn, ['shop.com']);
  now += 1001;
  pool.report(proxies[0], 'https://shop.com/x', { kind: 'blocked' }); // 2nd strike -> 2 s
  now += 1500;
  assert.equal(pool.status().find((p) => p.id === 'a').bannedOn.length, 1);
  now += 600;
  assert.equal(pool.status().find((p) => p.id === 'a').bannedOn.length, 0);
});

test('pool: rate limit honours Retry-After, dead after repeated errors, gateways never benched', () => {
  let now = 0;
  const { proxies } = parseProxyList('1.1.1.1:80 id=a\nhttp://u-{session}:p@gw.example.com:1 id=gw type=residential');
  const pool = createProxyPool(proxies, { deadAfterErrors: 3, banMaxMs: 5000, now: () => now });
  pool.report(proxies[0], 'https://a.com', { kind: 'blocked', retryAfterMs: 200 });
  assert.equal(pool.pick('https://a.com', { type: 'datacenter' }), null);
  now = 201;
  assert.equal(pool.pick('https://a.com', { type: 'datacenter' }).id, 'a');
  for (let i = 0; i < 3; i++) pool.report(proxies[0], 'https://x.com', { kind: 'error' });
  assert.equal(pool.pick('https://b.com', { type: 'datacenter' }), null, 'dead everywhere');
  for (let i = 0; i < 5; i++) pool.report(proxies[1], 'https://a.com', { kind: 'blocked' });
  assert.equal(pool.pick('https://a.com', { type: 'residential' }).id, 'gw');
});

test('pool: weighted strategy prefers proxies that work on the site', () => {
  const { proxies } = parseProxyList('1.1.1.1:80 id=good\n2.2.2.2:80 id=bad');
  const pool = createProxyPool(proxies, { strategy: 'weighted', banBaseMs: 0 });
  for (let i = 0; i < 30; i++) pool.report(proxies[0], 'https://s.com', { kind: 'ok', latencyMs: 200 });
  for (let i = 0; i < 30; i++) pool.report(proxies[1], 'https://s.com', { kind: 'blocked' });
  const counts = { good: 0, bad: 0 };
  for (let i = 0; i < 400; i++) counts[pool.pick('https://s.com').id]++;
  assert.ok(counts.good > counts.bad * 5, JSON.stringify(counts));
});

test('pool: round-robin cycles', () => {
  const { proxies } = parseProxyList('1.1.1.1:80\n2.2.2.2:80\n3.3.3.3:80');
  const pool = createProxyPool(proxies, { strategy: 'round-robin' });
  assert.deepEqual([1, 2, 3, 4].map(() => pool.pick('https://a.com').url), ['http://1.1.1.1:80', 'http://2.2.2.2:80', 'http://3.3.3.3:80', 'http://1.1.1.1:80']);
});

test('detect: Cloudflare challenge, 1020 ban, 1015 rate limit', () => {
  const ch = detectBlock({ status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'x' }, body: '<title>Just a moment...</title>' });
  assert.equal(ch.vendor, 'cloudflare');
  assert.equal(ch.kind, 'challenge');
  assert.ok(shouldEscalate(ch));
  const ban = detectBlock({ status: 403, headers: { server: 'cloudflare' }, body: '<span class="cf-error-details">Error code: 1020 Access denied</span>' });
  assert.equal(ban.kind, 'ban');
  const rl = detectBlock({ status: 429, headers: { 'retry-after': '7' }, body: 'error code: 1015 You are being rate limited' });
  assert.equal(rl.kind, 'rate_limit');
  assert.equal(rl.retryAfterMs, 7000);
});

test('detect: DataDome, PerimeterX, Akamai, AWS WAF, Imperva, Amazon captcha', () => {
  assert.equal(detectBlock({ status: 403, headers: { 'x-datadome': 'protected' }, body: "<script>var dd={'rt':'c','host':'geo.captcha-delivery.com'}</script>" }).vendor, 'datadome');
  assert.equal(detectBlock({ status: 403, headers: {}, body: "<script>var dd={'rt':'i'}</script>" }).kind, 'challenge');
  assert.equal(detectBlock({ status: 403, headers: {}, body: '<div id="px-captcha"></div> Press &amp; Hold' }).vendor, 'perimeterx');
  assert.equal(detectBlock({ status: 403, headers: {}, body: '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.abc.123 https://errors.edgesuite.net/</BODY>' }).vendor, 'akamai');
  assert.equal(detectBlock({ status: 405, headers: { 'x-amzn-waf-action': 'captcha' }, body: '' }).vendor, 'aws-waf');
  assert.equal(detectBlock({ status: 200, headers: {}, body: '<html><script src="/_Incapsula_Resource?x"></script></html>' }).vendor, 'imperva');
  const amz = detectBlock({ status: 200, headers: {}, body: '<form action="/errors/validateCaptcha">Type the characters you see in this image</form>' });
  assert.equal(amz.vendor, 'amazon');
  assert.equal(amz.kind, 'captcha');
});

test('detect: normal protected page passes but presence is reported', () => {
  const v = detectBlock({ status: 200, headers: { 'cf-ray': 'abc', 'set-cookie': ['__cf_bm=1; path=/', 'datadome=x'] }, body: `<html><body>${'x'.repeat(70000)}<script src="https://js.datadome.co/tags.js"></script></body></html>` });
  assert.equal(v.blocked, false);
  assert.deepEqual(v.presence.sort(), ['cloudflare', 'datadome']);
  assert.equal(detectBlock({ status: 404, body: 'nope' }).blocked, false);
});

test('detect: soft blocks (must-contain, min bytes) and Retry-After dates', () => {
  assert.equal(detectBlock({ status: 200, body: '<html>hi</html>' }, { mustContain: 'Price' }).kind, 'soft');
  assert.equal(detectBlock({ status: 200, body: '<html>hi</html>' }, { mustContain: /pri/i }).kind, 'soft');
  assert.equal(detectBlock({ status: 200, body: 'ok' }, { minBytes: 100 }).kind, 'soft');
  assert.equal(detectBlock({ status: 200, body: 'Price: 1' }, { mustContain: 'Price' }).blocked, false);
  const at = new Date(Date.now() + 5000).toUTCString();
  assert.ok(parseRetryAfter(at) > 3000);
  assert.equal(detectBlock({ status: 407, body: '' }).kind, 'proxy_auth');
});

test('cookie jar: domain, path, expiry, secure and browser import/export', () => {
  let now = 1000;
  const jar = createCookieJar(() => now);
  jar.setFromResponse({ 'set-cookie': ['a=1; Path=/', 'b=2; Domain=.shop.com; Path=/p', 'c=3; Max-Age=1', 's=4; Secure', 'x=9; Domain=evil.com'] }, 'http://www.shop.com/');
  assert.equal(jar.header('http://www.shop.com/'), 'a=1; c=3');
  assert.equal(jar.header('http://api.shop.com/p/1'), 'b=2');
  assert.match(jar.header('https://www.shop.com/p/x'), /a=1.*b=2.*c=3.*s=4|a=1/);
  now += 2000;
  assert.ok(!jar.header('http://www.shop.com/').includes('c=3'));
  jar.importBrowserCookies([{ name: 'cf_clearance', value: 'tok', domain: '.shop.com', path: '/', expires: -1, secure: false }]);
  assert.ok(jar.names('http://m.shop.com/').includes('cf_clearance'));
  assert.equal(jar.toBrowserCookies('http://www.shop.com/').find((c) => c.name === 'cf_clearance').domain, '.shop.com');
});

test('robots.txt: longest match, allow on tie, wildcards and crawl-delay', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nCrawl-delay: 2\n\nUser-agent: Googlebot\nDisallow:\n');
  assert.equal(isAllowed(r, 'https://a.com/private/x'), false);
  assert.equal(isAllowed(r, 'https://a.com/private/ok/1'), true);
  assert.equal(isAllowed(r, 'https://a.com/files/a.pdf'), false);
  assert.equal(isAllowed(r, 'https://a.com/files/a.pdf?x=1'), true);
  assert.equal(isAllowed(r, 'https://a.com/'), true);
  assert.equal(r.crawlDelayMs, 2000);
  assert.equal(isAllowed(null, 'https://a.com/x'), true);
});

test('fingerprint: UA, client hints and language stay consistent', () => {
  for (let i = 0; i < 30; i++) {
    const fp = createFingerprint({ country: 'de' });
    assert.equal(fp.headers['accept-language'], 'de-DE,de;q=0.9,en;q=0.8');
    if (fp.family !== 'firefox') {
      const v = fp.userAgent.match(/Chrome\/(\d+)/)[1];
      assert.ok(fp.headers['sec-ch-ua'].includes(`v="${v}"`));
      assert.equal(fp.headers['sec-ch-ua-platform'].includes('Windows'), fp.userAgent.includes('Windows'));
    } else {
      assert.equal(fp.headers['sec-ch-ua'], undefined, 'Firefox sends no client hints');
    }
  }
  assert.ok(chromeMajor(new Date('2026-11-11')) >= 155);
  const fromB = fromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36');
  assert.equal(fromB.headers['sec-ch-ua-platform'], '"macOS"');
  assert.equal(acceptLanguageFor('zz'), 'en-US,en;q=0.9');
});

test('config/extract/csv/util helpers', () => {
  assert.deepEqual(parseLadder('http:datacenter, browser:residential'), [{ engine: 'http', type: 'datacenter' }, { engine: 'browser', type: 'residential' }]);
  assert.throws(() => parseLadder('curl:any'), /Unknown engine/);
  const html = '<html><body><h1> Shoe  X </h1><a class="l" href="/a">A</a><a class="l" href="/b">B</a><img src="/i.jpg"><script type="application/ld+json">{"@type":"Product"}</script></body></html>';
  const row = extractFields(html, parseFieldSpecs(['title=h1', 'links=a.l@href[]', 'img=img@src', 'ld=@jsonld', 'none=.missing']), 'https://s.com/p/1');
  assert.deepEqual(row, { title: 'Shoe X', links: 'https://s.com/a | https://s.com/b', img: 'https://s.com/i.jpg', ld: '{"@type":"Product"}', none: '' });
  assert.deepEqual(parseCsv('url;name\n"https://a.com/x";"A ""q"""\nhttps://b.com;B\n'), [['url', 'name'], ['https://a.com/x', 'A "q"'], ['https://b.com', 'B']]);
  assert.equal(maskProxy('http://customer-abc:secret@gate.io:7000'), 'http://cust***:***@gate.io:7000');
  assert.equal(parseDuration('2m', 0), 120000);
  assert.equal(parseDuration('bad', 5), 5);
});
