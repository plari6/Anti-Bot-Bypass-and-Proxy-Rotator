import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { labFetcher, tmpDir } from './helpers.js';
import { createFetcher } from '../src/fetcher.js';
import { startDemoSite } from '../src/demo.js';
import { parseProxyList } from '../src/proxy/parse.js';
import { browserAvailable } from '../src/engines/browser.js';

test('open page: first try on the cheapest datacenter step, through the proxy', async () => {
  const t = await labFetcher({ ladder: 'http:datacenter,http:residential' });
  try {
    const r = await t.fetcher.fetch(t.url('open', '/open/1'));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.step, 'http:datacenter');
    assert.match(r.body, /Demo product 1/);
    assert.ok(r.bytes > 500);
    assert.ok(r.costUsd > 0);
  } finally {
    await t.close();
  }
});

test('DataDome-style wall: escalates datacenter -> residential, then the site starts at residential', async () => {
  const t = await labFetcher();
  try {
    const r1 = await t.fetcher.fetch(t.url('dd', '/dd/1'));
    assert.equal(r1.ok, true, r1.error);
    assert.equal(r1.step, 'http:residential');
    assert.equal(r1.attempts[0].vendor, 'datadome');
    assert.ok(r1.protection.includes('datadome') || t.fetcher.state.data.sites['dd.demo.test'].presence.includes('datadome'));
    const r2 = await t.fetcher.fetch(t.url('dd', '/dd/2'));
    assert.equal(r2.attempts.length, 1, 'learned: no wasted datacenter attempt');
    assert.equal(r2.step, 'http:residential');
    assert.equal(t.fetcher.state.data.sites['dd.demo.test'].tier, 1);
  } finally {
    await t.close();
  }
});

test('rate limits: 429 rotates to another IP and slows the site down', async () => {
  const t = await labFetcher({ ladder: 'http:datacenter' });
  try {
    const results = [];
    for (let i = 1; i <= 6; i++) results.push(await t.fetcher.fetch(t.url('rate', `/rate/${i}`)));
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => r.error)));
    assert.ok(results.some((r) => r.attempts.some((a) => a.blocked === 'rate_limit')));
  } finally {
    await t.close();
  }
});

test('JS challenge without a browser fails honestly (never returns the challenge as data)', async () => {
  const t = await labFetcher();
  try {
    const r = await t.fetcher.fetch(t.url('cf', '/cf/1'));
    assert.equal(r.ok, false);
    assert.equal(r.block.vendor, 'cloudflare');
    assert.equal(r.block.kind, 'challenge');
    assert.equal(r.body, undefined);
    assert.ok(r.attempts.length <= 3, 'challenge escalates instead of hammering the same step');
  } finally {
    await t.close();
  }
});

test('robots.txt is respected by default and can be ignored per call', async () => {
  const t = await labFetcher();
  try {
    const r = await t.fetcher.fetch(t.url('open', '/private/x'));
    assert.equal(r.ok, false);
    assert.equal(r.robots, true);
    assert.equal(r.attempts.length, 0);
    const r2 = await t.fetcher.fetch(t.url('open', '/private/x'), { ignoreRobots: true });
    assert.equal(r2.ok, true);
  } finally {
    await t.close();
  }
});

test('dead proxy is skipped and marked; 503 is retried without blaming the proxy', async () => {
  // sessionMaxRequests 1 = a new session (and proxy) every request, so round-robin reaches the dead one.
  const t = await labFetcher({ ladder: 'http:datacenter', strategy: 'round-robin', deadAfterErrors: 2, respectRobots: false, sessionMaxRequests: 1 });
  try {
    for (let i = 0; i < 6; i++) {
      const r = await t.fetcher.fetch(t.url('open', `/open/${i}`));
      assert.equal(r.ok, true, r.error);
    }
    const dead = t.fetcher.pool.status().find((p) => p.id === 'dc-dead');
    assert.equal(dead.dead, true);
    const f = await t.fetcher.fetch(t.url('flaky', '/flaky/1'));
    assert.equal(f.ok, true);
  } finally {
    await t.close();
  }
});

test('wrong proxy password (407) is detected and not saved as a page', async () => {
  const t = await labFetcher({ ladder: 'http:datacenter', respectRobots: false });
  try {
    const port = new URL(t.fetcher.pool.proxies.find((p) => p.id === 'dc-b').url).port;
    const { proxies } = parseProxyList(`http://demo:WRONG@127.0.0.1:${port} id=bad`);
    const f = createFetcher({ proxyList: proxies, persist: false, noBrowser: true, ladder: 'http:datacenter', domainDelayMs: 0, respectRobots: false, log: () => {} });
    const r = await f.fetch(t.url('open', '/open/1'));
    assert.equal(r.ok, false);
    assert.equal(r.block.kind, 'proxy_auth');
    await f.close();
  } finally {
    await t.close();
  }
});

test('budget stops paid traffic; state persists across fetcher instances', async () => {
  const t = await labFetcher({ budgetUsd: 0.0000001, respectRobots: false });
  try {
    const r1 = await t.fetcher.fetch(t.url('open', '/open/1'));
    assert.equal(r1.ok, true);
    const r2 = await t.fetcher.fetch(t.url('open', '/open/2'));
    assert.equal(r2.ok, false);
    assert.equal(r2.budgetExceeded, true);
    await t.fetcher.close();
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'state.json'), 'utf8'));
    assert.equal(saved.sites['open.demo.test'].ok, 1);
    assert.ok(saved.proxies['dc-a'] || saved.proxies['dc-b']);
  } finally {
    await t.close();
  }
});

test('no proxies configured: goes direct from this machine', async () => {
  const site = await startDemoSite();
  const dir = tmpDir();
  const f = createFetcher({ proxyList: [], stateFile: path.join(dir, 's.json'), noBrowser: true, domainDelayMs: 0, log: () => {} });
  try {
    const r = await f.fetch(`${site.url}/open/9`);
    assert.equal(r.ok, true);
    assert.equal(r.step, 'http:direct');
    assert.equal(r.costUsd, 0);
  } finally {
    await f.close();
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('named session keeps the same exit IP across calls', async () => {
  const t = await labFetcher({ ladder: 'http:residential', respectRobots: false });
  try {
    const a = await t.fetcher.fetch(t.url('open', '/ip'), { session: 'login-1' });
    const b = await t.fetcher.fetch(t.url('open', '/ip'), { session: 'login-1' });
    const c = await t.fetcher.fetch(t.url('open', '/ip'), { session: 'other' });
    assert.equal(JSON.parse(a.body).ip, JSON.parse(b.body).ip);
    assert.notEqual(JSON.parse(a.body).ip, JSON.parse(c.body).ip, 'gateway gives a new IP per session');
  } finally {
    await t.close();
  }
});

test('stealth browser solves the JS challenge, then its cookies are reused over fast HTTP', { timeout: 120000 }, async (ctx) => {
  if (!(await browserAvailable())) return ctx.skip('Chrome not installed');
  const t = await labFetcher({ noBrowser: false, browserTimeoutMs: 30000 });
  try {
    const r1 = await t.fetcher.fetch(t.url('cf', '/cf/1'));
    assert.equal(r1.ok, true, r1.error);
    assert.equal(r1.step, 'browser:residential');
    assert.match(r1.body, /Demo product 1/);
    const r2 = await t.fetcher.fetch(t.url('cf', '/cf/2'));
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.step, 'http:cleared', 'clearance cookie + same IP + same UA over plain HTTP');
    assert.equal(r2.attempts.length, 1);
  } finally {
    await t.close();
  }
});
