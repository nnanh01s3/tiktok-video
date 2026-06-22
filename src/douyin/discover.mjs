/**
 * Discover Douyin candidate videos by keyword or creator URL.
 *
 * Strategy: intercept Douyin's own search/post API responses via CDP Network
 * events instead of scraping the DOM. The web app loads results through XHR
 * (`/aweme/v1/web/general/search/single/` for search, `/aweme/v1/web/aweme/post/`
 * for creator profiles) — the JSON has true aweme_id, title, duration and
 * stats. DOM scraping broke twice: class names are webpack-mangled, and the
 * only stable-looking attributes (li[data-id]) turned out to be related-search
 * suggestions whose ids LOOK like video ids but are not.
 *
 * Returns array of:
 *   { modal_id, url, title, duration_sec, view_count, like_count, author }
 *
 * Errors:
 *   - Empty results → save debug JSON for DOM-drift, throw
 */
import "../env.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withDouyinChrome } from "./utils/cdp.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildSearchUrl(keyword) {
  return `https://www.douyin.com/jingxuan/search/${encodeURIComponent(keyword)}?type=general`;
}

// API endpoints that carry video lists
const API_PATTERNS = [
  /\/aweme\/v\d+\/web\/general\/search\/single\//,   // keyword search
  /\/aweme\/v\d+\/web\/search\/item\//,              // video-tab search
  /\/aweme\/v\d+\/web\/aweme\/post\//,               // creator profile posts
  /\/aweme\/v\d+\/web\/mix\/aweme\//,                // collection (合集) episodes
];

/** Normalize one aweme JSON object into our candidate shape. */
function toCandidate(aweme) {
  if (!aweme?.aweme_id) return null;
  return {
    modal_id: String(aweme.aweme_id),
    url: `https://www.douyin.com/video/${aweme.aweme_id}`,
    title: (aweme.desc || "").slice(0, 120),
    duration_sec: aweme.video?.duration ? Math.round(aweme.video.duration / 1000) : 0,
    view_count: aweme.statistics?.play_count || 0,
    like_count: aweme.statistics?.digg_count || 0,
    author: aweme.author?.nickname || "",
    author_sec_uid: aweme.author?.sec_uid || "",
  };
}

/** Extract aweme objects from any of the known API response shapes. */
function extractAwemes(json) {
  const out = [];
  // search/single + search/item: { data: [{ aweme_info: {...} }, ...] }
  if (Array.isArray(json?.data)) {
    for (const item of json.data) {
      if (item?.aweme_info) out.push(item.aweme_info);
      // mix/collection cards nest differently
      if (Array.isArray(item?.aweme_list)) out.push(...item.aweme_list);
    }
  }
  // aweme/post + mix/aweme: { aweme_list: [...] }
  if (Array.isArray(json?.aweme_list)) out.push(...json.aweme_list);
  return out;
}

export async function discover({ keyword, creator, maxResults = DOUYIN_CONFIG.maxPerRun }) {
  if (!keyword && !creator) throw new Error("discover requires keyword or creator");
  const url = creator || buildSearchUrl(keyword);
  log.info("discover", `→ ${url}`);

  const collected = new Map(); // modal_id → candidate

  await withDouyinChrome(url, async (cdp, ws) => {
    // Track API responses; bodies must be fetched after responseReceived.
    const pendingBodies = [];
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.method === "Network.responseReceived") {
          const u = m.params.response.url;
          if (API_PATTERNS.some((re) => re.test(u))) {
            pendingBodies.push(m.params.requestId);
          }
        }
      } catch {}
    });

    async function drainBodies() {
      while (pendingBodies.length) {
        const requestId = pendingBodies.shift();
        try {
          const body = await cdp("Network.getResponseBody", { requestId });
          const text = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf8")
            : body.body;
          const json = JSON.parse(text);
          for (const aweme of extractAwemes(json)) {
            const c = toCandidate(aweme);
            if (c && !collected.has(c.modal_id)) collected.set(c.modal_id, c);
          }
        } catch {} // body may be evicted — fine, scrolling re-triggers more
      }
    }

    // Re-navigate to trigger the initial API call now that our listener is up
    // (the first load happened during Chrome launch, before ws connected).
    await cdp("Page.navigate", { url });
    await sleep(6000);
    await drainBodies();

    // Scroll to trigger pagination — each scroll fires another API page
    // (~10-20 items each). Scale scroll count to the requested result size
    // so deep scans (e.g. enumerating a 190-episode series) paginate far
    // enough. Stop early when the page stops yielding new items.
    const maxScrolls = Math.min(60, Math.ceil(maxResults / 8) + 8);
    let lastSize = collected.size;
    let stale = 0;
    for (let i = 0; i < maxScrolls; i++) {
      await cdp("Runtime.evaluate", {
        expression: "window.scrollTo(0, document.body.scrollHeight)",
      });
      await sleep(2000);
      await drainBodies();
      if (collected.size >= maxResults) break;
      // No new items in 4 consecutive scrolls → reached the end
      stale = collected.size === lastSize ? stale + 1 : 0;
      lastSize = collected.size;
      if (stale >= 4) break;
    }
  }, { headless: false, waitMs: 4000 });

  if (!collected.size) {
    mkdirSync(DOUYIN_CONFIG.baseDir, { recursive: true });
    const debugPath = join(DOUYIN_CONFIG.baseDir, `discover-empty-${Date.now()}.json`);
    writeFileSync(debugPath, JSON.stringify({ url, ts: new Date().toISOString() }, null, 2));
    throw new Error(`discover: no candidates for ${url}. DOM may have drifted. Debug: ${debugPath}`);
  }

  // Sort newest-first by modal_id (encodes upload timestamp)
  const all = [...collected.values()];
  all.sort((a, b) => (BigInt(b.modal_id) > BigInt(a.modal_id) ? 1 : -1));
  const top = all.slice(0, maxResults);
  log.info("discover", `captured ${all.length} via API → returning ${top.length}`);
  return top;
}

// CLI smoke test
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const keyword = process.argv[2] || DOUYIN_CONFIG.keywords[0];
  discover({ keyword, maxResults: 20 })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
