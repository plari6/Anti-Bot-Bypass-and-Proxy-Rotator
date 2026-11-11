import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createFetcher } from './fetcher.js';
import { loadSettings, PROJECT_DIR } from './config.js';
import { loadProxies, parseProxyList } from './proxy/parse.js';
import { checkProxies, DEFAULT_IP_URL } from './proxy/check.js';
import { createProxyPool } from './proxy/pool.js';
import { createState } from './state.js';
import { readJobInput, runJob } from './job.js';
import { extractFields, pageSummary, parseFieldSpecs } from './extract.js';
import { createServer } from './server.js';
import { siteReport, printTable } from './report.js';
import { detectBlock } from './detect.js';
import { httpRequest, closeAgents } from './engines/http.js';
import { createFingerprint } from './fingerprint.js';
import { browserAvailable } from './engines/browser.js';
import { startDemoLab, demoUrls } from './demo.js';
import { formatBytes } from './util.js';

const HELP = `antibot - anti-bot bypass & proxy rotator for data extraction jobs

Usage: antibot <command> [options]

Commands
  fetch <url>              Fetch one page through the escalation ladder
      --render               go straight to the stealth browser
      --field name=css[@attr][[]]   extract fields (repeatable)
      --must-contain <text>  treat pages without this text as blocked (soft block)
      --wait-for <css>       browser: wait for this selector
      --session <name>       keep the same IP + cookies across calls (login flows)
      --country <cc>         proxy country / Accept-Language (us, de, fr, ma ...)
      -o, --out <file>       save the body to a file
      --json                 print the full result as JSON
  run <urls.txt|csv|json>  Batch job: concurrency, resume, CSV + JSONL output
      -o, --out <dir>        output folder (default data/jobs/<name>)
      --field ...            fields to extract (also from a JSON job file)
      -c, --concurrency <n>  parallel fetches (default CONCURRENCY or 4)
      --save-html            keep raw pages in <out>/html
      --fresh                ignore earlier results in <out>
  serve                    REST gateway (GET/POST /v1/fetch, /v1/stats, /v1/proxies)
      --port <n> --host <ip>
  detect <url>             Which anti-bot product protects a site and what it will need
  proxies list|check|reset List proxy health, test exit IPs (--target <url>), clear bans
  stats [--json]           Success rate, blocks by vendor, bandwidth and spend per site
  demo [--no-browser]      Offline lab: fake Cloudflare/DataDome/rate-limited sites + fake proxies
  doctor                   Check Node, proxies, Chrome and the ladder

Global options
  -p, --proxies <file>     proxy list (txt or json); or PROXY_FILE / PROXIES in .env
  --proxy <url>            add one proxy (repeatable)
  --ladder <spec>          e.g. http:datacenter,http:residential,browser:residential
  --strategy <s>           weighted | round-robin | random | least-used
  --state <file>           learning state file (default data/state.json)
  --budget <usd>           stop paid proxy traffic after this spend
  --delay <ms>             min gap between requests to the same site
  --no-browser             never launch Chrome
  --ignore-robots          skip robots.txt (only for sites you are allowed to crawl)
  -q, --quiet              no per-attempt log
`;

const OPTIONS = {
  proxies: { type: 'string', short: 'p' },
  proxy: { type: 'string', multiple: true },
  ladder: { type: 'string' },
  strategy: { type: 'string' },
  state: { type: 'string' },
  budget: { type: 'string' },
  delay: { type: 'string' },
  'no-browser': { type: 'boolean' },
  'ignore-robots': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  render: { type: 'boolean' },
  field: { type: 'string', multiple: true },
  'must-contain': { type: 'string' },
  'wait-for': { type: 'string' },
  session: { type: 'string' },
  country: { type: 'string' },
  out: { type: 'string', short: 'o' },
  json: { type: 'boolean' },
  concurrency: { type: 'string', short: 'c' },
  'save-html': { type: 'boolean' },
  fresh: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  target: { type: 'string' },
  'ip-url': { type: 'string' },
  headful: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function overridesFrom(v) {
  const o = {};
  if (v.proxies) o.proxyFile = v.proxies;
  if (v.proxy?.length) o.proxies = v.proxy.join('\n');
  if (v.ladder) o.ladder = v.ladder;
  if (v.strategy) o.strategy = v.strategy;
  if (v.state) o.stateFile = path.resolve(v.state);
  if (v.budget) o.budgetUsd = Number(v.budget);
  if (v.delay) o.domainDelayMs = Number(v.delay);
  if (v['ignore-robots']) o.respectRobots = false;
  if (v.concurrency) o.concurrency = Number(v.concurrency);
  if (v.port) o.port = Number(v.port);
  if (v.host) o.host = v.host;
  if (v.country) o.country = v.country;
  if (v.headful) o.headful = 'true';
  if (v['no-browser']) o.noBrowser = true;
  if (v.quiet) o.log = () => {};
  return o;
}

const out = (s) => process.stdout.write(`${s}\n`);

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    out(HELP);
    throw err;
  }
  const { values: v, positionals: [cmd, ...args] } = parsed;
  if (!cmd || v.help || cmd === 'help') {
    out(HELP);
    return 0;
  }
  const o = overridesFrom(v);

  switch (cmd) {
    case 'fetch':
      return cmdFetch(args[0], v, o);
    case 'run':
      return cmdRun(args[0], v, o);
    case 'serve':
      return cmdServe(o);
    case 'detect':
      return cmdDetect(args[0], v, o);
    case 'proxies':
      return cmdProxies(args[0] || 'list', v, o);
    case 'stats':
      return cmdStats(v, o);
    case 'demo':
      return cmdDemo(v, o);
    case 'doctor':
      return cmdDoctor(o);
    default:
      out(HELP);
      throw new Error(`unknown command "${cmd}"`);
  }
}

async function cmdFetch(url, v, o) {
  if (!url) throw new Error('usage: antibot fetch <url>');
  const f = createFetcher(o);
  try {
    const r = await f.fetch(url, { render: v.render, mustContain: v['must-contain'], waitForSelector: v['wait-for'], session: v.session, country: v.country });
    const fields = v.field?.length && r.ok ? extractFields(r.body, parseFieldSpecs(v.field), r.finalUrl) : undefined;
    if (v.out && r.ok) fs.writeFileSync(v.out, r.encoding === 'base64' ? Buffer.from(r.body, 'base64') : r.body);
    if (v.json) {
      out(JSON.stringify({ ...r, body: v.out ? undefined : r.body, fields }, null, 2));
    } else if (r.ok) {
      out(`OK  HTTP ${r.status}  via ${r.step} (${r.proxy})  ${r.attempts.length} attempt(s)  ${formatBytes(r.bytes)}  $${r.costUsd.toFixed(5)}  ${r.ms} ms`);
      if (r.protection?.length) out(`Protection seen: ${r.protection.join(', ')}`);
      const sum = r.encoding === 'utf8' ? pageSummary(r.body) : null;
      if (sum) out(`Title: ${sum.title || '-'}  |  H1: ${sum.h1 || '-'}  |  links: ${sum.links}  |  text: ${sum.textLength} chars`);
      if (fields) out(JSON.stringify(fields, null, 2));
      if (v.out) out(`Saved to ${v.out}`);
    } else {
      out(`FAILED  ${r.error}  (${r.attempts.length} attempt(s), $${(r.costUsd || 0).toFixed(5)})`);
      for (const a of r.attempts) out(`  - ${a.step.padEnd(20)} ${String(a.proxy).padEnd(40)} ${a.status ?? ''} ${a.reason || a.error || ''}`);
    }
    return r.ok ? 0 : 2;
  } finally {
    await f.close();
  }
}

async function cmdRun(input, v, o) {
  if (!input) throw new Error('usage: antibot run <urls.txt|urls.csv|job.json>');
  const job = readJobInput(input);
  const outDir = v.out || path.join('data', 'jobs', path.basename(input, path.extname(input)));
  const f = createFetcher({ ...o, ...(job.options || {}) });
  const ac = new AbortController();
  const onSig = () => {
    process.stderr.write('\nStopping after running requests finish (Ctrl+C again to force)...\n');
    ac.abort();
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', onSig);
  try {
    out(`Job: ${job.items.length} URL(s) -> ${path.resolve(outDir)}`);
    const summary = await runJob(f, {
      items: job.items,
      fields: [...(job.fields || []), ...(v.field || [])],
      outDir,
      concurrency: v.concurrency ? Number(v.concurrency) : job.options?.concurrency,
      saveHtml: v['save-html'] || job.options?.saveHtml,
      resume: !v.fresh,
      fetchOptions: { render: v.render, mustContain: v['must-contain'], waitForSelector: v['wait-for'], country: v.country },
      signal: ac.signal,
      onProgress: (row, s) => {
        if (!v.quiet) process.stderr.write(`[${s.done}/${s.total - s.skipped}] ${row.ok ? 'ok  ' : 'FAIL'} ${row.step || '-'} ${row.url}${row.ok ? '' : `  (${row.error})`}\n`);
      },
    });
    out(printTable([summary], ['total', 'skipped', 'done', 'ok', 'failed', 'successRate', 'bandwidth', 'costUsd', 'seconds']));
    if (Object.keys(summary.byStep).length) out(`Solved by: ${Object.entries(summary.byStep).map(([k, n]) => `${k}=${n}`).join('  ')}`);
    if (Object.keys(summary.byError).length) out(`Failures: ${Object.entries(summary.byError).map(([k, n]) => `${k}=${n}`).join('  ')}`);
    out(`Files: ${path.join(summary.outDir, 'data.csv')} , results.jsonl , summary.json`);
    return summary.failed ? 2 : 0;
  } finally {
    process.removeListener('SIGINT', onSig);
    await f.close();
  }
}

async function cmdServe(o) {
  const f = createFetcher(o);
  const s = f.settings;
  if (!s.apiKey && !['127.0.0.1', 'localhost', '::1'].includes(s.host)) {
    throw new Error('Refusing to listen on a public interface without API_KEY (anyone could spend your proxy traffic). Set API_KEY in .env.');
  }
  const server = createServer(f);
  await new Promise((r) => server.listen(s.port, s.host, r));
  out(`antibot gateway on http://${s.host}:${s.port}  (${f.pool.size} proxies, ladder ${f.stepsFor({}).map((x) => `${x.engine}:${x.type}`).join(' > ')})`);
  out(`Try: curl "http://${s.host}:${s.port}/v1/fetch?url=https://example.com&no_body=1"${s.apiKey ? ' -H "x-api-key: $API_KEY"' : ''}`);
  const stop = async () => {
    server.close();
    await f.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return new Promise(() => {});
}

async function cmdDetect(url, v, o) {
  if (!url) throw new Error('usage: antibot detect <url>');
  const settings = loadSettings(o);
  const { proxies } = o.proxyList ? { proxies: o.proxyList } : loadProxies(settings);
  const pool = createProxyPool(proxies, settings);
  const proxy = pool.pick(url, { type: 'datacenter' }) || pool.pick(url, { type: 'any' });
  const fp = createFingerprint({ country: v.country });
  try {
    const res = await httpRequest({ url, headers: fp.headers, proxyUrl: proxy ? proxy.url.replace(/\{session\}/g, 'detect').replace(/\{country\}/g, v.country || 'us') : null, timeoutMs: settings.timeoutMs });
    const verdict = detectBlock(res);
    const report = {
      url,
      via: proxy ? `${proxy.id} (${proxy.type})` : 'direct',
      status: res.status,
      protection: verdict.presence,
      blocked: verdict.blocked,
      block: verdict.blocked ? { vendor: verdict.vendor, kind: verdict.kind, reason: verdict.reason } : null,
      advice: advise(verdict, proxy),
    };
    if (v.json) out(JSON.stringify(report, null, 2));
    else {
      out(`${url}\n  via ${report.via} -> HTTP ${res.status}`);
      out(`  protection: ${report.protection.join(', ') || 'none detected'}`);
      out(`  result: ${verdict.blocked ? `BLOCKED - ${verdict.reason}` : 'passed with plain HTTP'}`);
      out(`  advice: ${report.advice}`);
    }
    return 0;
  } finally {
    closeAgents();
  }
}

function advise(v, proxy) {
  if (!v.blocked) {
    return v.presence.length
      ? `passes today with ${proxy ? proxy.type : 'a direct'} HTTP request, but ${v.presence.join('/')} is present: keep the ladder on, start cheap, it will climb if scores drop.`
      : 'no bot protection found: plain HTTP with datacenter proxies is enough (cheapest).';
  }
  const by = {
    challenge: 'JavaScript challenge: the browser step will solve it once, then its cookies are reused over fast HTTP. Use residential proxies for the browser step.',
    captcha: 'captcha wall: the IP/fingerprint is distrusted. Needs residential or mobile IPs + browser; lower the request rate. Never store this page as data.',
    ban: 'IP refused: datacenter ranges are blocked. Use residential (or ISP) proxies; mobile for the hardest sites.',
    rate_limit: 'rate limited: increase --delay, spread over more IPs, respect Retry-After.',
    soft: 'empty/soft-blocked page: retry with --render or another IP; set --must-contain to catch it.',
    proxy_auth: 'proxy rejected the username/password (407).',
  };
  return by[v.kind] || 'blocked: escalate to residential + browser.';
}

async function cmdProxies(sub, v, o) {
  const settings = loadSettings(o);
  const { proxies, errors } = loadProxies(settings);
  for (const e of errors) out(`skipped: ${e}`);
  if (!proxies.length) {
    out('No proxies configured. Use --proxies proxies.txt, --proxy <url> or PROXY_FILE / PROXIES in .env');
    return 1;
  }
  if (sub === 'check') {
    const rows = await checkProxies(proxies, { ipUrl: v['ip-url'] || DEFAULT_IP_URL, target: v.target, timeoutMs: settings.timeoutMs });
    closeAgents();
    if (v.json) out(JSON.stringify(rows, null, 2));
    else out(printTable(rows, ['id', 'type', 'country', 'ok', 'ip', 'latencyMs', 'rotates', ...(v.target ? ['target'] : []), 'error']));
    const good = rows.filter((r) => r.ok).length;
    out(`\n${good}/${rows.length} proxies working`);
    return good ? 0 : 2;
  }
  const state = createState(settings.stateFile);
  const pool = createProxyPool(proxies, settings, state.data.proxies);
  if (sub === 'reset') {
    pool.reset();
    state.setProxyHealth(pool.snapshot());
    state.save();
    out('Cleared all bans and dead flags.');
    return 0;
  }
  const rows = pool.status().map((r) => ({ ...r, bytes: formatBytes(r.bytes), bannedOn: r.bannedOn.join(',') }));
  if (v.json) out(JSON.stringify(pool.status(), null, 2));
  else out(printTable(rows, ['id', 'type', 'country', 'sticky', 'used', 'ok', 'fail', 'errors', 'successRate', 'latencyMs', 'bytes', 'dead', 'bannedOn']));
  return 0;
}

async function cmdStats(v, o) {
  const settings = loadSettings(o);
  const rep = siteReport(createState(settings.stateFile).data);
  if (v.json) {
    out(JSON.stringify(rep, null, 2));
    return 0;
  }
  const t = rep.totals;
  out(`Totals: ${t.requests || 0} requests, ${t.ok || 0} ok, ${t.blocked || 0} blocked, ${t.errors || 0} errors, success ${t.successRate ?? '-'}, ${t.bandwidth}, $${t.costUsd}`);
  out(printTable(rep.sites, ['site', 'requests', 'ok', 'blocked', 'successRate', 'protection', 'blockedBy', 'needs', 'bandwidth', 'costUsd', 'costPer1kOk']));
  return 0;
}

async function cmdDemo(v, o) {
  const lab = await startDemoLab();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antibot-demo-'));
  const useBrowser = !v['no-browser'] && (await browserAvailable(o.chromePath));
  if (!v['no-browser'] && !useBrowser) out('Chrome not found: running without the browser step (npm rebuild puppeteer or set CHROME_PATH).');
  const { proxies } = parseProxyList(lab.proxyLines.join('\n'));
  const f = createFetcher({
    ...o,
    proxyList: proxies,
    stateFile: path.join(tmp, 'state.json'),
    domainDelayMs: 60,
    domainConcurrency: 2,
    banBaseMs: 3000,
    retriesPerStep: 3,
    respectRobots: true,
    noBrowser: !useBrowser,
    bypassLoopback: true,
    timeoutMs: 5000,
  });
  const outDir = v.out || path.join(PROJECT_DIR, 'data', 'demo');
  try {
    out(`Demo lab: fake protected sites on *.demo.test:${lab.site.port} + ${proxies.length} fake proxies (2 datacenter, 1 dead, 1 residential gateway, 1 mobile)`);
    out(`Browser step: ${useBrowser ? 'on (stealth Chrome)' : 'off'}\n`);
    const urls = demoUrls(lab.site.url);
    const summary = await runJob(f, {
      items: urls.map((url) => ({ url })),
      fields: ['title=h1', 'price=.price', 'jsonld=@jsonld'],
      outDir,
      concurrency: 3,
      resume: false,
      onProgress: (row) => {
        out(`${row.ok ? 'OK  ' : 'FAIL'}  ${new URL(row.url).host.split('.')[0].padEnd(6)} ${new URL(row.url).pathname.padEnd(22)} ${String(row.step || '-').padEnd(22)} attempts=${row.attempts}  ${row.ok ? `price=${row.fields?.price}` : row.error}`);
      },
    });
    out('');
    out(printTable(siteReport(f.state.data).sites, ['site', 'requests', 'ok', 'blocked', 'protection', 'blockedBy', 'needs', 'costUsd']));
    out('');
    out(printTable(f.pool.status().map((r) => ({ ...r, bannedOn: r.bannedOn.join(',') })), ['id', 'type', 'used', 'ok', 'fail', 'errors', 'dead', 'bannedOn']));
    out(`\n${summary.ok}/${summary.done} pages extracted (${summary.failed} failed: ${Object.entries(summary.byError).map(([k, n]) => `${k} x${n}`).join(', ') || 'none'})`);
    out(`Expected: open/rate/dd/flaky succeed, cf needs the browser step${useBrowser ? '' : ' (off here, so cf fails)'}, /private is refused by robots.txt.`);
    out(`Output: ${path.join(outDir, 'data.csv')}`);
    return 0;
  } finally {
    await f.close();
    await lab.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function cmdDoctor(o) {
  const lines = [];
  const ok = (good, text) => lines.push(`${good ? '[ok]  ' : '[!!]  '}${text}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  ok(major > 22 || (major === 22 && minor >= 13), `Node ${process.versions.node} (need >= 22.13)`);
  let settings;
  try {
    settings = loadSettings(o);
    ok(true, `Settings loaded (strategy ${settings.strategy}, robots ${settings.respectRobots ? 'respected' : 'ignored'}, budget ${settings.budgetUsd ? `$${settings.budgetUsd}` : 'unlimited'})`);
  } catch (err) {
    ok(false, `Settings: ${err.message}`);
    out(lines.join('\n'));
    return 1;
  }
  let proxies = [];
  try {
    const r = loadProxies(settings);
    proxies = r.proxies;
    const byType = proxies.reduce((m, p) => ({ ...m, [p.type]: (m[p.type] || 0) + 1 }), {});
    ok(proxies.length > 0, proxies.length ? `${proxies.length} proxies: ${Object.entries(byType).map(([k, n]) => `${n} ${k}`).join(', ')}` : 'No proxies configured (requests will go direct from this machine)');
    for (const e of r.errors) ok(false, `proxy line skipped: ${e}`);
    if (proxies.length && !byType.residential && !byType.mobile) ok(false, 'No residential/mobile proxies: Cloudflare/DataDome protected sites will mostly fail');
  } catch (err) {
    ok(false, err.message);
  }
  const chrome = o.noBrowser ? false : await browserAvailable(settings.chromePath);
  ok(chrome || o.noBrowser, o.noBrowser ? 'Browser step disabled (--no-browser)' : chrome ? 'Chrome found for the stealth browser step' : 'Chrome not found: run "npm install-scripts approve puppeteer && npm rebuild puppeteer" or set CHROME_PATH');
  const pool = createProxyPool(proxies, settings);
  const types = pool.types();
  const steps = settings.ladder.filter((s) => (s.engine !== 'browser' || chrome) && (!proxies.length || s.type === 'any' || types.has(s.type)));
  const labels = [...new Set(steps.map((s) => `${s.engine}:${proxies.length ? s.type : 'direct'}`))];
  ok(steps.length > 0, `Usable ladder: ${labels.join(' > ') || 'none'}`);
  ok(true, `State file: ${settings.stateFile}${fs.existsSync(settings.stateFile) ? '' : ' (created on first run)'}`);
  out(lines.join('\n'));
  return lines.some((l) => l.startsWith('[!!]')) ? 1 : 0;
}
