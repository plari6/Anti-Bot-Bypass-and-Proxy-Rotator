import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDemoLab } from '../src/demo.js';
import { parseProxyList } from '../src/proxy/parse.js';
import { createFetcher } from '../src/fetcher.js';

process.env.ANTIBOT_SKIP_DOTENV = '1';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antibot-test-'));
}

/** Lab + fetcher wired to the fake proxies; no network, no Chrome unless asked. */
export async function labFetcher(over = {}) {
  const lab = await startDemoLab();
  const dir = tmpDir();
  const { proxies } = parseProxyList(lab.proxyLines.join('\n'));
  const fetcher = createFetcher({
    proxyList: over.proxyList || proxies,
    stateFile: path.join(dir, 'state.json'),
    domainDelayMs: 0,
    banBaseMs: 60000,
    retriesPerStep: 3,
    timeoutMs: 4000,
    noBrowser: true,
    bypassLoopback: true,
    log: () => {},
    ...over,
  });
  const port = lab.site.port;
  return {
    lab,
    fetcher,
    dir,
    url: (sub, p) => `http://${sub}.demo.test:${port}${p}`,
    async close() {
      await fetcher.close();
      await lab.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
