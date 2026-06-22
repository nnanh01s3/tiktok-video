import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../../src/douyin/state.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "douyin-state-"));
}

test("state: empty when file does not exist", () => {
  const dir = makeTempDir();
  const state = createState(join(dir, "state.json"));
  assert.deepEqual(state.list(), []);
  rmSync(dir, { recursive: true, force: true });
});

test("state: upsert sets status and persists", () => {
  const dir = makeTempDir();
  const path = join(dir, "state.json");
  const s1 = createState(path);
  s1.upsert("7626", { status: "downloaded", title_cn: "测试" });
  const s2 = createState(path);
  assert.equal(s2.get("7626").status, "downloaded");
  assert.equal(s2.get("7626").title_cn, "测试");
  rmSync(dir, { recursive: true, force: true });
});

test("state: list filters by status", () => {
  const dir = makeTempDir();
  const path = join(dir, "state.json");
  const s = createState(path);
  s.upsert("a", { status: "published" });
  s.upsert("b", { status: "publish_failed" });
  s.upsert("c", { status: "published" });
  const failed = s.list({ status: /_failed$/ });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].modal_id, "b");
  rmSync(dir, { recursive: true, force: true });
});

test("state: corrupted JSON falls back to empty + backup", () => {
  const dir = makeTempDir();
  const path = join(dir, "state.json");
  writeFileSync(path, "{not valid json");
  const s = createState(path);
  assert.deepEqual(s.list(), []);
  const backups = readdirSync(dir).filter(f => f.startsWith("state.json.bak."));
  assert.ok(backups.length === 1, "expected 1 backup file");
  rmSync(dir, { recursive: true, force: true });
});
