// Batch extraction job: many URLs, bounded concurrency, resumable, every row with a clickable link.
//
// Input:  .txt (one URL per line), .csv (column "url" + any extra columns kept in the output),
//         .json ([ "url", ... ] or [{ url, render, mustContain, ... }] or { urls: [...], fields: [...] })
// Output: <out>/results.jsonl (one line per URL: status, step, proxy type, attempts, cost, fields)
//         <out>/data.csv      (extracted fields + url, BOM for Excel)
//         <out>/html/*.html   (optional raw pages, --save-html)
//         <out>/summary.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractFields, parseFieldSpecs } from './extract.js';
import { semaphore, formatBytes, siteOf } from './util.js';

export function readJobInput(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : j.urls || [];
    return { items: list.map((x) => (typeof x === 'string' ? { url: x } : x)).filter((x) => x?.url), fields: Array.isArray(j) ? [] : j.fields || [], options: Array.isArray(j) ? {} : j.options || {} };
  }
  if (ext === '.csv') {
    const rows = parseCsv(text);
    const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    const ui = header.findIndex((h) => ['url', 'link', 'href', 'website'].includes(h));
    if (ui < 0) throw new Error('CSV needs a "url" column');
    return {
      items: rows.filter((r) => r[ui]?.trim()).map((r) => ({ url: r[ui].trim(), meta: Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']).filter(([h]) => h !== header[ui])) })),
      fields: [],
      options: {},
    };
  }
  return { items: text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((url) => ({ url })), fields: [], options: {} };
}

export function parseCsv(text) {
  const sep = (text.split(/\r?\n/)[0].match(/;/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x !== ''));
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function readDone(file) {
  const done = new Map();
  if (!fs.existsSync(file)) return done;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      done.set(r.url, r);
    } catch { /* partial last line after a crash */ }
  }
  return done;
}

/**
 * @param {ReturnType<import('./fetcher.js').createFetcher>} fetcher
 * @param {{items:Array<{url:string}>, fields?:string[], outDir:string, concurrency?:number, saveHtml?:boolean,
 *          resume?:boolean, retryFailed?:boolean, fetchOptions?:object, onProgress?:Function, signal?:AbortSignal}} job
 */
export async function runJob(fetcher, job) {
  const outDir = path.resolve(job.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, 'results.jsonl');
  const fields = parseFieldSpecs(job.fields || []);
  const prior = job.resume === false ? new Map() : readDone(resultsFile);
  if (job.resume === false && fs.existsSync(resultsFile)) fs.rmSync(resultsFile);

  // De-duplicate and skip what is already done (failed rows are retried with --retry-failed, default on).
  const seen = new Set();
  const todo = [];
  for (const it of job.items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    const p = prior.get(it.url);
    if (p && (p.ok || job.retryFailed === false)) continue;
    todo.push(it);
  }
  const out = fs.createWriteStream(resultsFile, { flags: 'a' });
  const limit = semaphore(job.concurrency || fetcher.settings.concurrency || 4);
  const started = Date.now();
  const stats = { total: seen.size, skipped: seen.size - todo.length, done: 0, ok: 0, failed: 0, bytes: 0, costUsd: 0, byStep: {}, byError: {} };
  let stopped = false;
  job.signal?.addEventListener('abort', () => {
    stopped = true;
  });

  await Promise.all(todo.map((it) => limit(async () => {
    if (stopped) return;
    const { url, meta, ...perUrl } = it;
    const r = await fetcher.fetch(url, { ...(job.fetchOptions || {}), ...perUrl });
    const row = {
      url,
      ok: r.ok,
      status: r.status ?? null,
      step: r.step || null,
      proxyType: r.proxyType || null,
      attempts: r.attempts.length,
      blockedBy: r.block?.vendor || null,
      protection: r.protection || [],
      bytes: r.bytes,
      costUsd: r.costUsd,
      ms: r.ms,
      error: r.ok ? null : r.error,
      finalUrl: r.finalUrl || null,
      fetchedAt: new Date().toISOString(),
      ...(meta ? { meta } : {}),
    };
    if (r.ok && r.encoding !== 'base64') {
      if (fields.length) row.fields = extractFields(r.body, fields, r.finalUrl || url);
      if (job.saveHtml) {
        const name = `${siteOf(url)}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}.html`;
        fs.mkdirSync(path.join(outDir, 'html'), { recursive: true });
        fs.writeFileSync(path.join(outDir, 'html', name), r.body);
        row.htmlFile = `html/${name}`;
      }
    }
    out.write(`${JSON.stringify(row)}\n`);
    stats.done++;
    stats.bytes += r.bytes || 0;
    stats.costUsd += r.costUsd || 0;
    if (r.ok) {
      stats.ok++;
      stats.byStep[r.step] = (stats.byStep[r.step] || 0) + 1;
    } else {
      stats.failed++;
      const k = r.block ? `${r.block.vendor}:${r.block.kind}` : r.error;
      stats.byError[k] = (stats.byError[k] || 0) + 1;
    }
    job.onProgress?.(row, stats);
  })));
  await new Promise((r) => out.end(r));

  // Rebuild data.csv from the full results file (covers resumed runs too).
  const all = [...readDone(resultsFile).values()];
  const fieldNames = fields.length ? fields.map((f) => f.name) : [...new Set(all.flatMap((r) => Object.keys(r.fields || {})))];
  const metaNames = [...new Set(all.flatMap((r) => Object.keys(r.meta || {})))];
  const header = ['url', 'ok', 'status', ...fieldNames, ...metaNames, 'step', 'proxy_type', 'attempts', 'cost_usd', 'error', 'link'];
  const lines = [header.join(',')];
  for (const r of all) {
    lines.push([
      r.url, r.ok, r.status, ...fieldNames.map((f) => r.fields?.[f] ?? ''), ...metaNames.map((m) => r.meta?.[m] ?? ''),
      r.step, r.proxyType, r.attempts, r.costUsd, r.error, `=HYPERLINK("${String(r.url).replace(/"/g, '""')}","Open")`,
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'data.csv'), `﻿${lines.join('\r\n')}\r\n`);

  stats.costUsd = +stats.costUsd.toFixed(4);
  const summary = {
    ...stats,
    successRate: stats.done ? +(stats.ok / stats.done).toFixed(3) : null,
    allTimeOk: all.filter((r) => r.ok).length,
    seconds: Math.round((Date.now() - started) / 1000),
    bandwidth: formatBytes(stats.bytes),
    stopped,
    outDir,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
