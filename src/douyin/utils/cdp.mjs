/**
 * Chrome CDP helper for Douyin scraping.
 * Variant of fb_repost.mjs withChrome — but uses a PERSISTENT user-data-dir
 * (so Douyin login session survives across runs) instead of throwaway profile.
 *
 * Usage:
 *   await withDouyinChrome(url, async (cdp) => {
 *     await cdp("Runtime.evaluate", { expression: "..." });
 *   });
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { DOUYIN_CONFIG } from "../config.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pickPort() {
  return DOUYIN_CONFIG.chromeRemotePortBase + Math.floor(Math.random() * 100);
}

export async function withDouyinChrome(url, fn, { headless = true, waitMs = 6000 } = {}) {
  const port = pickPort();
  mkdirSync(DOUYIN_CONFIG.chromeUserDataDir, { recursive: true });

  const args = [
    headless ? "--headless=new" : "--start-maximized",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${DOUYIN_CONFIG.chromeUserDataDir}`,
    "--window-size=1280,1800",
    "--no-first-run",
    "--disable-blink-features=AutomationControlled",
    url,
  ];

  const proc = spawn(`"${DOUYIN_CONFIG.chromePath}"`, args, {
    shell: true, detached: true, stdio: "ignore",
  });
  proc.unref();

  await sleep(5000);

  try {
    const tabsRes = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(10000),
    });
    const tabs = await tabsRes.json();
    const tab = tabs.find(t => t.type === "page") || tabs[0];
    if (!tab?.webSocketDebuggerUrl) throw new Error("No CDP tab found");

    const { default: WS } = await import("ws");
    const ws = new WS(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });

    const cdp = (method, params = {}) => new Promise((res, rej) => {
      const id = Math.floor(Math.random() * 1e8);
      const handler = d => {
        const m = JSON.parse(d.toString());
        if (m.id === id) { ws.off("message", handler); res(m.result); }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { ws.off("message", handler); rej(new Error("CDP timeout: " + method)); }, 20000);
    });

    await cdp("Page.enable");
    await cdp("Network.enable");
    await sleep(waitMs);

    const result = await fn(cdp, ws);
    ws.close();
    return result;
  } finally {
    try { proc.kill(); } catch {}
    spawnSync(`taskkill /F /PID ${proc.pid} 2>nul`, { shell: true, timeout: 5000 });
  }
}
