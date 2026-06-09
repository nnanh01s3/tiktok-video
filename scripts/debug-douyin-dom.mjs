/**
 * One-off DOM dumper for Douyin debugging.
 * Loads search URL, dumps full HTML + all anchor hrefs to disk.
 */
import "../src/env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDouyinChrome } from "../src/douyin/utils/cdp.mjs";
import { DOUYIN_CONFIG } from "../src/douyin/config.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const keyword = process.argv[2] || "百岁觉醒";
// Try jingxuan-search (curated search) which is less anti-bot guarded
const url = `https://www.douyin.com/jingxuan/search/${encodeURIComponent(keyword)}?type=general`;

console.log(`Loading: ${url}`);

const result = await withDouyinChrome(url, async (cdp) => {
  // Scroll a few times
  for (let i = 0; i < 5; i++) {
    await cdp("Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
    await sleep(1500);
  }

  const html = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: "document.documentElement.outerHTML",
  });

  const anchors = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: `
      Array.from(document.querySelectorAll('a')).slice(0, 200).map(a => ({
        href: a.href,
        text: (a.innerText || '').slice(0, 100),
      }))
    `,
  });

  const title = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: "document.title",
  });

  // Take screenshot
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });

  return {
    title: title.result.value,
    html: html.result.value,
    anchors: anchors.result.value,
    screenshot_b64: screenshot.data,
  };
}, { headless: false, waitMs: 8000 });

const outDir = DOUYIN_CONFIG.baseDir;
writeFileSync(join(outDir, "debug_dom.html"), result.html);
writeFileSync(join(outDir, "debug_anchors.json"), JSON.stringify(result.anchors, null, 2));
writeFileSync(join(outDir, "debug_screenshot.png"), Buffer.from(result.screenshot_b64, "base64"));

console.log("Page title:", result.title);
console.log("Anchors count:", result.anchors.length);
console.log("Video links:", result.anchors.filter(a => /\/video\//.test(a.href)).length);
console.log("Sample anchors (first 10):");
result.anchors.slice(0, 10).forEach((a, i) => {
  console.log(`  ${i+1}. [${a.href.slice(0, 80)}]  "${a.text.slice(0, 60)}"`);
});
console.log(`\nFull dump:\n  HTML → ${join(outDir, "debug_dom.html")} (${result.html.length} bytes)`);
console.log(`  Anchors → ${join(outDir, "debug_anchors.json")}`);
console.log(`  Screenshot → ${join(outDir, "debug_screenshot.png")}`);
