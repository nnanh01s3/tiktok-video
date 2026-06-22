# Loop Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng một loop kernel 5 bước dùng chung (discover → assign → run → verify → persist + escalate) bọc cụm `daily.mjs` (TikTok + 8 page Shopee), giữ nguyên hành vi đăng bài.

**Architecture:** Cách C (hybrid) — kernel điều phối, job vẫn chạy subprocess nhưng nói chung một hợp đồng kết quả JSON (`::LOOP_RESULT::`). State tập trung trong SQLite. Escalate qua Telegram. Các module rời, inject được runner/escalate để test không cần spawn thật.

**Tech Stack:** Node ESM, `node --test` + `node:assert/strict`, `better-sqlite3` (đã có), `fetch` (Telegram).

**Spec:** `docs/superpowers/specs/2026-06-21-loop-kernel-design.md`

---

## File Structure

| File | Trách nhiệm |
|------|-------------|
| `src/loop/contract.mjs` | `printResult()` (job in) + `parseResult()` (kernel đọc), tiền tố `::LOOP_RESULT::`, fallback exit-code + regex cũ |
| `src/loop/state.mjs` | `createStore(dbPath)` → `{ get, upsert, list, close }` trên bảng `loop_state` (SQLite) |
| `src/loop/escalate.mjs` | `formatEscalation()` (thuần) + `sendEscalation()` (bọc Telegram, inject được `send`) |
| `src/loop/kernel.mjs` | `runScript()` (spawn + timeout) + `runJob()` + `runAll()` — engine 5 bước, inject `run`/`escalate` |
| `src/loop/registry.mjs` | `BASE_JOBS` + `buildRegistry(opts)` → mảng descriptor có stagger (port từ `daily.mjs`) |
| `src/daily.mjs` | Đổi ruột: gọi `runAll(buildRegistry(...))`, thêm cờ `--dry-run`, giữ arg parsing/cache/summary |
| `test/loop/*.test.mjs` | Test cho từng module |

DB dùng file riêng `data/loop_state.db` (cô lập, không đụng DB quotes hiện có).

---

## Task 1: Result contract (`contract.mjs`)

**Files:**
- Create: `src/loop/contract.mjs`
- Test: `test/loop/contract.test.mjs`

- [ ] **Step 1: Viết test thất bại**

```js
// test/loop/contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResult, printResult, RESULT_PREFIX } from "../../src/loop/contract.mjs";

test("parseResult: đọc dòng sentinel JSON", () => {
  const out = `log dòng 1\n${RESULT_PREFIX} {"ok":true,"items":[{"id":"p1","status":"published"}],"error":null}`;
  const r = parseResult(out, 0);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, "p1");
  assert.equal(r.error, null);
});

test("parseResult: lấy dòng sentinel CUỐI cùng nếu có nhiều", () => {
  const out = `${RESULT_PREFIX} {"ok":false,"items":[],"error":"cũ"}\n${RESULT_PREFIX} {"ok":true,"items":[],"error":null}`;
  assert.equal(parseResult(out, 0).ok, true);
});

test("parseResult: sentinel hỏng → fallback exit code", () => {
  const r = parseResult(`${RESULT_PREFIX} {không-phải-json}`, 0);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 0);
});

test("parseResult: không sentinel, exit 0 → ok", () => {
  assert.equal(parseResult("chỉ log thường", 0).ok, true);
});

test("parseResult: không sentinel, exit 1 → fail + error", () => {
  const r = parseResult("lỗi gì đó", 1);
  assert.equal(r.ok, false);
  assert.equal(r.error, "exit 1");
});

test("parseResult: fallback rút số từ regex 'Đăng X/Y'", () => {
  const r = parseResult("Đăng 2/3 video xong", 0);
  assert.equal(r.items[0].meta.posted, 2);
  assert.equal(r.items[0].meta.total, 3);
});

test("printResult: in đúng tiền tố + JSON", () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try { printResult({ ok: true, items: [{ id: "x" }], error: null }); }
  finally { console.log = orig; }
  assert.ok(lines[0].startsWith(RESULT_PREFIX));
  assert.deepEqual(JSON.parse(lines[0].slice(RESULT_PREFIX.length).trim()), { ok: true, items: [{ id: "x" }], error: null });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `node --test test/loop/contract.test.mjs`
Expected: FAIL — `Cannot find module '../../src/loop/contract.mjs'`

- [ ] **Step 3: Viết implementation tối thiểu**

```js
// src/loop/contract.mjs
export const RESULT_PREFIX = "::LOOP_RESULT::";

export function printResult(result) {
  const payload = {
    ok: Boolean(result.ok),
    items: result.items ?? [],
    error: result.error ?? null,
  };
  console.log(`${RESULT_PREFIX} ${JSON.stringify(payload)}`);
}

export function parseResult(stdout, exitCode) {
  const text = String(stdout);
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(RESULT_PREFIX);
    if (idx >= 0) {
      try {
        const json = JSON.parse(lines[i].slice(idx + RESULT_PREFIX.length).trim());
        return { ok: Boolean(json.ok), items: json.items ?? [], error: json.error ?? null };
      } catch {
        break; // sentinel hỏng → rơi xuống fallback
      }
    }
  }
  const ok = exitCode === 0;
  const m = text.match(/(?:Đăng|Posted)\s+(\d+)\/(\d+)/);
  const items = m
    ? [{ id: "run", status: ok ? "done" : "failed", meta: { posted: Number(m[1]), total: Number(m[2]) } }]
    : [];
  return { ok, items, error: ok ? null : `exit ${exitCode}` };
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `node --test test/loop/contract.test.mjs`
Expected: PASS (7 test)

- [ ] **Step 5: Commit**

```bash
git add src/loop/contract.mjs test/loop/contract.test.mjs
git commit -m "feat(loop): result contract — printResult/parseResult + fallback"
```

---

## Task 2: Central state store (`state.mjs`)

**Files:**
- Create: `src/loop/state.mjs`
- Test: `test/loop/state.test.mjs`

- [ ] **Step 1: Viết test thất bại**

```js
// test/loop/state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/loop/state.mjs";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "loop-state-"));
  return { dir, path: join(dir, "s.db") };
}

test("state: rỗng khi chưa có gì", () => {
  const { dir, path } = tmp();
  const s = createStore(path);
  assert.equal(s.get("j", "a"), null);
  assert.deepEqual(s.list(), []);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("state: upsert ghi và bền qua lần mở lại", () => {
  const { dir, path } = tmp();
  const s1 = createStore(path);
  s1.upsert("j", "a", { status: "done", meta: { url: "x" } });
  s1.close();
  const s2 = createStore(path);
  const row = s2.get("j", "a");
  assert.equal(row.status, "done");
  assert.deepEqual(row.meta, { url: "x" });
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("state: upsert merge — patch một field không xoá field khác", () => {
  const { dir, path } = tmp();
  const s = createStore(path);
  s.upsert("j", "a", { status: "failed", attempts: 2, last_error: "boom" });
  s.upsert("j", "a", { status: "running" });
  const row = s.get("j", "a");
  assert.equal(row.status, "running");
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, "boom");
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("state: xoá last_error bằng null tường minh", () => {
  const { dir, path } = tmp();
  const s = createStore(path);
  s.upsert("j", "a", { status: "failed", last_error: "boom" });
  s.upsert("j", "a", { status: "done", last_error: null });
  assert.equal(s.get("j", "a").last_error, null);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("state: list lọc theo jobId và status (string + RegExp)", () => {
  const { dir, path } = tmp();
  const s = createStore(path);
  s.upsert("j", "a", { status: "done" });
  s.upsert("j", "b", { status: "failed" });
  s.upsert("k", "c", { status: "done" });
  assert.equal(s.list({ jobId: "j" }).length, 2);
  assert.equal(s.list({ status: "done" }).length, 2);
  assert.equal(s.list({ status: /^fail/ }).length, 1);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `node --test test/loop/state.test.mjs`
Expected: FAIL — `Cannot find module '../../src/loop/state.mjs'`

- [ ] **Step 3: Viết implementation tối thiểu**

```js
// src/loop/state.mjs
import Database from "better-sqlite3";

export function createStore(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_state (
      job_id     TEXT NOT NULL,
      item_id    TEXT NOT NULL,
      status     TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      meta       TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, item_id)
    )
  `);

  const selOne = db.prepare("SELECT * FROM loop_state WHERE job_id=? AND item_id=?");
  const selAll = db.prepare("SELECT * FROM loop_state");
  const upsertStmt = db.prepare(`
    INSERT INTO loop_state (job_id, item_id, status, attempts, last_error, meta, updated_at)
    VALUES (@job_id, @item_id, @status, @attempts, @last_error, @meta, @updated_at)
    ON CONFLICT(job_id, item_id) DO UPDATE SET
      status=@status, attempts=@attempts, last_error=@last_error, meta=@meta, updated_at=@updated_at
  `);

  function toObj(row) {
    if (!row) return null;
    return { ...row, meta: row.meta ? JSON.parse(row.meta) : null };
  }

  return {
    get(jobId, itemId) {
      return toObj(selOne.get(jobId, itemId));
    },
    upsert(jobId, itemId, patch = {}) {
      const ex = selOne.get(jobId, itemId);
      const merged = {
        job_id: jobId,
        item_id: itemId,
        status: "status" in patch ? patch.status : (ex?.status ?? "pending"),
        attempts: "attempts" in patch ? patch.attempts : (ex?.attempts ?? 0),
        last_error: "last_error" in patch ? patch.last_error : (ex?.last_error ?? null),
        meta: "meta" in patch
          ? (patch.meta == null ? null : JSON.stringify(patch.meta))
          : (ex?.meta ?? null),
        updated_at: new Date().toISOString(),
      };
      upsertStmt.run(merged);
      return toObj(selOne.get(jobId, itemId));
    },
    list({ jobId, status } = {}) {
      let rows = selAll.all();
      if (jobId) rows = rows.filter((r) => r.job_id === jobId);
      if (status) {
        const re = status instanceof RegExp ? status : new RegExp(`^${status}$`);
        rows = rows.filter((r) => re.test(r.status));
      }
      return rows.map(toObj);
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `node --test test/loop/state.test.mjs`
Expected: PASS (5 test)

- [ ] **Step 5: Commit**

```bash
git add src/loop/state.mjs test/loop/state.test.mjs
git commit -m "feat(loop): central SQLite state store (get/upsert/list)"
```

---

## Task 3: Escalation (`escalate.mjs`)

**Files:**
- Create: `src/loop/escalate.mjs`
- Test: `test/loop/escalate.test.mjs`

- [ ] **Step 1: Viết test thất bại**

```js
// test/loop/escalate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEscalation, sendEscalation } from "../../src/loop/escalate.mjs";

const info = { jobId: "shopee:gia_dung", itemId: "run", step: "verify", reason: "sizeBytes 410000 < 500000", attempts: 2, maxAttempts: 2, logTail: "line1\nline2" };

test("formatEscalation: chứa job, item, số lần thử", () => {
  const msg = formatEscalation(info);
  assert.match(msg, /shopee:gia_dung/);
  assert.match(msg, /run/);
  assert.match(msg, /2\/2/);
  assert.match(msg, /sizeBytes 410000/);
});

test("formatEscalation: không có logTail thì không có khối code", () => {
  const msg = formatEscalation({ ...info, logTail: "" });
  assert.doesNotMatch(msg, /```/);
});

test("sendEscalation: gọi send với message đã format", async () => {
  let sent = null;
  const ok = await sendEscalation(info, { send: async (m) => { sent = m; return true; } });
  assert.equal(ok, true);
  assert.match(sent, /shopee:gia_dung/);
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `node --test test/loop/escalate.test.mjs`
Expected: FAIL — `Cannot find module '../../src/loop/escalate.mjs'`

- [ ] **Step 3: Viết implementation tối thiểu**

```js
// src/loop/escalate.mjs
export function formatEscalation({ jobId, itemId, step, reason, attempts, maxAttempts, logTail = "" }) {
  const tail = logTail
    ? `\n\`\`\`\n${String(logTail).split("\n").slice(-20).join("\n")}\n\`\`\``
    : "";
  return `🚨 *[loop]* \`${jobId}\` / item \`${itemId}\`\nbước: ${step} — ${reason}\nđã thử: ${attempts}/${maxAttempts}${tail}`;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function sendEscalation(info, { send = sendTelegram } = {}) {
  return send(formatEscalation(info));
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `node --test test/loop/escalate.test.mjs`
Expected: PASS (3 test)

- [ ] **Step 5: Commit**

```bash
git add src/loop/escalate.mjs test/loop/escalate.test.mjs
git commit -m "feat(loop): structured Telegram escalation"
```

---

## Task 4: Loop kernel (`kernel.mjs`)

**Files:**
- Create: `src/loop/kernel.mjs`
- Test: `test/loop/kernel.test.mjs`

Phụ thuộc: `contract.mjs` (Task 1), `state.mjs` (Task 2), `escalate.mjs` (Task 3).

- [ ] **Step 1: Viết test thất bại**

```js
// test/loop/kernel.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/loop/state.mjs";
import { runJob, runAll } from "../../src/loop/kernel.mjs";

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "loop-kernel-"));
  const store = createStore(join(dir, "s.db"));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const OK = '::LOOP_RESULT:: {"ok":true,"items":[],"error":null}';
const noop = async () => {};

test("kernel: job có discover (dedup) → done rồi skip lần sau", async () => {
  const { store, cleanup } = tmpStore();
  let runs = 0;
  const run = async () => { runs++; return { name: "x", code: 0, output: OK }; };
  const desc = { id: "j", discover: async () => [{ id: "a" }], run: { cmd: [] } };
  await runJob(desc, { store, run, escalate: noop });
  await runJob(desc, { store, run, escalate: noop });
  assert.equal(runs, 1);
  assert.equal(store.get("j", "a").status, "done");
  cleanup();
});

test("kernel: dedup job chết sau maxAttempts và escalate đúng 1 lần", async () => {
  const { store, cleanup } = tmpStore();
  const esc = [];
  const run = async () => ({ name: "x", code: 1, output: "boom" });
  const desc = { id: "j", discover: async () => [{ id: "a" }], run: { cmd: [] }, retry: { maxAttempts: 2 } };
  await runJob(desc, { store, run, escalate: async (i) => esc.push(i) });
  assert.equal(store.get("j", "a").status, "failed");
  assert.equal(esc.length, 0);
  await runJob(desc, { store, run, escalate: async (i) => esc.push(i) });
  assert.equal(store.get("j", "a").status, "dead");
  assert.equal(esc.length, 1);
  cleanup();
});

test("kernel: job không discover (non-dedup) chạy mỗi tick, không done vĩnh viễn", async () => {
  const { store, cleanup } = tmpStore();
  let runs = 0;
  const run = async () => { runs++; return { name: "x", code: 0, output: OK }; };
  const desc = { id: "j", run: { cmd: [] } };
  await runJob(desc, { store, run, escalate: noop });
  await runJob(desc, { store, run, escalate: noop });
  assert.equal(runs, 2);
  assert.equal(store.get("j", "run").status, "done");
  cleanup();
});

test("kernel: non-dedup lỗi → escalate rồi reset attempts (status failed)", async () => {
  const { store, cleanup } = tmpStore();
  const esc = [];
  const run = async () => ({ name: "x", code: 1, output: "boom" });
  const desc = { id: "j", run: { cmd: [] }, retry: { maxAttempts: 1 } };
  await runJob(desc, { store, run, escalate: async (i) => esc.push(i) });
  assert.equal(esc.length, 1);
  assert.equal(store.get("j", "run").status, "failed");
  assert.equal(store.get("j", "run").attempts, 0);
  cleanup();
});

test("kernel: verify skip → status skipped, không escalate", async () => {
  const { store, cleanup } = tmpStore();
  const esc = [];
  const run = async () => ({ name: "x", code: 0, output: "x" });
  const desc = { id: "j", run: { cmd: [] }, verify: async () => ({ ok: false, reason: "nhỏ quá", skip: true }) };
  await runJob(desc, { store, run, escalate: async (i) => esc.push(i) });
  assert.equal(store.get("j", "run").status, "skipped");
  assert.equal(esc.length, 0);
  cleanup();
});

test("kernel: dryRun không gọi runner nhưng vẫn ghi done", async () => {
  const { store, cleanup } = tmpStore();
  let runs = 0;
  const run = async () => { runs++; return { name: "x", code: 0, output: "" }; };
  const desc = { id: "j", run: { cmd: [] } };
  await runJob(desc, { store, dryRun: true, run, escalate: noop });
  assert.equal(runs, 0);
  assert.equal(store.get("j", "run").status, "done");
  cleanup();
});

test("runAll: một job ném lỗi không giết các job khác", async () => {
  const { store, cleanup } = tmpStore();
  const run = async () => ({ name: "x", code: 0, output: OK });
  const good = { id: "good", run: { cmd: [] } };
  const bad = { id: "bad", discover: async () => { throw new Error("boom"); }, run: { cmd: [] } };
  const res = await runAll([bad, good], { store, run, escalate: noop });
  assert.equal(res.find((r) => r.id === "bad").ok, false);
  assert.equal(res.find((r) => r.id === "good").ok, true);
  assert.equal(store.get("good", "run").status, "done");
  cleanup();
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `node --test test/loop/kernel.test.mjs`
Expected: FAIL — `Cannot find module '../../src/loop/kernel.mjs'`

- [ ] **Step 3: Viết implementation tối thiểu**

```js
// src/loop/kernel.mjs
import { spawn } from "node:child_process";
import { parseResult } from "./contract.mjs";
import { sendEscalation } from "./escalate.mjs";

export function runScript(name, cmdArgs, { timeoutMs = 15 * 60 * 1000, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", cmdArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: true });
    const out = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    proc.stdout?.on("data", (d) => out.push(d.toString()));
    proc.stderr?.on("data", (d) => out.push(d.toString()));
    proc.on("close", (code) => { clearTimeout(timer); resolve({ name, code: timedOut ? 124 : code, output: out.join("") }); });
    proc.on("error", (err) => { clearTimeout(timer); resolve({ name, code: 1, output: err.message }); });
  });
}

const DEFAULT_VERIFY = (result) => ({ ok: result.ok, reason: result.error ?? "", skip: false });

export async function runJob(descriptor, { store, dryRun = false, run = runScript, escalate = sendEscalation } = {}) {
  const { id } = descriptor;
  const discover = descriptor.discover ?? (async () => [{ id: "run" }]);
  const verify = descriptor.verify ?? DEFAULT_VERIFY;
  const maxAttempts = descriptor.retry?.maxAttempts ?? 1;
  const dedup = descriptor.dedup ?? Boolean(descriptor.discover);

  const items = await discover();
  const outcomes = [];

  for (const item of items) {
    const st = store.get(id, item.id);
    if (dedup && st && (st.status === "done" || st.status === "dead")) {
      outcomes.push({ item: item.id, status: st.status, skipped: true });
      continue;
    }

    store.upsert(id, item.id, { status: "running" });

    let result;
    if (dryRun) {
      result = { ok: true, items: [{ id: item.id, status: "dry-run" }], error: null };
    } else {
      const raw = await run(id, descriptor.run.cmd, { timeoutMs: descriptor.run?.timeoutMs });
      result = parseResult(raw.output, raw.code);
    }

    const v = await verify(result, item);

    if (v.skip) {
      store.upsert(id, item.id, { status: "skipped", last_error: v.reason || null });
      outcomes.push({ item: item.id, status: "skipped" });
    } else if (v.ok) {
      store.upsert(id, item.id, { status: "done", attempts: 0, last_error: null, meta: result.items });
      outcomes.push({ item: item.id, status: "done" });
    } else {
      const attempts = (st?.attempts ?? 0) + 1;
      if (attempts >= maxAttempts) {
        await escalate({ jobId: id, itemId: item.id, step: "verify", reason: v.reason, attempts, maxAttempts, logTail: result.error ?? "" });
        if (dedup) {
          store.upsert(id, item.id, { status: "dead", attempts, last_error: v.reason });
          outcomes.push({ item: item.id, status: "dead" });
        } else {
          store.upsert(id, item.id, { status: "failed", attempts: 0, last_error: v.reason });
          outcomes.push({ item: item.id, status: "failed" });
        }
      } else {
        store.upsert(id, item.id, { status: "failed", attempts, last_error: v.reason });
        outcomes.push({ item: item.id, status: "failed" });
      }
    }
  }

  return outcomes;
}

export async function runAll(registry, opts = {}) {
  const all = [];
  await Promise.all(registry.map(async (descriptor) => {
    try {
      const outcomes = await runJob(descriptor, opts);
      all.push({ id: descriptor.id, ok: true, outcomes });
    } catch (err) {
      all.push({ id: descriptor.id, ok: false, error: err.message });
    }
  }));
  return all;
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `node --test test/loop/kernel.test.mjs`
Expected: PASS (7 test)

- [ ] **Step 5: Commit**

```bash
git add src/loop/kernel.mjs test/loop/kernel.test.mjs
git commit -m "feat(loop): kernel engine — runJob/runAll với dedup, retry, escalate"
```

---

## Task 5: Job registry (`registry.mjs`)

**Files:**
- Create: `src/loop/registry.mjs`
- Test: `test/loop/registry.test.mjs`

Port nguyên logic stagger/schedule từ `daily.mjs` (dòng 63-93, 179-181). FB dùng `--delay N` (cách space), TikTok dùng `--delay=N` (cách equals) — phải giữ đúng từng kiểu.

- [ ] **Step 1: Viết test thất bại**

```js
// test/loop/registry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry, BASE_JOBS } from "../../src/loop/registry.mjs";

test("registry: BASE_JOBS có TikTok + 8 page Shopee + fb_repost = 10", () => {
  assert.equal(BASE_JOBS.length, 10);
});

test("registry: mặc định build đủ 10 job, không có discover (non-dedup)", () => {
  const reg = buildRegistry({});
  assert.equal(reg.length, 10);
  assert.ok(reg.every((d) => d.discover === undefined));
});

test("registry: --tt-only chỉ còn job TikTok", () => {
  const reg = buildRegistry({ ttOnly: true });
  assert.equal(reg.length, 1);
  assert.equal(reg[0].id, "tiktok:veo");
});

test("registry: --fb-only bỏ TikTok", () => {
  const reg = buildRegistry({ fbOnly: true });
  assert.equal(reg.length, 9);
  assert.ok(!reg.some((d) => d.id === "tiktok:veo"));
});

test("registry: FB job dùng '--delay N' (space), TikTok dùng '--delay=N'", () => {
  const reg = buildRegistry({});
  const fb = reg.find((d) => d.id === "shopee:gia_dung");
  const tt = reg.find((d) => d.id === "tiktok:veo");
  assert.ok(fb.run.cmd.includes("--delay"));
  assert.ok(tt.run.cmd.some((a) => a.startsWith("--delay=")));
});

test("registry: scheduleAt làm delay tăng dần giữa các FB job", () => {
  const reg = buildRegistry({ scheduleAt: "23:59", scheduleEnd: "23:59", fbOnly: true });
  const delays = reg.map((d) => Number(d.run.cmd[d.run.cmd.indexOf("--delay") + 1]));
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1]);
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `node --test test/loop/registry.test.mjs`
Expected: FAIL — `Cannot find module '../../src/loop/registry.mjs'`

- [ ] **Step 3: Viết implementation tối thiểu**

```js
// src/loop/registry.mjs
// Port stagger/schedule từ daily.mjs để giữ nguyên hành vi đăng bài.

export const BASE_JOBS = [
  { id: "tiktok:veo",       kind: "tt", base: ["src/pipeline-quotes-veo.js"], timeoutMs: 30 * 60 * 1000 },
  { id: "shopee:shopee",     kind: "fb", base: ["src/shopee/reup.mjs", "--page", "shopee"] },
  { id: "shopee:gia_dung",   kind: "fb", base: ["src/shopee/reup.mjs", "--page", "gia_dung"] },
  { id: "shopee:tech",       kind: "fb", base: ["src/shopee/reup.mjs", "--page", "tech"] },
  { id: "shopee:sac_dep",    kind: "fb", base: ["src/shopee/reup.mjs", "--page", "sac_dep"] },
  { id: "shopee:thoi_trang", kind: "fb", base: ["src/shopee/reup.mjs", "--page", "thoi_trang"] },
  { id: "shopee:me_be",      kind: "fb", base: ["src/shopee/reup.mjs", "--page", "me_be"] },
  { id: "shopee:the_thao",   kind: "fb", base: ["src/shopee/reup.mjs", "--page", "the_thao"] },
  { id: "shopee:bach_hoa",   kind: "fb", base: ["src/shopee/reup.mjs", "--page", "bach_hoa"] },
  { id: "shopee:fb_repost",  kind: "fb", base: ["src/shopee/fb_repost.mjs", "--max", "1"] },
];

const IMMEDIATE_STAGGERS = [0, 2, 3, 4, 5, 7, 8, 10, 12];

function minutesUntil(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m || 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.max(0, Math.round((target - now) / 60000));
}

export function buildRegistry({ ttOnly = false, fbOnly = false, scheduleAt = null, scheduleEnd = null } = {}) {
  const fbJobs = BASE_JOBS.filter((j) => j.kind === "fb");
  const n = fbJobs.length;

  // delay cho FB job (phút)
  let fbDelays;
  if (scheduleAt) {
    const baseDelay = minutesUntil(scheduleAt);
    const endDelay = scheduleEnd ? minutesUntil(scheduleEnd) : baseDelay + 45;
    const window = endDelay - baseDelay;
    const stagger = n > 1 ? window / (n - 1) : 0;
    fbDelays = fbJobs.map((_, i) => Math.round(baseDelay + i * stagger));
  } else {
    fbDelays = fbJobs.map((_, i) => IMMEDIATE_STAGGERS[i] || 0);
  }

  // delay cho TikTok (giữa cửa sổ lịch)
  const ttDelay = scheduleAt
    ? Math.round(minutesUntil(scheduleAt) + (scheduleEnd ? (minutesUntil(scheduleEnd) - minutesUntil(scheduleAt)) / 2 : 22))
    : 1;

  const descriptors = [];
  for (const job of BASE_JOBS) {
    if (job.kind === "tt" && fbOnly) continue;
    if (job.kind === "fb" && ttOnly) continue;
    if (job.kind === "tt") {
      descriptors.push({
        id: job.id,
        run: { cmd: [...job.base, `--delay=${ttDelay}`], timeoutMs: job.timeoutMs },
        retry: { maxAttempts: 1 },
      });
    } else {
      const delay = fbDelays[fbJobs.indexOf(job)];
      descriptors.push({
        id: job.id,
        run: { cmd: [...job.base, "--delay", String(delay)] },
        retry: { maxAttempts: 2 },
      });
    }
  }
  return descriptors;
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `node --test test/loop/registry.test.mjs`
Expected: PASS (6 test)

- [ ] **Step 5: Commit**

```bash
git add src/loop/registry.mjs test/loop/registry.test.mjs
git commit -m "feat(loop): job registry — buildRegistry port stagger từ daily.mjs"
```

---

## Task 6: Đổi ruột `daily.mjs` + cờ `--dry-run`

**Files:**
- Modify: `src/daily.mjs` (thay khối FB_SCRIPT_DEFS/FB_SCRIPTS/runScript/main — dòng 63-269)
- Modify: `package.json` (thêm script `test:loop`)

Giữ lại: arg parsing (`--fb-only`/`--tt-only`/`--skip-cache`/`--schedule-at`/`--schedule-end`), `ts()`, `log()`, `isCacheFresh()`, `killChrome()`, `CACHE_FILE`/`CACHE_MAX_AGE`. Bỏ: `FB_SCRIPT_DEFS`, `IMMEDIATE_STAGGERS`, `FB_SCRIPTS`, `runScript`, `minutesUntil` (đã chuyển sang registry).

- [ ] **Step 1: Thêm import + cờ dry-run ở đầu file**

Thêm dưới các import hiện có (sau dòng 23, `const ROOT = ...`):

```js
import { buildRegistry } from "./loop/registry.mjs";
import { runAll } from "./loop/kernel.mjs";
import { createStore } from "./loop/state.mjs";

const DB_PATH = join(ROOT, "data/loop_state.db");
const DRY_RUN = args.includes("--dry-run");
```

- [ ] **Step 2: Xoá khối FB_SCRIPT_DEFS → FB_SCRIPTS (dòng 63-93) và hàm `minutesUntil`/`runScript`**

Xoá: `minutesUntil` (dòng 42-49), `FB_SCRIPT_DEFS`/`IMMEDIATE_STAGGERS`/`FB_SCRIPTS` (dòng 63-93), `runScript` (dòng 114-151). Giữ `ts`, `log`, `isCacheFresh`, `killChrome`.

- [ ] **Step 3: Thay toàn bộ hàm `main()` (dòng 162-268) bằng:**

```js
async function main() {
  const startTime = Date.now();
  log("╔══════════════════════════════════════════════════╗");
  log("║        DAILY RUN — Loop Kernel (TikTok + FB)     ║");
  log("╚══════════════════════════════════════════════════╝");
  if (DRY_RUN) log("🧪 DRY-RUN: không đăng thật, không refresh cache");

  // Refresh Shopee cache nếu cần (bỏ qua khi tt-only hoặc dry-run)
  if (!TT_ONLY && !DRY_RUN) {
    if (!SKIP_CACHE && !isCacheFresh()) {
      log("🛒 [Cache] Refreshing Shopee product cache...");
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("node", ["src/shopee/fetch_products.mjs"], { cwd: ROOT, stdio: "inherit", shell: true });
      killChrome();
      log(r.status === 0 ? "🛒 [Cache] ✅ Refreshed" : "🛒 [Cache] ⚠ failed, dùng cache cũ");
    } else {
      log(SKIP_CACHE ? "🛒 [Cache] Skipped (--skip-cache)" : "🛒 [Cache] Fresh (<4h)");
    }
    killChrome();
  }

  const registry = buildRegistry({ ttOnly: TT_ONLY, fbOnly: FB_ONLY, scheduleAt: SCHEDULE_AT, scheduleEnd: SCHEDULE_END });
  const store = createStore(DB_PATH);
  const results = await runAll(registry, { store, dryRun: DRY_RUN });
  store.close();

  // Summary
  log("");
  log("╔══════════════════════════════════════════════════╗");
  log("║                    SUMMARY                       ║");
  log("╚══════════════════════════════════════════════════╝");
  let failCount = 0;
  for (const r of results) {
    if (!r.ok) { log(`  ❌ ${r.id.padEnd(18)} crash: ${r.error}`); failCount++; continue; }
    const bad = r.outcomes.filter((o) => o.status === "failed" || o.status === "dead");
    if (bad.length) failCount++;
    const icon = bad.length ? "❌" : "✅";
    log(`  ${icon} ${r.id.padEnd(18)} ${r.outcomes.map((o) => o.status).join(", ") || "—"}`);
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log("");
  log(`⏱ ${elapsed}s | ${failCount > 0 ? `❌ ${failCount} job có lỗi` : "✅ All good!"}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: Thêm script test:loop vào `package.json`**

Trong khối `"scripts"`, thêm:

```json
    "test:loop": "node --test test/loop/contract.test.mjs test/loop/state.test.mjs test/loop/escalate.test.mjs test/loop/kernel.test.mjs test/loop/registry.test.mjs"
```

- [ ] **Step 5: Chạy toàn bộ test loop, xác nhận PASS**

Run: `npm run test:loop`
Expected: PASS (28 test tổng)

- [ ] **Step 6: Smoke test dry-run (không đăng thật)**

Run: `node src/daily.mjs --dry-run`
Expected: exit 0; in SUMMARY với 10 dòng `✅`; mỗi job status `done`.

- [ ] **Step 7: Kiểm tra state đã ghi**

Run:
```bash
node -e "import('./src/loop/state.mjs').then(({createStore})=>{const s=createStore('data/loop_state.db');console.log(s.list().map(r=>r.job_id+':'+r.status));s.close();})"
```
Expected: in ra ~10 dòng `...:done` (hoặc `dry-run` tuỳ verify) — xác nhận persist hoạt động.

- [ ] **Step 8: Commit**

```bash
git add src/daily.mjs package.json
git commit -m "feat(loop): daily.mjs chạy qua kernel + cờ --dry-run"
```

---

## Self-Review (đã chạy)

**1. Spec coverage:**
- §2 hợp đồng + §4.3 → Task 1 ✅
- §4.4 central state → Task 2 ✅
- §4.5 escalate → Task 3 ✅
- §4.2 engine + §5 dedup/retry/idempotency → Task 4 ✅
- §4.1 descriptor + registry v1 (10 job) → Task 5 ✅
- §6 điểm vào + `--dry-run` + §8 integration → Task 6 ✅
- §3 5 bước → phủ bởi Task 4 (engine) + Task 1 (verify input).

**2. Placeholder scan:** Không có TBD/TODO; mọi step có code/lệnh thật.

**3. Type consistency:**
- `parseResult` trả `{ ok, items, error }` — dùng nhất quán ở kernel.
- `store.upsert(jobId, itemId, patch)` / `store.get(jobId, itemId)` — dùng đúng chữ ký ở kernel & daily.
- `runScript(name, cmdArgs, opts)` trả `{ name, code, output }` — kernel đọc `raw.output`/`raw.code` ✅.
- `sendEscalation(info, {send})` — kernel gọi `escalate(info)` (1 arg), default `send` = telegram ✅.
- `buildRegistry(opts)` trả descriptor `{ id, run: { cmd, timeoutMs? }, retry }` — khớp `runJob` đọc `descriptor.run.cmd` ✅.

**Lưu ý v1 (ghi nhận, không phải bug):** cache refresh giờ chạy *trước* runAll (serial) thay vì song song với TikTok. Vì delay là tuyệt đối (`--schedule-at`), thời điểm đăng thật không đổi — chỉ wall-clock của tiến trình dài hơn vài phút. Chấp nhận cho v1.
