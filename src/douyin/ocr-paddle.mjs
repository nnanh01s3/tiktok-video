/**
 * Node adapter for scripts/paddle_ocr_batch.py.
 * Spawns python subprocess, pipes frame paths to stdin, parses JSON lines from stdout.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

// PaddleOCR per-frame max time (PP-OCRv5 ~50-200ms/frame on CPU, generous).
// Total timeout = frames × 500ms + 30s warmup.
const PER_FRAME_TIMEOUT_MS = 500;
const WARMUP_TIMEOUT_MS = 30_000;
// Hard cap so pipeline never hangs more than this regardless of frame count.
const ABSOLUTE_TIMEOUT_MS = 5 * 60_000;
// Progress-stall window: if no JSON line received in this long, assume hung.
const STALL_TIMEOUT_MS = 60_000;

export async function runOCR(frame_paths) {
  if (!frame_paths.length) return [];
  log.info("ocr", `running PaddleOCR on ${frame_paths.length} frames`);

  const overallTimeout = Math.min(
    ABSOLUTE_TIMEOUT_MS,
    WARMUP_TIMEOUT_MS + frame_paths.length * PER_FRAME_TIMEOUT_MS
  );

  return new Promise((resolve, reject) => {
    const proc = spawn("python", [DOUYIN_CONFIG.pythonScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const results = [];
    let stderrBuf = "";
    let buf = "";
    let settled = false;

    const settle = (err) => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch {}
      if (err) reject(err);
      else resolve(results);
    };

    const overallTimer = setTimeout(() => {
      settle(new Error(
        `PaddleOCR overall timeout (${overallTimeout}ms) — processed ${results.length}/${frame_paths.length} frames`
      ));
    }, overallTimeout);

    let stallTimer = setTimeout(
      () => settle(new Error(`PaddleOCR stalled (no output ${STALL_TIMEOUT_MS}ms) — processed ${results.length}/${frame_paths.length}`)),
      STALL_TIMEOUT_MS + WARMUP_TIMEOUT_MS
    );
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => settle(new Error(`PaddleOCR stalled (no output ${STALL_TIMEOUT_MS}ms) — processed ${results.length}/${frame_paths.length}`)),
        STALL_TIMEOUT_MS
      );
    };

    proc.stdout.on("data", (chunk) => {
      resetStall();
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.error && !obj.frame_path) {
            log.error("ocr", `python error: ${obj.error}`);
            continue;
          }
          const m = basename(obj.frame_path).match(/(\d+)/);
          obj.frame_idx = m ? parseInt(m[1], 10) : results.length;
          results.push(obj);
        } catch (e) {
          log.warn("ocr", `bad JSON line: ${line.slice(0, 200)}`);
        }
      }
    });

    proc.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });

    proc.on("error", (e) => {
      clearTimeout(overallTimer);
      clearTimeout(stallTimer);
      settle(e);
    });
    proc.on("close", (code) => {
      clearTimeout(overallTimer);
      clearTimeout(stallTimer);
      if (settled) return;
      if (code !== 0) {
        return settle(new Error(`paddle_ocr_batch.py exit ${code}: ${stderrBuf.slice(-500)}`));
      }
      settle();
    });

    proc.stdin.write(frame_paths.join("\n") + "\n");
    proc.stdin.end();
  });
}
