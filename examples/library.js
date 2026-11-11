// Use the rotator inside your own Node scraper.
import { createFetcher } from '../src/index.js';

const f = createFetcher({ proxyFile: 'proxies.txt' });
const r = await f.fetch('https://example.com/', { mustContain: 'Example' });
console.log(r.ok ? `ok via ${r.step}, ${r.bytes} bytes, $${r.costUsd}` : `failed: ${r.error}`);
await f.close();
