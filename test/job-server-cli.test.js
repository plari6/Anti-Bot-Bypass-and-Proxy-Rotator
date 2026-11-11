import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { labFetcher, tmpDir } from './helpers.js';
import { runJob, readJobInput } from '../src/job.js';
import { createServer } from '../src/server.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'antibot.js');

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ANTIBOT_SKIP_DOTENV: '1', ANTIBOT_QUIET: '1', ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('job: extracts fields to CSV + JSONL, then resumes without refetching', async () => {
  const t = await labFetcher();
  try {
    const out = path.join(t.dir, 'job');
    const items = [t.url('open', '/open/1'), t.url('open', '/open/2'), t.url('dd', '/dd/1'), t.url('open', '/open/1'), t.url('cf', '/cf/1')].map((url) => ({ url }));
    const s1 = await runJob(t.fetcher, { items, fields: ['title=h1', 'price=.price'], outDir: out, concurrency: 2, saveHtml: true });
    assert.equal(s1.total, 4, 'duplicates removed');
    assert.equal(s1.ok, 3);
    assert.equal(s1.failed, 1);
    const csv = fs.readFileSync(path.join(out, 'data.csv'), 'utf8');
    assert.ok(csv.startsWith('﻿url,ok,status,title,price'));
    assert.match(csv, /Demo product 2,\$26\.00/);
    assert.match(csv, /=HYPERLINK\(""http:\/\/open\.demo\.test/);
    assert.equal(fs.readdirSync(path.join(out, 'html')).length, 3);
    const s2 = await runJob(t.fetcher, { items, fields: ['title=h1'], outDir: out, retryFailed: false });
    assert.equal(s2.done, 0);
    assert.equal(s2.skipped, 4);
  } finally {
    await t.close();
  }
});

test('job input: txt, csv (extra columns kept) and json job files', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'a.txt'), '# list\nhttps://a.com/1\n\nhttps://a.com/2\n');
  fs.writeFileSync(path.join(d, 'b.csv'), 'sku;URL\nX1;https://b.com/1\n');
  fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify({ urls: ['https://c.com', { url: 'https://c.com/2', render: true }], fields: ['t=h1'], options: { concurrency: 2 } }));
  assert.equal(readJobInput(path.join(d, 'a.txt')).items.length, 2);
  assert.deepEqual(readJobInput(path.join(d, 'b.csv')).items[0], { url: 'https://b.com/1', meta: { sku: 'X1' } });
  const c = readJobInput(path.join(d, 'c.json'));
  assert.equal(c.items[1].render, true);
  assert.deepEqual(c.fields, ['t=h1']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('REST gateway: API key, JSON result with fields, raw mode, stats and proxies', async () => {
  const t = await labFetcher();
  const server = createServer(t.fetcher, { apiKey: 'k123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/fetch?url=${encodeURIComponent(t.url('open', '/open/1'))}`)).status, 401);
    const r = await fetch(`${base}/v1/fetch`, { method: 'POST', headers: { 'x-api-key': 'k123', 'content-type': 'application/json' }, body: JSON.stringify({ url: t.url('dd', '/dd/3'), fields: ['price=.price'], noBody: true }) });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.fields.price, '$29.50');
    assert.equal(j.body, undefined);
    assert.equal(j.step, 'http:residential');
    const raw = await fetch(`${base}/v1/fetch?api_key=k123&raw=1&url=${encodeURIComponent(t.url('open', '/open/2'))}`);
    assert.equal(raw.headers.get('x-antibot-step'), 'http:datacenter');
    assert.match(await raw.text(), /Demo product 2/);
    const blocked = await fetch(`${base}/v1/fetch?api_key=k123&url=${encodeURIComponent(t.url('cf', '/cf/1'))}`);
    assert.equal(blocked.status, 502);
    assert.equal((await blocked.json()).block.vendor, 'cloudflare');
    const stats = await (await fetch(`${base}/v1/stats`, { headers: { 'x-api-key': 'k123' } })).json();
    assert.ok(stats.sites.find((s) => s.site === 'dd.demo.test'));
    const px = await (await fetch(`${base}/v1/proxies`, { headers: { 'x-api-key': 'k123' } })).json();
    assert.equal(px.proxies.length, 5);
    assert.ok(!JSON.stringify(px).includes('resipass'), 'no credentials leak');
    assert.equal((await fetch(`${base}/v1/fetch?api_key=k123&url=ftp://x`)).status, 400);
  } finally {
    server.close();
    await t.close();
  }
});

test('CLI: fetch through proxies, proxies check, stats, help', { timeout: 60000 }, async () => {
  const t = await labFetcher();
  try {
    const proxyFile = path.join(t.dir, 'proxies.txt');
    fs.writeFileSync(proxyFile, t.lab.proxyLines.join('\n'));
    const state = path.join(t.dir, 'cli-state.json');
    const common = ['--proxies', proxyFile, '--state', state, '--no-browser', '--delay', '0', '-q'];
    const f = await runCli(['fetch', t.url('dd', '/dd/1'), ...common, '--field', 'price=.price']);
    assert.equal(f.code, 0, f.stderr + f.stdout);
    assert.match(f.stdout, /OK\s+HTTP 200\s+via http:residential/);
    assert.match(f.stdout, /"price": "\$22\.50"/);
    const blocked = await runCli(['fetch', t.url('cf', '/cf/1'), ...common]);
    assert.equal(blocked.code, 2);
    assert.match(blocked.stdout, /FAILED\s+blocked: cloudflare challenge/);
    const chk = await runCli(['proxies', 'check', ...common, '--ip-url', t.url('open', '/ip')]);
    assert.match(chk.stdout, /4\/5 proxies working/);
    assert.match(chk.stdout, /resi-gw\s+residential\s+true\s+resi-\w+\s+\d+\s+true/, 'gateway rotates exit IP');
    const st = await runCli(['stats', '--state', state]);
    assert.match(st.stdout, /dd\.demo\.test/);
    const help = await runCli(['--help']);
    assert.match(help.stdout, /Commands/);
    const bad = await runCli(['nope']);
    assert.equal(bad.code, 1);
  } finally {
    await t.close();
  }
});
