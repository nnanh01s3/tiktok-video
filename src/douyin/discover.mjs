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
  // /jingxuan/search/ (curated search) loads results in a stable cards layout
  // even for logged-in sessions. /search/ alone tends to render empty in
  // automated browsers (anti-bot or React route mismatch).
  return `https://www.douyin.com/jingxuan/search/${encodeURIComponent(keyword)}?type=general`;
}

export async function discover({ keyword, creator, maxResults = DOUYIN_CONFIG.maxPerRun }) {
  if (!keyword && !creator) throw new Error("discover requires keyword or creator");
  const url = creator || buildSearchUrl(keyword);
  log.info("discover", `→ ${url}`);

  const candidates = await withDouyinChrome(url, async (cdp) => {
    // Wait for initial render then scroll to load lazy cards
    await sleep(3000);
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
          // Douyin's jingxuan-search renders cards as <li data-id="..." data-text="...">.
          // Class names are webpack-mangled so we anchor on data-* attributes.
          // Fallback: any element with data-id matching a 19-digit aweme id.
          const cards = [...document.querySelectorAll('li[data-id][data-text], div[data-id][data-text]')];
          const seen = new Set();
          const out = [];
          for (const card of cards) {
            const id = card.getAttribute('data-id');
            if (!/^\\d{15,20}$/.test(id || '')) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            const title = card.getAttribute('data-text') || '';
            const txt = card.innerText || '';
            // Match view count like '2.3万' / '12k' / '1.5w'. View label varies
            // by locale ('点赞' for likes, '观看' for views).
            const vm = txt.match(/([0-9]+(?:\\.[0-9]+)?\\s*[万wk])/i);
            const view_text = vm ? vm[1] : '';
            // Duration label like '10:49' / '03:13' often appears in card text.
            const dm = txt.match(/\\b([0-9]{1,2}:[0-9]{2})\\b/);
            const duration_text = dm ? dm[1] : '';
            out.push({
              modal_id: id,
              url: 'https://www.douyin.com/video/' + id,
              title,
              view_text,
              duration_text,
            });
          }
          return out;
        })()
      `,
    });

    return evalRes?.result?.value || [];
  }, { headless: false, waitMs: 6000 });

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
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const keyword = process.argv[2] || DOUYIN_CONFIG.keywords[0];
  discover({ keyword, maxResults: 5 })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
