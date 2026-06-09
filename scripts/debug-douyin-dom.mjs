/**
 * One-off DOM dumper for Douyin debugging.
 * Loads URL, dumps full HTML + all anchor hrefs + screenshot to disk.
 */
import "../src/env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDouyinChrome } from "../src/douyin/utils/cdp.mjs";
import { DOUYIN_CONFIG } from "../src/douyin/config.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const arg = process.argv[2] || "百岁觉醒";
const url = /^\d{15,20}$/.test(arg)
  ? `https://www.douyin.com/video/${arg}`
  : `https://www.douyin.com/jingxuan/search/${encodeURIComponent(arg)}?type=general`;

console.log(`Loading: ${url}`);

const result = await withDouyinChrome(url, async (cdp) => {
  await sleep(8000);
  const html = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: "document.documentElement.outerHTML",
  });
  const title = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: "document.title",
  });
  const videoSrc = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: "document.querySelector('video')?.src || ''",
  });
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  return {
    title: title.result.value,
    html: html.result.value,
    videoSrc: videoSrc.result.value,
    screenshot_b64: screenshot.data,
  };
}, { headless: false, waitMs: 8000 });

const outDir = DOUYIN_CONFIG.baseDir;
writeFileSync(join(outDir, "debug_dom.html"), result.html);
writeFileSync(join(outDir, "debug_screenshot.png"), Buffer.from(result.screenshot_b64, "base64"));

console.log("Page title:", result.title);
console.log("Video element src:", result.videoSrc.slice(0, 200));
console.log(`HTML → ${join(outDir, "debug_dom.html")} (${result.html.length} bytes)`);
console.log(`Screenshot → ${join(outDir, "debug_screenshot.png")}`);
