// Strong engine: one headless Chrome with puppeteer-extra-plugin-stealth. Each request gets its own
// incognito browser context with its own proxy (Puppeteer per-context proxyServer), so many proxies
// share one Chrome process. The page waits out JavaScript challenges (Cloudflare "Just a moment",
// DataDome device check, Akamai/Imperva interstitials) and then hands the clearance cookies and the
// exact User-Agent back to the session, so the next requests can go over fast HTTP again.
import fs from 'node:fs';
import path from 'node:path';
import { detectBlock } from '../detect.js';
import { semaphore, sleep, jitter } from '../util.js';

export function createBrowserEngine(settings = {}) {
  let browserP = null;
  const limit = semaphore(settings.browserConcurrency || 2);

  async function getBrowser() {
    if (!browserP) {
      browserP = (async () => {
        const { default: puppeteer } = await import('puppeteer-extra');
        const { default: Stealth } = await import('puppeteer-extra-plugin-stealth');
        puppeteer.use(Stealth());
        const args = [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1366,900',
          '--no-first-run',
          '--no-default-browser-check',
        ];
        const b = await puppeteer.launch({ headless: settings.headless !== false, executablePath: settings.chromePath || undefined, args, defaultViewport: null });
        b.on('disconnected', () => {
          browserP = null;
        });
        return b;
      })().catch((err) => {
        browserP = null;
        throw err;
      });
    }
    return browserP;
  }

  /**
   * @param {{url:string, proxyUrl?:string|null, jar?:object, acceptLanguage?:string, timeoutMs?:number,
   *          waitForSelector?:string, challengeWaitMs?:number, mustContain?:string|RegExp, bypassLoopback?:boolean}} req
   */
  async function fetchPage(req) {
    return limit(async () => {
      const t0 = Date.now();
      const browser = await getBrowser();
      let proxyServer;
      let auth = null;
      if (req.proxyUrl) {
        const u = new URL(req.proxyUrl);
        if (/^socks/i.test(u.protocol) && u.username) throw new Error('Chrome cannot use SOCKS proxies with a username/password; use the HTTP port of your provider');
        proxyServer = `${u.protocol.replace('socks:', 'socks5:')}//${u.host}`;
        if (u.username) auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
      }
      const ctx = await browser.createBrowserContext(
        proxyServer ? { proxyServer, proxyBypassList: req.bypassLoopback ? ['<-loopback>'] : [] } : {},
      );
      const page = await ctx.newPage();
      let bytes = 0;
      let mainStatus = 0;
      let mainHeaders = {};
      try {
        if (auth) await page.authenticate(auth);
        await page.setViewport({ width: 1280 + Math.floor(Math.random() * 160), height: 760 + Math.floor(Math.random() * 120) });
        if (req.acceptLanguage) await page.setExtraHTTPHeaders({ 'accept-language': req.acceptLanguage });
        const seed = req.jar?.toBrowserCookies(req.url) || [];
        if (seed.length) await (ctx.setCookie ? ctx.setCookie(...seed) : page.setCookie(...seed)).catch(() => {});

        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable').catch(() => {});
        cdp.on('Network.loadingFinished', (e) => {
          bytes += e.encodedDataLength || 0;
        });

        if (settings.blockAssets !== false) {
          await page.setRequestInterception(true);
          page.on('request', (r) => {
            if (r.isInterceptResolutionHandled()) return;
            const t = r.resourceType();
            if (t === 'image' || t === 'media' || t === 'font') r.abort().catch(() => {});
            else r.continue().catch(() => {});
          });
        }
        page.on('response', (r) => {
          try {
            if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) {
              mainStatus = r.status();
              mainHeaders = r.headers();
            }
          } catch { /* detached frame */ }
        });

        const resp = await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: req.timeoutMs || 45000 });
        if (resp && !mainStatus) {
          mainStatus = resp.status();
          mainHeaders = resp.headers();
        }

        // Wait while the page is still an interstitial challenge (it reloads itself when solved).
        const deadline = Date.now() + (req.challengeWaitMs ?? 20000);
        let verdict = detectBlock({ status: mainStatus, headers: mainHeaders, body: await safeContent(page) });
        while (verdict.blocked && verdict.kind === 'challenge' && Date.now() < deadline) {
          await Promise.race([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => {}), sleep(4000)]);
          verdict = detectBlock({ status: mainStatus, headers: mainHeaders, body: await safeContent(page) });
        }
        await Promise.all([
          page.waitForNetworkIdle({ idleTime: 600, timeout: 6000 }).catch(() => {}),
          req.waitForSelector ? page.waitForSelector(req.waitForSelector, { timeout: 10000 }).catch(() => {}) : null,
        ]);
        // A little human-like movement and scroll: some sensors only "trust" after input events.
        await page.mouse.move(200 + Math.random() * 400, 200 + Math.random() * 300, { steps: 8 }).catch(() => {});
        await page.evaluate(() => window.scrollBy(0, 250 + Math.random() * 450)).catch(() => {});
        await sleep(jitter(500));

        const body = await safeContent(page);
        const cookies = ctx.cookies ? await ctx.cookies().catch(() => page.cookies()) : await page.cookies();
        const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
        req.jar?.importBrowserCookies(cookies);
        return {
          status: mainStatus || 200,
          headers: mainHeaders,
          body,
          encoding: 'utf8',
          contentType: mainHeaders['content-type'] || 'text/html',
          finalUrl: page.url(),
          bytes,
          ms: Date.now() - t0,
          cookies: cookies.map((c) => c.name),
          userAgent,
        };
      } catch (err) {
        if (settings.debugDir) await screenshot(page, settings.debugDir, req.url);
        throw err;
      } finally {
        await ctx.close().catch(() => {});
      }
    });
  }

  return {
    fetchPage,
    get launched() {
      return Boolean(browserP);
    },
    async close() {
      if (!browserP) return;
      const b = await browserP.catch(() => null);
      browserP = null;
      await b?.close().catch(() => {});
    },
  };
}

async function safeContent(page) {
  for (let i = 0; i < 3; i++) {
    try {
      return await page.content();
    } catch {
      await sleep(400); // page navigating (challenge reload)
    }
  }
  return '';
}

async function screenshot(page, dir, url) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${new URL(url).hostname}-${Date.now()}.png`) });
  } catch { /* best effort */ }
}

/** Is a Chrome binary available for Puppeteer? */
export async function browserAvailable(chromePath) {
  if (chromePath) return fs.existsSync(chromePath);
  try {
    const { default: puppeteer } = await import('puppeteer');
    const p = await puppeteer.executablePath(); // async since Puppeteer 25
    return Boolean(p && fs.existsSync(p));
  } catch {
    return false;
  }
}
