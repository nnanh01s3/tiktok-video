/**
 * Probe a Douyin video page for its 合集 (mix/collection) membership.
 * Captures aweme detail + mix API responses, prints mix_id + mix_name.
 *
 * Usage: node scripts/probe-mix.mjs <modal_id>
 */
import "../src/env.js";
import { withDouyinChrome } from "../src/douyin/utils/cdp.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const modalId = process.argv[2];
if (!modalId) { console.error("usage: probe-mix.mjs <modal_id>"); process.exit(1); }

const url = `https://www.douyin.com/video/${modalId}`;
console.log(`Probing: ${url}`);

const found = await withDouyinChrome(url, async (cdp, ws) => {
  const bodies = [];
  ws.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.method === "Network.responseReceived") {
        const u = m.params.response.url;
        if (/aweme\/detail|mix\/(aweme|list|detail)/.test(u)) {
          bodies.push({ requestId: m.params.requestId, url: u });
        }
      }
    } catch {}
  });

  await cdp("Page.navigate", { url });
  await sleep(8000);

  const mixes = new Map();
  for (const { requestId, url: u } of bodies) {
    try {
      const body = await cdp("Network.getResponseBody", { requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      // Find all mix_info objects
      const re = /"mix_id":"(\d+)"[^}]{0,400}?"mix_name":"([^"]{0,80})"/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        mixes.set(m[1], m[2]);
      }
      // Alternate ordering
      const re2 = /"mix_name":"([^"]{0,80})"[^}]{0,400}?"mix_id":"(\d+)"/g;
      while ((m = re2.exec(text)) !== null) {
        if (!mixes.has(m[2])) mixes.set(m[2], m[1]);
      }
    } catch {}
  }
  return [...mixes.entries()];
}, { headless: false, waitMs: 4000 });

if (!found.length) {
  console.log("No mix/collection info found — video may not belong to a 合集.");
} else {
  console.log(`Found ${found.length} collection(s):`);
  for (const [id, name] of found) {
    console.log(`  mix_id: ${id}`);
    console.log(`  name:   ${name}`);
    console.log(`  url:    https://www.douyin.com/collection/${id}`);
  }
}
