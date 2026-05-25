/**
 * Node adapter for scripts/paddle_ocr_batch.py.
 * Spawns python subprocess, pipes frame paths to stdin, parses JSON lines from stdout.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

export async function runOCR(frame_paths) {
  if (!frame_paths.length) return [];
  log.info("ocr", `running PaddleOCR on ${frame_paths.length} frames`);

  return new Promise((resolve, reject) => {
    const proc = spawn("python", [DOUYIN_CONFIG.pythonScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const results = [];
    let stderrBuf = "";
    let buf = "";

    proc.stdout.on("data", (chunk) => {
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

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`paddle_ocr_batch.py exit ${code}: ${stderrBuf.slice(-500)}`));
      }
      resolve(results);
    });

    proc.stdin.write(frame_paths.join("\n") + "\n");
    proc.stdin.end();
  });
}
