/**
 * Discover Douyin candidate videos by keyword or creator URL.
 *
 * Returns array of: { modal_id, url, title, view_count, view_text }
 *
 * Errors:
 *   - Empty results → save debug JSON for DOM-drift, throw
 */
import "../env.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withDouyinChrome } from "./utils/cdp.mjs";
import { parseViewCount } from "./utils/parseViewCount.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildSearchUrl(keyword) {
  return `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`;
}

export async function discover({ keyword, creator, maxResults = DOUYIN_CONFIG.maxPerRun }) {
  if (!keyword && !creator) throw new Error("discover requires keyword or creator");
  const url = creator || buildSearchUrl(keyword);
  log.info("discover", `→ ${url}`);

  const candidates = await withDouyinChrome(url, async (cdp) => {
    for (let i = 0; i < 8; i++) {
      await cdp("Runtime.evaluate", {
        expression: "window.scrollTo(0, document.body.scrollHeight)",
      });
      await sleep(1500);
    }

    const evalRes = await cdp("Runtime.evaluate", {
      returnByValue: true,
      expression: `
        (() => {
          const links = [...document.querySelectorAll('a[href*="/video/"]')];
          const seen = new Set();
          const out = [];
          for (const a of links) {
            const m = a.href.match(/\\/video\\/(\\d+)/);
            if (!m) continue;
            const id = m[1];
            if (seen.has(id)) continue;
            seen.add(id);
            const titleEl = a.querySelector('[data-e2e="search-card-title"], img[alt]');
            const title = titleEl?.innerText || titleEl?.getAttribute('alt') || '';
            let viewText = '';
            const txt = a.innerText || '';
            const vm = txt.match(/([\\d.]+\\s*[万wk万])/i);
            if (vm) viewText = vm[1];
            out.push({ modal_id: id, url: a.href, title, view_text: viewText });
          }
          return out;
        })()
      `,
    });

    return evalRes?.result?.value || [];
  });

  if (!candidates.length) {
    mkdirSync(DOUYIN_CONFIG.baseDir, { recursive: true });
    const debugPath = join(DOUYIN_CONFIG.baseDir, `discover-empty-${Date.now()}.json`);
    writeFileSync(debugPath, JSON.stringify({ url, ts: new Date().toISOString() }, null, 2));
    throw new Error(`discover: no candidates for ${url}. DOM may have drifted. Debug: ${debugPath}`);
  }

  const enriched = candidates
    .map(c => ({ ...c, view_count: parseViewCount(c.view_text) }))
    .filter(c => c.view_count >= DOUYIN_CONFIG.minViewCount || c.view_count === 0);

  enriched.sort((a, b) => b.view_count - a.view_count);
  const top = enriched.slice(0, maxResults);
  log.info("discover", `found ${candidates.length} → kept ${top.length}`);
  return top;
}

// CLI smoke test
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const keyword = process.argv[2] || DOUYIN_CONFIG.keywords[0];
  discover({ keyword, maxResults: 5 })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
