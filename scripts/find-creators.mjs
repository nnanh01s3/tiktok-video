/**
 * Scrape Douyin user search to find creator profiles for a niche.
 * Outputs creator URL + name + sec_uid for the pipeline's --creator flag.
 */
import "../src/env.js";
import { withDouyinChrome } from "../src/douyin/utils/cdp.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const keyword = process.argv[2] || "百岁觉醒";
const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=user`;

console.log(`Searching users for: ${keyword}`);
console.log(`URL: ${url}`);

const creators = await withDouyinChrome(url, async (cdp) => {
  await sleep(8000);
  for (let i = 0; i < 5; i++) {
    await cdp("Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
    await sleep(1500);
  }

  const res = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: `
      (() => {
        // User cards on Douyin search page typically have:
        // <a href="/user/MS4wLjABAAAA...">
        //   <img alt="creator name"> ...
        // </a>
        // Plus data attributes on parent containers.
        const out = [];
        const seen = new Set();

        // Strategy 1: a[href*="/user/"]
        document.querySelectorAll('a[href*="/user/"]').forEach(a => {
          const m = a.href.match(/\\/user\\/([A-Za-z0-9_-]+)/);
          if (!m) return;
          const secUid = m[1];
          if (seen.has(secUid)) return;
          seen.add(secUid);
          // Find creator name from img alt or nested text
          const img = a.querySelector('img[alt]');
          const name = img?.getAttribute('alt') || a.innerText.split('\\n')[0]?.trim() || '';
          out.push({
            sec_uid: secUid,
            url: 'https://www.douyin.com/user/' + secUid,
            name: name.slice(0, 60),
          });
        });

        // Strategy 2: data-* attributes
        document.querySelectorAll('[data-sec-uid]').forEach(el => {
          const id = el.getAttribute('data-sec-uid');
          if (!id || seen.has(id)) return;
          seen.add(id);
          out.push({
            sec_uid: id,
            url: 'https://www.douyin.com/user/' + id,
            name: el.getAttribute('data-name') || (el.innerText || '').split('\\n')[0]?.trim() || '',
          });
        });

        return out;
      })()
    `,
  });
  return res.result.value || [];
}, { headless: false, waitMs: 8000 });

console.log(`Found ${creators.length} creators`);
for (const c of creators.slice(0, 15)) {
  console.log(`  ${c.url}`);
  console.log(`    name: ${c.name}`);
}
