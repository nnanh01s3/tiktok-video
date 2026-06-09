import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 50_000;

export function createLogger(logFilePath) {
  if (logFilePath) mkdirSync(dirname(logFilePath), { recursive: true });

  function write(level, scope, msg) {
    const ts = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    const line = `[${ts}] [${level}] [${scope}] ${msg}`;
    console.log(line);
    if (!logFilePath) return;
    try {
      const prev = existsSync(logFilePath) ? readFileSync(logFilePath, "utf8") : "";
      writeFileSync(logFilePath, (prev + line + "\n").slice(-MAX_LOG_BYTES));
    } catch {}
  }

  return {
    info: (scope, msg) => write("INFO", scope, msg),
    warn: (scope, msg) => write("WARN", scope, msg),
    error: (scope, msg) => write("ERROR", scope, msg),
  };
}
