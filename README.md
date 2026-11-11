# Anti-Bot Bypass & Proxy Rotator

A Node.js command-line tool and REST gateway that keeps large data extraction jobs running on sites protected by Cloudflare, DataDome, PerimeterX, Akamai and similar products. It rotates datacenter, residential and mobile proxies, recognises when a response is a block instead of real data, and climbs from fast, cheap HTTP to a stealth browser only when a site requires it.

**Stack:** JavaScript (Node.js 22+ ESM). The project card names Node.js + Axios, and a scraping CLI/gateway ships fastest as one runtime with no build step.
Main libraries: Axios with `http-proxy-agent` / `https-proxy-agent` / `socks-proxy-agent`, Puppeteer + `puppeteer-extra-plugin-stealth`, Cheerio.

## What it does

| Problem in scraping jobs | What the rotator does |
|---|---|
| The scraper saves "Just a moment..." or captcha pages as if they were data | Detects 10+ anti-bot products and block types (challenge, captcha, ban, rate limit, soft block) and never returns them as success |
| One IP gets banned and the whole job stops | Proxy pool with per-site bans, exponential cooldowns, dead-proxy detection, health-weighted rotation |
| Residential proxies are expensive | Escalation ladder: datacenter HTTP first, residential only for sites that need it, browser only for JS challenges. Each site remembers the cheapest step that works, and every 25 successes it tries one step cheaper again |
| Headless browsers are slow | After Chrome passes a challenge once, its clearance cookies + IP + exact User-Agent are reused over plain HTTP (`http:cleared`) |
| Headers that don't match each other give the bot away | Session = one consistent "visitor": same exit IP, same header fingerprint (UA, `sec-ch-ua`, platform, language by country) and the same cookie jar |
| No idea what a job will cost | Bandwidth and USD cost per proxy, per site and per job, plus a hard `BUDGET_USD` stop |
| Jobs crash halfway through | Resumable batch runner (JSONL), CSV with a clickable link per row, Ctrl+C stops cleanly |

### The escalation ladder

```
http:cleared         reuse the cookies of a browser that already passed this site's challenge
http:datacenter      cheapest, fastest           (~$0.5/GB)
http:residential     new residential session     (~$4/GB)
browser:residential  stealth Chrome solves JS challenges, then hands its cookies back to HTTP
browser:mobile       last resort, most trusted   (~$9/GB)
```

Steps without matching proxies are skipped. With no proxies at all, the same engines run directly from your machine (`http:direct`, `browser:direct`). Change the ladder with `LADDER=` or `--ladder`.

### Block detection

| Vendor | Recognised as |
|---|---|
| Cloudflare | JS challenge (`cf-mitigated`, "Just a moment"), 1020 ban, 1015 rate limit, "Attention required" captcha, Turnstile |
| DataDome | captcha (`captcha-delivery.com`), device-check interstitial (`rt:'i'`), `x-datadome` ban |
| PerimeterX / HUMAN | "Press & Hold" captcha, `_px` block pages |
| Akamai Bot Manager | "Access Denied / Reference #", sensor challenges |
| Imperva / Incapsula, AWS WAF, Kasada, Sucuri | challenge / captcha / ban pages and headers |
| Amazon, Google | robot-check / unusual-traffic captchas |
| Generic | HTTP 401/403/429/407, reCAPTCHA / hCaptcha walls, empty pages, `--must-contain` misses |

The tool also reports which protection a site uses even when a request passes, so `stats` shows what each site needs.

## Quick start

```bash
npm install
npm install-scripts approve puppeteer && npm rebuild puppeteer   # npm 11 blocks Puppeteer's Chrome download otherwise
cp .env.example .env                                              # set PROXY_FILE / PROXIES
node bin/antibot.js doctor
node bin/antibot.js demo          # offline lab, no proxies or internet needed
```

The demo starts fake protected sites (Cloudflare-style JS challenge, DataDome-style datacenter ban, rate limit, flaky origin, robots.txt rule) and fake proxies (2 datacenter, 1 dead, 1 residential gateway with password, 1 mobile) on localhost. It then runs a job across them:

```
OK    open   /open/1      http:datacenter       attempts=1  price=$22.50
OK    dd     /dd/1        http:residential      attempts=2  price=$22.50
OK    rate   /rate/5      http:datacenter       attempts=3  price=$36.50
OK    cf     /cf/1        browser:residential   attempts=3  price=$22.50
FAIL  open   /private/..  -                     attempts=0  disallowed by robots.txt
16/17 pages extracted
```

## Commands

```bash
antibot fetch <url> [--render] [--field name=css] [--must-contain txt] [--wait-for css] [--session name] [--country de] [-o page.html] [--json]
antibot run urls.txt|urls.csv|job.json [-o out/] [--field ...] [-c 8] [--save-html] [--fresh]
antibot serve [--port 8787] [--host 0.0.0.0]                 # REST gateway
antibot detect <url> [--json]                               # which protection, and what it will need
antibot proxies list | check [--target url] | reset         # health, exit IPs, gateway rotation, clear bans
antibot stats [--json]                                      # success, blocks by vendor, bandwidth, $ per site
antibot demo [--no-browser]
antibot doctor
```

Global: `-p proxies.txt`, `--proxy <url>` (repeatable), `--ladder`, `--strategy weighted|round-robin|random|least-used`, `--state`, `--budget 25`, `--delay 2000`, `--no-browser`, `--ignore-robots`, `-q`.

### Field extraction

`name=selector` for text, `name=selector@attr` for an attribute (links made absolute), `name=selector[]` for all matches, `name=@jsonld` for the first schema.org block. Example:

```bash
antibot run products.csv --field "title=h1" --field "price=.price" --field "image=img.main@src" -o out/shop
```

Output: `out/shop/data.csv` (fields, extra CSV columns, step, proxy type, cost, error, `=HYPERLINK` link), `results.jsonl`, `summary.json`, optional `html/`. Running again resumes and retries only the failed URLs.

### Proxy formats

```
http://user:pass@host:port          host:port          host:port:user:pass          socks5://host:port
http://customer-X-session-{session}-cc-{country}:PASS@gate.provider.com:7000 type=residential cost=4
```

Tags: `type=datacenter|residential|mobile|isp`, `country=us`, `cost=` (USD/GB), `id=`. JSON lists work too (see `examples/`). `{session}` turns a provider gateway (Bright Data, Oxylabs, Decodo/Smartproxy, IPRoyal, SOAX, NetNut ...) into unlimited sticky sessions. A block on a gateway only retires that session, never the whole gateway.

## REST gateway

```bash
API_KEY=change-me antibot serve --host 0.0.0.0
curl "http://localhost:8787/v1/fetch?url=https://example.com&fields=title=h1&no_body=1" -H "x-api-key: change-me"
curl -X POST localhost:8787/v1/fetch -H "x-api-key: change-me" -H "content-type: application/json" \
  -d '{"url":"https://example.com","render":true,"country":"de","mustContain":"Example","fields":["title=h1"]}'
curl "localhost:8787/v1/fetch?url=https://example.com&raw=1&api_key=change-me"     # original body + x-antibot-* headers
```

Returns `ok, status, step, proxyType, protection, attempts[], bytes, costUsd, fields, body`. Blocked pages give HTTP 502 with `block.vendor/kind`. `/v1/stats` and `/v1/proxies` expose per-site and per-proxy health, with credentials masked. It refuses to listen on a public interface without `API_KEY`. It works from n8n/Make HTTP nodes, Python (`examples/client.py`) or any language.

## As a library

```js
import { createFetcher } from 'anti-bot-bypass-and-proxy-rotator';
const f = createFetcher({ proxyFile: 'proxies.txt', budgetUsd: 20 });
const r = await f.fetch('https://shop.example/p/1', { mustContain: 'add to cart' });
if (r.ok) parse(r.body); else console.log(r.error, r.block?.vendor);
await f.close();
```

## Docker

```bash
docker compose up -d --build     # gateway on :8787, system Chromium, proxies.txt and data/ mounted
```

## Tests

```bash
npm test     # 29 tests, no network: fake sites + fake proxies; the real-Chrome test is skipped if Chrome is missing
```

## Limits and responsible use

- No tool guarantees access. The hardest targets (DataDome or PerimeterX on top sites) fingerprint TLS and behaviour; Node's TLS stack differs from Chrome's, which is why the browser step exists. Success there depends mostly on proxy quality (residential/mobile) and a slow request rate.
- Interactive captchas are **not solved**. They are reported as `captcha` and answered with a cleaner IP and the browser. Pages are never stored as data when they are blocks.
- robots.txt is respected by default, there are per-site delays and concurrency caps, and Retry-After is honoured. Only use `--ignore-robots` on sites you are allowed to crawl.
- You are responsible for following each site's terms, copyright and data-protection law (GDPR/CCPA) for what you collect. Prefer official APIs or data partnerships when they exist. Collect public data only. Never collect login-protected personal data.

## License

MIT
