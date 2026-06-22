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
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "../config.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pickPort() {
  return DOUYIN_CONFIG.chromeRemotePortBase + Math.floor(Math.random() * 100);
}

function killStaleProfile() {
  // Stale Chrome holding the profile lockfile → new Chrome silently exits
  // without binding the debug port. Kill any chrome.exe using this profile
  // and clear lockfiles before launching.
  try {
    spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*douyin-cdp-profile*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ], { timeout: 10000 });
  } catch {}
  spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 2"], { timeout: 5000 });
  for (const name of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      const p = join(DOUYIN_CONFIG.chromeUserDataDir, name);
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  }
}

export async function withDouyinChrome(url, fn, { headless = true, waitMs = 6000 } = {}) {
  const port = pickPort();
  mkdirSync(DOUYIN_CONFIG.chromeUserDataDir, { recursive: true });
  killStaleProfile();

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

  // Retry CDP connection — headless Chrome can take 5-15s to bind debug port
  let tabs = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await sleep(2000);
    try {
      const tabsRes = await fetch(`http://localhost:${port}/json`, {
        signal: AbortSignal.timeout(3000),
      });
      tabs = await tabsRes.json();
      if (Array.isArray(tabs) && tabs.length > 0) break;
    } catch (e) {
      if (attempt === 12) {
        try { proc.kill(); } catch {}
        throw new Error(`CDP not reachable on port ${port} after 24s: ${e.message}`);
      }
    }
  }

  try {
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
