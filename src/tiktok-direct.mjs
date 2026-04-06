/**
 * TikTok Direct Poster — Upload videos via Chrome CDP automation.
 *
 * Bypasses PostFast account limit by automating tiktok.com/creator upload directly.
 * Uses Chrome DevTools Protocol (same pattern as shopee/affiliate.mjs).
 *
 * Requirements:
 *   - Chrome installed (not headless — TikTok detects headless)
 *   - TikTok account logged in via the Chrome profile
 *   - Port 9402 available for CDP
 *
 * Usage:
 *   // As module
 *   import { TikTokDirectPoster } from "./tiktok-direct.mjs";
 *   const poster = new TikTokDirectPoster({ log: console.log });
 *   const result = await poster.post("./video.mp4", "Caption text #fyp");
 *
 *   // Standalone test
 *   node src/tiktok-direct.mjs --test path/to/video.mp4
 *   node src/tiktok-direct.mjs --test path/to/video.mp4 --caption "Test caption"
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEFAULT_CDP_PORT = 9402;
const DEFAULT_PROFILE = "D:/tiktok/data/tiktok/chrome_profile";
const LOCK_FILE = "D:/tiktok/data/tiktok/post.lock";
const UPLOAD_URL = "https://www.tiktok.com/creator#/upload?scene=creator_center";

// Timeouts
const UPLOAD_TIMEOUT = 180_000;    // 3 min for video processing
const CAPTION_TIMEOUT = 30_000;    // 30s for caption editor to appear
const POST_TIMEOUT = 60_000;       // 1 min for post to complete
const POLL_INTERVAL = 2_000;       // 2s between polls

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Lock file (prevent concurrent posts) ─────────────────────────────────
function acquireLock() {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  if (existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      // Stale lock (older than 10 min)
      if (Date.now() - lockData.timestamp > 600_000) {
        unlinkSync(LOCK_FILE);
      } else {
        return false;
      }
    } catch { unlinkSync(LOCK_FILE); }
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: Date.now(), pid: process.pid }));
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

// ── CDP Connection ───────────────────────────────────────────────────────

/**
 * Connect to Chrome via CDP.
 *
 * Strategy:
 *   1. Try connecting to existing Chrome on the specified port
 *   2. If no Chrome, launch a new instance with the given profile
 *      (requires Chrome default to NOT be running, or use a separate profile)
 *
 * For daily usage, Chrome should be started once with CDP flag:
 *   "C:/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9402
 *
 * Or create a desktop shortcut with that flag.
 */
async function connectChrome(port, profile, log) {
  // Try connecting to existing Chrome on our CDP port
  let ws, cdp;
  try {
    const r = await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(3000) });
    const tabs = await r.json();
    const tab = tabs.find(t => t.type === "page") || tabs[0];
    if (tab?.webSocketDebuggerUrl) {
      ({ ws, cdp } = await openCdp(tab.webSocketDebuggerUrl));
      log(`[CDP] Connected to existing Chrome on port ${port}`);
      return { ws, cdp, launched: false };
    }
  } catch {
    // No Chrome on this port
  }

  // Check if any Chrome is running (would block same profile)
  const chromeRunning = (() => {
    try {
      const r = spawnSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { shell: true, encoding: "utf8", timeout: 3000 });
      return r.stdout?.includes("chrome.exe");
    } catch { return false; }
  })();

  if (chromeRunning) {
    log(`[CDP] ⚠ Chrome is running but no CDP port found on ${port}.`);
    log(`[CDP] Please restart Chrome with: --remote-debugging-port=${port}`);
    log(`[CDP] Or close Chrome and let this script launch it.`);
    log(`[CDP] Attempting to launch with separate profile...`);

    // Launch with separate profile (won't conflict with running Chrome)
    return launchChromeWithProfile(port, profile, log);
  }

  // No Chrome at all — launch fresh
  return launchChromeWithProfile(port, profile, log);
}

async function launchChromeWithProfile(port, profile, log) {
  log(`[CDP] Launching Chrome on port ${port} with profile ${profile}...`);
  mkdirSync(profile, { recursive: true });

  const proc = spawn(`"${CHROME}"`, [
    "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    `"${UPLOAD_URL}"`,
  ], { shell: true, detached: true, stdio: "ignore" });
  proc.unref();

  let ws, cdp;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    try {
      const r = await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(3000) });
      const tabs = await r.json();
      const tab = tabs.find(t => t.type === "page") || tabs[0];
      if (tab?.webSocketDebuggerUrl) {
        ({ ws, cdp } = await openCdp(tab.webSocketDebuggerUrl));
        log(`[CDP] Chrome launched and connected`);
        return { ws, cdp, proc, launched: true };
      }
    } catch {}
  }
  throw new Error("Chrome CDP startup failed after 40s");
}

async function openCdp(wsUrl) {
  const { default: WS } = await import("ws");
  const ws = new WS(wsUrl);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e8);
    const timer = setTimeout(() => { ws.off("message", handler); rej(new Error(`CDP timeout: ${method}`)); }, 30000);
    const handler = d => {
      const m = JSON.parse(d.toString());
      if (m.id === id) {
        ws.off("message", handler);
        clearTimeout(timer);
        if (m.error) rej(new Error(`CDP error: ${m.error.message}`));
        else res(m.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  return { ws, cdp };
}

// ── Helper: evaluate JS in page context ──────────────────────────────────
async function evalPage(cdp, expression) {
  const result = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

// ── Helper: wait for element to appear ───────────────────────────────────
async function waitForSelector(cdp, selector, timeout, log) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await evalPage(cdp, `!!document.querySelector('${selector}')`);
    if (found) return true;
    await sleep(POLL_INTERVAL);
  }
  log(`[CDP] Timeout waiting for: ${selector}`);
  return false;
}

// ══════════════════════════════════════════════════════════════════════════
//  TikTokDirectPoster
// ══════════════════════════════════════════════════════════════════════════

export class TikTokDirectPoster {
  constructor({ cdpPort, chromeProfile, log } = {}) {
    this.port = cdpPort || DEFAULT_CDP_PORT;
    this.profile = chromeProfile || DEFAULT_PROFILE;
    this.log = log || console.log;
    this._cdp = null;
    this._ws = null;
  }

  async connect() {
    // Close stale connection if any
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
      this._cdp = null;
    }

    const conn = await connectChrome(this.port, this.profile, this.log);
    this._ws = conn.ws;
    this._cdp = conn.cdp;

    // Anti-detection
    try {
      await this._cdp("Page.addScriptToEvaluateOnNewDocument", {
        source: "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
      });
    } catch {} // May fail on already-loaded pages, ok
    await this._cdp("Page.enable");
    await this._cdp("DOM.enable");

    return this;
  }

  async close() {
    try { this._ws?.close(); } catch {}
    this._ws = null;
    this._cdp = null;
  }

  /**
   * Upload a video and post it to TikTok.
   *
   * @param {string} videoPath — Absolute path to .mp4 file
   * @param {string} caption — Description text (max 2200 chars, include hashtags)
   * @param {Object} [options]
   * @param {number} [options.maxRetries=2] — Retry attempts
   * @returns {Promise<{success: boolean, error?: string, postUrl?: string}>}
   */
  async post(videoPath, caption, options = {}) {
    const maxRetries = options.maxRetries ?? 2;
    const absPath = resolve(videoPath);

    if (!existsSync(absPath)) {
      return { success: false, error: `Video file not found: ${absPath}` };
    }

    // Acquire lock
    if (!acquireLock()) {
      return { success: false, error: "Another post is in progress (lock file exists)" };
    }

    try {
      // Connect if needed
      if (!this._cdp) await this.connect();

      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
          const result = await this._doPost(absPath, caption);
          return result;
        } catch (err) {
          this.log(`[TikTok] Attempt ${attempt} failed: ${err.message}`);
          if (attempt <= maxRetries) {
            this.log(`[TikTok] Retrying in ${attempt * 10}s...`);
            await sleep(attempt * 10_000);
          } else {
            return { success: false, error: err.message };
          }
        }
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Core upload flow — the actual CDP automation sequence.
   */
  async _doPost(absPath, caption) {
    let cdp = this._cdp;
    const log = this.log;

    // ── Step 1: Navigate to upload page ──
    log("[TikTok] Step 1: Navigating to upload page...");
    await cdp("Page.navigate", { url: UPLOAD_URL });
    await sleep(5000);

    // Check if logged in (redirect to login page = not logged in)
    const currentUrl = await evalPage(cdp, "location.href");
    if (currentUrl.includes("/login") || currentUrl.includes("passport")) {
      throw new Error("Not logged in — please login to TikTok in Chrome first");
    }

    // ── Step 1b: Discard any pending upload from previous run ──
    const hasPending = await evalPage(cdp, `
      !!([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Discard'))
    `);
    if (hasPending) {
      log("[TikTok] Found pending upload — opening fresh tab instead...");

      // Create a new tab with upload URL (cleanest way to reset state)
      const { targetId } = await cdp("Target.createTarget", { url: UPLOAD_URL });
      await sleep(5000);

      // Get the new tab's WebSocket URL and reconnect
      const tabsRes = await fetch(`http://localhost:${this.port}/json`, { signal: AbortSignal.timeout(3000) });
      const tabs = await tabsRes.json();
      const newTab = tabs.find(t => t.id === targetId) || tabs.find(t => t.url.includes("upload") && t.type === "page");
      if (newTab?.webSocketDebuggerUrl) {
        try { this._ws.close(); } catch {}
        const conn = await openCdp(newTab.webSocketDebuggerUrl);
        this._ws = conn.ws;
        this._cdp = conn.cdp;
        cdp = this._cdp; // update local ref
        await cdp("Page.enable");
        await cdp("DOM.enable");
        log("[TikTok] Switched to fresh tab");
      }
    }

    // ── Step 2: Wait for file input ──
    log("[TikTok] Step 2: Waiting for file input...");
    const hasInput = await waitForSelector(cdp, 'input[type="file"][accept*="video"]', 20_000, log);
    if (!hasInput) {
      // TikTok might show error page — check
      const bodyText = await evalPage(cdp, `document.body?.innerText?.slice(0, 200)`);
      throw new Error(`File input not found. Page content: ${bodyText?.slice(0, 100)}`);
    }

    // ── Step 3: Set video file via CDP ──
    log(`[TikTok] Step 3: Uploading video: ${absPath}`);

    // Get the file input node via DOM
    const doc = await cdp("DOM.getDocument");
    const inputNode = await cdp("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"][accept*="video"]',
    });

    if (!inputNode?.nodeId) {
      throw new Error("Could not find file input node");
    }

    // Set file (this is the key CDP method — bypasses file dialog)
    await cdp("DOM.setFileInputFiles", {
      nodeId: inputNode.nodeId,
      files: [absPath.replace(/\//g, "\\")],  // Windows paths
    });

    // Trigger change event for React
    await evalPage(cdp, `
      const input = document.querySelector('input[type="file"][accept*="video"]');
      if (input) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    `);

    log("[TikTok] Video file set, waiting for upload to process...");

    // ── Step 4: Wait for upload + processing ──
    // TikTok shows caption editor after video is processed
    log("[TikTok] Step 4: Waiting for video processing...");
    const editorReady = await this._waitForEditor(UPLOAD_TIMEOUT);
    if (!editorReady) {
      throw new Error("Video upload/processing timed out");
    }
    log("[TikTok] Video processed, caption editor ready");

    // ── Step 5: Fill caption ──
    log("[TikTok] Step 5: Filling caption...");
    // Wait extra for TikTok to finish auto-filling filename
    await sleep(3000);
    await this._fillCaption(caption);
    await sleep(1000);

    // ── Step 5b: Wait for content checks to complete ──
    log("[TikTok] Step 5b: Waiting for content checks...");
    for (let i = 0; i < 30; i++) { // max 60s
      const checkDone = await evalPage(cdp, `
        const body = document.body?.innerText || '';
        // Checks complete when we see results (not "checking")
        const hasResults = body.includes('No issues found') || body.includes('may be restricted');
        const stillChecking = body.includes('Checking') && !hasResults;
        !stillChecking;
      `);
      if (checkDone) break;
      await sleep(2000);
    }

    // ── Step 6: Click Post button ──
    log("[TikTok] Step 6: Clicking Post button...");
    const posted = await this._clickPost();
    if (!posted) {
      throw new Error("Could not find or click Post button");
    }

    // ── Step 6b: Handle "Continue to post?" confirmation dialog ──
    await sleep(2000);
    const hasConfirmDialog = await evalPage(cdp, `
      const body = document.body?.innerText || '';
      body.includes('Continue to post') || body.includes('copyright check is incomplete');
    `);
    if (hasConfirmDialog) {
      log("[TikTok] Confirming 'Continue to post' dialog...");
      await evalPage(cdp, `
        const btns = [...document.querySelectorAll('button')];
        const confirmBtn = btns.find(b => {
          const t = b.textContent?.trim();
          return t === 'Post' || t === 'Continue' || t === 'Post anyway';
        });
        if (confirmBtn) confirmBtn.click();
      `);
      await sleep(2000);
    }

    // ── Step 7: Wait for success ──
    log("[TikTok] Step 7: Waiting for post confirmation...");
    const success = await this._waitForPostSuccess(POST_TIMEOUT);

    if (success) {
      log("[TikTok] ✅ Video posted successfully!");
      return { success: true, postUrl: await evalPage(cdp, "location.href") };
    } else {
      // Check for error messages
      const errorText = await evalPage(cdp, `
        const body = document.body?.innerText || '';
        const err = body.match(/Something went wrong[^.]*\\.?/)?.[0]
          || body.match(/error[^.]*\\.?/i)?.[0];
        err || null;
      `);
      throw new Error(errorText || "Post confirmation not detected");
    }
  }

  /**
   * Wait for the caption editor to become available (video processed).
   */
  async _waitForEditor(timeout) {
    const start = Date.now();
    const cdp = this._cdp;

    while (Date.now() - start < timeout) {
      // Check multiple possible selectors for caption area
      const ready = await evalPage(cdp, `
        !!(
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('.DraftEditor-root') ||
          document.querySelector('[data-testid="caption-editor"]') ||
          document.querySelector('.caption-editor') ||
          document.querySelector('[class*="caption"] [contenteditable]') ||
          document.querySelector('.notranslate[contenteditable="true"]')
        )
      `);

      if (ready) return true;

      // Log upload progress if visible
      if ((Date.now() - start) % 10_000 < POLL_INTERVAL) {
        const progress = await evalPage(cdp, `
          const prog = document.querySelector('[class*="progress"], [class*="upload"]');
          prog ? prog.textContent?.trim()?.slice(0, 50) : null;
        `);
        if (progress) this.log(`[TikTok]   Upload progress: ${progress}`);
      }

      await sleep(POLL_INTERVAL);
    }
    return false;
  }

  /**
   * Fill the caption editor with text.
   *
   * TikTok auto-fills the filename into the contenteditable editor.
   * Problem: Ctrl+A + Backspace sometimes leaves ghost text due to React/DraftJS
   * virtual DOM not syncing with the real DOM.
   *
   * Solution: Use execCommand('selectAll') + execCommand('delete') which properly
   * triggers React's input handling, then insertText for the new caption.
   */
  async _fillCaption(caption) {
    const cdp = this._cdp;
    const log = this.log;

    const EDITOR_SEL = `document.querySelector('[contenteditable="true"]') || document.querySelector('.notranslate[contenteditable="true"]')`;

    // Focus editor
    await evalPage(cdp, `(${EDITOR_SEL})?.focus()`);
    await sleep(500);

    // Clear using execCommand — this properly notifies React/DraftJS
    // execCommand is deprecated but still works in all browsers and
    // is the most reliable way to interact with contenteditable + React
    for (let attempt = 0; attempt < 5; attempt++) {
      await evalPage(cdp, `
        const ed = ${EDITOR_SEL};
        if (ed) {
          ed.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        }
      `);
      await sleep(300);

      const remaining = await evalPage(cdp, `(${EDITOR_SEL})?.textContent?.trim()?.length || 0`);
      if (remaining === 0) break;
      log(`[TikTok] Clear attempt ${attempt + 1}: ${remaining} chars remaining`);
    }

    // Insert new caption via execCommand('insertText') — triggers React onChange
    await evalPage(cdp, `
      const ed = ${EDITOR_SEL};
      if (ed) {
        ed.focus();
        document.execCommand('insertText', false, ${JSON.stringify(caption)});
      }
    `);
    await sleep(500);

    // Verify
    const result = await evalPage(cdp, `(${EDITOR_SEL})?.textContent?.trim()?.slice(0, 80) || ''`);
    if (result && result.startsWith(caption.slice(0, 15))) {
      log(`[TikTok] Caption OK: "${result.slice(0, 50)}..."`);
    } else if (result) {
      log(`[TikTok] ⚠ Caption got: "${result.slice(0, 50)}" — retrying with Input.insertText`);
      // Fallback: CDP Input.insertText
      await evalPage(cdp, `(${EDITOR_SEL})?.focus(); document.execCommand('selectAll'); document.execCommand('delete');`);
      await sleep(200);
      await cdp("Input.insertText", { text: caption });
      await sleep(300);
      const retry = await evalPage(cdp, `(${EDITOR_SEL})?.textContent?.trim()?.slice(0, 50) || ''`);
      log(`[TikTok] Caption retry: "${retry}..."`);
    } else {
      log(`[TikTok] ⚠ Caption editor empty after insert`);
    }
  }

  /**
   * Find and click the Post/Dang button.
   * Scrolls to bottom first since Post button is below the fold.
   */
  async _clickPost() {
    const cdp = this._cdp;

    // Scroll to bottom to ensure Post button is in viewport
    await evalPage(cdp, `window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(1000);

    // Try multiple selectors for the post button
    const clicked = await evalPage(cdp, `
      (function() {
        // Try by data-testid
        let btn = document.querySelector('[data-testid="post-button"]');
        if (btn && !btn.disabled) { btn.scrollIntoView(); btn.click(); return 'data-testid'; }

        // Try by button text — exact match "Post" only
        const buttons = [...document.querySelectorAll('button')];
        const postBtn = buttons.find(b => {
          const text = b.textContent?.trim();
          return (text === 'Post' || text === 'Đăng' || text === 'Publish')
            && !b.disabled;
        });
        if (postBtn) { postBtn.scrollIntoView(); postBtn.click(); return 'text-match'; }

        // Try by class
        btn = document.querySelector('[class*="post-button"], [class*="PostButton"]');
        if (btn && !btn.disabled) { btn.scrollIntoView(); btn.click(); return 'class-match'; }

        return null;
      })()
    `);

    if (clicked) {
      this.log(`[TikTok] Post button clicked (via ${clicked})`);
      return true;
    }

    // Debug: list available buttons
    const buttons = await evalPage(cdp, `
      [...document.querySelectorAll('button')].map(b => ({
        text: b.textContent?.trim()?.slice(0, 30),
        disabled: b.disabled,
        classes: b.className?.slice(0, 50),
      })).filter(b => b.text)
    `);
    this.log(`[TikTok] Available buttons: ${JSON.stringify(buttons)}`);
    return false;
  }

  /**
   * Wait for post success confirmation.
   *
   * After clicking Post, TikTok either:
   *   a) Shows the upload form again with "Select video" (form reset = success)
   *   b) Redirects to manage/content page
   *   c) Shows "Your video is being uploaded" text
   *   d) Post button disappears
   *
   * We also check ALL upload tabs — the fresh tab we created may have the
   * success state while our current CDP connection points to an older tab.
   */
  async _waitForPostSuccess(timeout) {
    const start = Date.now();
    const cdp = this._cdp;

    while (Date.now() - start < timeout) {
      // Check current tab first
      const status = await evalPage(cdp, `
        (function() {
          const url = location.href;
          if (url.includes('/manage') || url.includes('/content') || url.includes('/post/'))
            return 'redirect';

          const body = document.body?.textContent || '';
          const postBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Post');

          // Post button gone + form shows "Select video" = success
          if (!postBtn && (body.includes('Select video') || body.includes('Chọn video')))
            return 'form-reset';

          // Post button gone + success text
          if (!postBtn && (body.includes('successfully') || body.includes('Your video') ||
              body.includes('thành công') || body.includes('being processed')))
            return 'text-match';

          // Post button gone but page still loading
          if (!postBtn && body.length < 100)
            return null; // still loading, keep waiting

          return null;
        })()
      `);

      if (status) {
        this.log(`[TikTok] Post confirmed via: ${status}`);
        return true;
      }

      // Also check other upload tabs (new tab may have success state)
      try {
        const tabsRes = await fetch(`http://localhost:${this.port}/json`, { signal: AbortSignal.timeout(2000) });
        const tabs = await tabsRes.json();
        const uploadTabs = tabs.filter(t => t.type === "page" && t.url.includes("upload"));
        for (const tab of uploadTabs) {
          if (tab.webSocketDebuggerUrl === this._ws?.url) continue; // skip current
          try {
            const { ws: tmpWs, cdp: tmpCdp } = await openCdp(tab.webSocketDebuggerUrl);
            const otherStatus = await tmpCdp("Runtime.evaluate", {
              expression: `
                (function() {
                  const body = document.body?.textContent || '';
                  const postBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Post');
                  if (!postBtn && (body.includes('Select video') || body.includes('Chọn video')))
                    return 'form-reset-other-tab';
                  if (!postBtn && body.includes('wasn\\'t saved'))
                    return 'form-reset-other-tab';
                  return null;
                })()
              `,
              returnByValue: true,
            });
            tmpWs.close();
            if (otherStatus?.result?.value) {
              this.log(`[TikTok] Post confirmed via: ${otherStatus.result.value}`);
              return true;
            }
          } catch {}
        }
      } catch {}

      await sleep(POLL_INTERVAL);
    }
    return false;
  }
}

// ── CLI test entry point ─────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tiktok-direct.mjs")) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.length >= 1) {
    const videoIdx = args.indexOf("--test");
    const videoPath = args[videoIdx + 1] || args[0];
    const captionIdx = args.indexOf("--caption");
    const caption = captionIdx > -1 ? args[captionIdx + 1] : "Test upload #fyp #test";

    if (!videoPath || !existsSync(videoPath)) {
      console.error("Usage: node src/tiktok-direct.mjs --test <video_path> [--caption \"text\"]");
      process.exit(1);
    }

    // Load env
    try { await import("./env.js"); } catch {}

    console.log(`\n🎬 TikTok Direct Post Test`);
    console.log(`   Video: ${videoPath}`);
    console.log(`   Caption: ${caption.slice(0, 60)}...`);
    console.log(``);

    const poster = new TikTokDirectPoster({ log: console.log });
    try {
      const result = await poster.post(videoPath, caption);
      console.log(`\nResult:`, JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      console.error("Fatal:", err.message);
      process.exit(1);
    } finally {
      await poster.close();
    }
  }
}
