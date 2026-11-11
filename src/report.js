// Human-readable stats from the state file: what each site needs and what it costs.
import { formatBytes } from './util.js';

export function siteReport(data) {
  const sites = Object.entries(data.sites || {})
    .map(([site, s]) => ({
      site,
      requests: s.requests,
      ok: s.ok,
      blocked: s.blocked,
      errors: s.errors,
      successRate: s.requests ? +(s.ok / s.requests).toFixed(3) : null,
      protection: s.presence,
      blockedBy: s.vendor,
      blocks: s.blocks,
      needs: s.lastStep,
      bandwidth: formatBytes(s.bytes),
      costUsd: +s.costUsd.toFixed(4),
      costPer1kOk: s.ok ? +((s.costUsd / s.ok) * 1000).toFixed(3) : null,
      lastOk: s.lastOk,
    }))
    .sort((a, b) => b.requests - a.requests);
  const t = data.totals || {};
  return {
    totals: { ...t, bandwidth: formatBytes(t.bytes || 0), costUsd: +(t.costUsd || 0).toFixed(4), successRate: t.requests ? +(t.ok / t.requests).toFixed(3) : null },
    sites,
    updatedAt: data.updatedAt,
  };
}

export function printTable(rows, columns) {
  if (!rows.length) return '(none)';
  const cols = columns || Object.keys(rows[0]);
  const str = (v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const widths = cols.map((c) => Math.min(48, Math.max(c.length, ...rows.map((r) => str(r[c]).length))));
  const fmt = (vals) => vals.map((v, i) => str(v).slice(0, widths[i]).padEnd(widths[i])).join('  ');
  return [fmt(cols), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map((r) => fmt(cols.map((c) => r[c])))].join('\n');
}
