/**
 * keep-awake.mjs — pin Windows awake for the lifetime of the calling process.
 *
 * powercfg standby-timeout=0 does NOT stop Modern Standby (S0) from freezing
 * Node mid-run (repeated overnight pipeline freezes). The reliable mechanism
 * is SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED), held by a
 * small PowerShell child (scripts/keep-awake.ps1) that:
 *   - re-asserts every 30s
 *   - watches our PID and self-terminates when we die → can never orphan-pin
 *     the machine awake (execution state clears when the child exits).
 *
 * Usage (top of any long-running pipeline entrypoint):
 *   import { startKeepAwake } from "./keep-awake.mjs";
 *   startKeepAwake();
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

let child = null;

export function startKeepAwake() {
  if (child) return; // idempotent — one keeper per process
  if (process.platform !== "win32") return;
  const ps1 = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "keep-awake.ps1");
  try {
    child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ParentPid", String(process.pid)],
      { stdio: "ignore", detached: false }
    );
    child.unref(); // don't let the keeper hold our event loop open
    child.on("error", () => { child = null; });
    const stop = () => { try { child?.kill(); } catch {} child = null; };
    process.on("exit", stop);
  } catch {
    child = null; // keep-awake is best-effort — never block the pipeline
  }
}
