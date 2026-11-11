// Persistent learning between runs (JSON file): proxy health, the ladder step each site needs,
// which protection each site uses, success/block counts, bandwidth and proxy spend.
import fs from 'node:fs';
import path from 'node:path';

export function createState(file, { persist = true } = {}) {
  let data = { version: 1, proxies: {}, sites: {}, totals: { requests: 0, ok: 0, blocked: 0, errors: 0, bytes: 0, costUsd: 0 }, updatedAt: null };
  if (persist && file && fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = { ...data, ...loaded, totals: { ...data.totals, ...(loaded.totals || {}) } };
    } catch { /* corrupt state: start fresh, keep running */ }
  }
  let timer = null;

  function site(name) {
    return (data.sites[name] ||= { tier: 0, okSinceEscalation: 0, vendor: null, presence: [], requests: 0, ok: 0, blocked: 0, errors: 0, bytes: 0, costUsd: 0, blocks: {}, lastOk: null, lastStep: null });
  }

  function recordAttempt(siteName, a) {
    const s = site(siteName);
    const t = data.totals;
    s.requests++;
    t.requests++;
    s.bytes += a.bytes || 0;
    t.bytes += a.bytes || 0;
    s.costUsd = +(s.costUsd + (a.costUsd || 0)).toFixed(6);
    t.costUsd = +(t.costUsd + (a.costUsd || 0)).toFixed(6);
    if (a.presence?.length) s.presence = [...new Set([...s.presence, ...a.presence])];
    if (a.outcome === 'ok') {
      s.ok++;
      t.ok++;
    } else if (a.outcome === 'blocked') {
      s.blocked++;
      t.blocked++;
      const k = `${a.vendor || 'unknown'}:${a.kind}`;
      s.blocks[k] = (s.blocks[k] || 0) + 1;
      if (a.vendor && !['origin', 'proxy'].includes(a.vendor)) s.vendor = a.vendor;
    } else {
      s.errors++;
      t.errors++;
    }
    scheduleSave();
  }

  function recordSuccess(siteName, tier, stepLabel) {
    const s = site(siteName);
    if (tier > s.tier) s.okSinceEscalation = 0;
    if (tier !== s.tier) s.tier = tier;
    s.okSinceEscalation++;
    s.lastOk = new Date().toISOString();
    s.lastStep = stepLabel;
    scheduleSave();
  }

  function scheduleSave() {
    if (!persist || !file) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      save();
    }, 1000);
    timer.unref?.();
  }

  function save() {
    if (!persist || !file) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    data.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    get data() {
      return data;
    },
    site,
    recordAttempt,
    recordSuccess,
    setProxyHealth(snapshot) {
      data.proxies = snapshot;
      scheduleSave();
    },
    save,
    reset() {
      data.proxies = {};
      data.sites = {};
      data.totals = { requests: 0, ok: 0, blocked: 0, errors: 0, bytes: 0, costUsd: 0 };
      save();
    },
  };
}
