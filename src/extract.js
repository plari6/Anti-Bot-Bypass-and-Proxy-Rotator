// CSS field extraction for job runs. Field spec "name=selector" with optional suffixes:
//   title=h1                 text of the first match
//   image=img.main@src       attribute (relative links become absolute)
//   tags=.tag[]              every match, joined with " | "
//   jsonld=@jsonld           first schema.org JSON-LD block (Product, Offer, ...) as JSON text
import * as cheerio from 'cheerio';

export function parseFieldSpecs(specs = []) {
  const list = Array.isArray(specs) ? specs : [specs];
  const out = [];
  for (const spec of list) {
    if (spec && typeof spec === 'object') {
      for (const [name, sel] of Object.entries(spec)) out.push(parseOne(`${name}=${sel}`));
      continue;
    }
    if (!spec) continue;
    out.push(parseOne(String(spec)));
  }
  return out;
}

function parseOne(spec) {
  const eq = spec.indexOf('=');
  if (eq < 1) throw new Error(`field must look like name=selector (got "${spec}")`);
  const name = spec.slice(0, eq).trim();
  let selector = spec.slice(eq + 1).trim();
  if (selector === '@jsonld') return { name, jsonld: true };
  let all = false;
  if (selector.endsWith('[]')) {
    all = true;
    selector = selector.slice(0, -2);
  }
  let attr = null;
  const at = selector.lastIndexOf('@');
  if (at > 0 && !/[\]'"]/.test(selector.slice(at))) {
    attr = selector.slice(at + 1);
    selector = selector.slice(0, at);
  }
  return { name, selector, attr, all };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function extractFields(html, fields, baseUrl) {
  const $ = cheerio.load(html || '');
  const row = {};
  for (const f of fields) {
    if (f.jsonld) {
      row[f.name] = firstJsonLd($);
      continue;
    }
    const nodes = $(f.selector);
    const valueOf = (el) => {
      if (!f.attr) return clean($(el).text());
      let v = $(el).attr(f.attr) ?? '';
      if (/^(href|src|data-src|srcset|action)$/i.test(f.attr) && v && baseUrl) {
        try {
          v = new URL(v.split(/\s+/)[0], baseUrl).toString();
        } catch { /* keep raw */ }
      }
      return clean(v);
    };
    row[f.name] = f.all ? nodes.toArray().map(valueOf).filter(Boolean).join(' | ') : nodes.length ? valueOf(nodes[0]) : '';
  }
  return row;
}

function firstJsonLd($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const j = JSON.parse($(el).contents().text());
      return JSON.stringify(j);
    } catch { /* invalid block, try next */ }
  }
  return '';
}

/** Quick page facts for `fetch` output. */
export function pageSummary(html) {
  const $ = cheerio.load(html || '');
  return {
    title: clean($('title').first().text()).slice(0, 200),
    h1: clean($('h1').first().text()).slice(0, 200),
    links: $('a[href]').length,
    jsonLd: $('script[type="application/ld+json"]').length,
    textLength: clean($('body').text()).length,
  };
}
