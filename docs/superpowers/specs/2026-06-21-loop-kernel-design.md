# Loop Kernel — Quy trình dùng chung cho mọi job

**Ngày:** 2026-06-21
**Trạng thái:** Spec đã duyệt thiết kế, chờ review trước khi viết plan
**Cách tiếp cận:** C (Hybrid) — kernel điều phối, job vẫn chạy subprocess nhưng nói chung một "hợp đồng kết quả" JSON.

---

## 1. Bối cảnh & mục tiêu

Dự án có nhiều pipeline rời rạc — TikTok quotes, 8 page Shopee, Douyin repurpose, YouTube reup, Rừng Xì Tin, daily-reels — và mỗi pipeline tự cài lại các bước *tìm việc / làm từng bước / xử lý lỗi / lưu trạng thái / báo lỗi* theo một kiểu hơi khác nhau. Hệ quả: thêm một việc mới luôn tốn công, và các bước cuối (verify có cấu trúc, persist tập trung, escalate thông minh) hầu như chưa có.

**Mục tiêu:** một *vòng lặp khung (outer loop) dùng chung* gói gọn 5 bước — Discover → Assign → Run → Verify → Persist, cộng nhánh Escalate — mà **mọi job** đều cắm vào được, trong khi mỗi job vẫn giữ "ruột" riêng (inner loop).

Tham chiếu khái niệm: mô hình "loop engineering" (Discover / Assign / Verify / Persist / Escalate). Bản thiết kế này ánh xạ 5 bước đó vào code thật của dự án.

### Cái đã có (tận dụng, không viết lại)
- `src/daily.mjs` — đã là meta-orchestrator phôi thai: `runScript()` spawn job như subprocess, gom `{name, code, output}`, in summary, exit code theo pass/fail. Thiếu đúng 3 bước cuối của loop.
- `src/douyin/state.mjs` — máy trạng thái per-item (`discovered → downloaded → ... → published`, kèm `*_failed`). Đây là hạt nhân của bước Persist, nhưng hiện chỉ Douyin dùng.
- SQLite DB + `scripts/migrate-processed-json-to-sqlite.mjs` — đã có hạ tầng lưu trữ.
- Util Telegram alert — đã có, sẽ được bọc lại cho Escalate.

---

## 2. Phạm vi

### Trong phạm vi (v1)
- Một kernel 5 bước tổng quát, chạy được.
- Central state store SQLite dùng chung.
- Hợp đồng kết quả JSON + helper `printResult()` và parser `parseResult()`.
- Escalate qua Telegram có cấu trúc.
- Bọc **chỉ cụm `daily.mjs`**: TikTok Veo pipeline + 8 page Shopee (`reup.mjs --page <x>`) + `fb_repost`.
- `daily.mjs` và `index.js` đổi ruột để gọi kernel, **giữ nguyên hành vi đăng bài hiện tại**.
- Cờ `--dry-run` để test luồng mà không đăng thật.

### Ngoài phạm vi (v1 — làm sau, tăng dần)
- Hút Douyin repurpose, YouTube reup, Rừng Xì Tin, daily-reels vào kernel.
- Di cư `douyin/state.mjs` sang central store.
- Dashboard / UI theo dõi loop.
- Rate-limiting động hay lập lịch thông minh ngoài cơ chế slot hiện có.

**Nguyên tắc YAGNI:** v1 chỉ chính thức hoá thứ `daily.mjs` đã làm + thêm 3 bước còn thiếu. Không thêm khả năng nào chưa có job nào cần.

---

## 3. Kiến trúc tổng thể

Vòng lặp dùng chung bọc bất kỳ job nào:

```
                         ┌──────────── lặp lại mỗi tick ────────────┐
                         │                                          │
  mọi job ──►  ① Discover ──► ② Assign ──► ③ Run ──► ④ Verify ──► ⑤ Persist
                  tìm việc      lọc theo     chạy job   đọc hợp     ghi trạng
                  cần làm       state        subproc.   đồng JSON   thái
                                                          │            │
                                                  khi lỗi ×N           ▼
                                                          ▼      State · SQLite
                                                     Escalate    (ASSIGN đọc,
                                                  báo người       PERSIST ghi)
                                                  (Telegram)
```

- **Discover** — job khai báo cách tìm "work item" (sản phẩm mới, video mới…) hoặc đơn giản trả về một item giả "single-run" cho job kiểu "chạy 1 phát mỗi tick".
- **Assign** — đối chiếu central state: bỏ qua item `done`/`dead`, tôn trọng giới hạn (vd `MAX_PER_RUN`), chọn item xử lý lần này.
- **Run** — spawn subprocess (tái dùng `runScript` của `daily.mjs`), bắt stdout.
- **Verify** — parse hợp đồng kết quả; chạy `descriptor.verify(result)` → `{ ok, reason, skip }`. Job "câm" thì fallback về exit code. `skip: true` = bỏ item này nhưng không tính là lỗi (vd Reels < 0.5MB).
- **Persist** — ghi `status`, `attempts`, `last_error`, `meta` vào central store.
- **Escalate** — nhánh khi verify fail và đã hết lượt retry → Telegram có cấu trúc.

---

## 4. Thành phần

```
src/loop/
  kernel.mjs     # engine 5 bước: runJob(descriptor, opts), runAll(registry, opts)
  state.mjs      # central store SQLite (tổng quát hoá douyin/state.mjs)
  contract.mjs   # parseResult(stdout) + printResult(result) cho job
  escalate.mjs   # format & gửi Telegram (bọc util telegram sẵn có)
  registry.mjs   # danh sách job descriptor — v1: TikTok + 8 page Shopee + fb_repost
```

Mỗi module có một trách nhiệm rõ ràng, giao tiếp qua interface hẹp, test được độc lập.

### 4.1 Job Descriptor (`registry.mjs`)

Hợp đồng giữa kernel và một job. Mọi trường tuỳ chọn đều có mặc định hợp lý để job đơn giản chỉ cần khai báo `id` + `run`.

```js
{
  id: "shopee:gia_dung",            // duy nhất, dùng làm job_id trong state
  discover: async () => [...items], // tuỳ chọn; mặc định () => [{ id: "run" }] (single-run)
  run: {                            // bắt buộc
    cmd: ["src/shopee/reup.mjs", "--page", "gia_dung"], // truyền cho `node`
    timeoutMs: 15 * 60 * 1000,
  },
  verify: async (result, item) => ({ ok: true, reason: "", skip: false }), // tuỳ chọn; mặc định = result.ok
  retry: { maxAttempts: 2 },        // tuỳ chọn; mặc định { maxAttempts: 1 } (không retry)
  escalate: { on: "exhausted" },    // tuỳ chọn; mặc định escalate khi hết retry
}
```

- `discover` mặc định trả một item giả `{ id: "run" }` → job kiểu "chạy 1 phát" không cần viết discover.
- `verify` mặc định lấy `result.ok` từ hợp đồng (hoặc fallback exit code) → job không cần verify riêng vẫn chạy.
- v1 registry liệt kê đúng 10 job: TikTok + 8 page Shopee + `fb_repost`.

### 4.2 Kernel engine (`kernel.mjs`)

`runJob(descriptor, { dryRun, store })` — chạy một job qua đủ 5 bước cho mọi item của nó:

```
items = await descriptor.discover()                    // ① Discover
for item in items:
    st = store.get(descriptor.id, item.id)
    if st?.status in {done, dead}: continue            // ② Assign (idempotency)
    if assignLimitReached(): break                     // ② Assign (rate limit)
    store.upsert(descriptor.id, item.id, { status: "running" })
    if dryRun:
        result = { ok: true, items: [{ id: item.id, status: "dry-run" }] }
    else:
        raw    = await runScript(descriptor.id, descriptor.run.cmd, { timeoutMs })  // ③ Run → { name, code, output }
        result = parseResult(raw.output, raw.code)                  // hợp đồng / fallback
    v = await descriptor.verify(result, item)          // ④ Verify → { ok, reason, skip }
    if v.skip:
        store.upsert(id, item.id, { status: "skipped", last_error: v.reason })  // ⑤ — không retry, không escalate
    else if v.ok:
        store.upsert(id, item.id, { status: "done", meta: result.meta, last_error: null })  // ⑤
    else:
        attempts = (st?.attempts ?? 0) + 1
        if attempts >= descriptor.retry.maxAttempts:
            store.upsert(id, item.id, { status: "dead", attempts, last_error: v.reason })
            await escalate({ jobId: id, itemId: item.id, step: "verify", reason: v.reason, attempts, logTail })
        else:
            store.upsert(id, item.id, { status: "failed", attempts, last_error: v.reason })  // → pending lần sau
```

`runAll(registry, opts)` — chạy các job theo cùng kiểu song song/staggered như `daily.mjs` hôm nay (giữ nguyên cửa sổ lịch `--schedule-at` / `--schedule-end` và các stagger). Mỗi job được bọc try/catch: **một job crash không được giết cả loop**.

### 4.3 Hợp đồng kết quả (`contract.mjs`)

Job in ra **dòng cuối stdout** có tiền tố mốc cố định:

```
::LOOP_RESULT:: {"ok":true,"items":[{"id":"prod_123","status":"published","meta":{"url":"...","sizeBytes":1240000}}],"error":null}
```

- `printResult(result)` — helper job gọi để in đúng định dạng.
- `parseResult(stdout, exitCode)`:
  1. Tìm dòng cuối khớp tiền tố `::LOOP_RESULT::` → parse JSON, trả về.
  2. Không có → **fallback**: `ok = (exitCode === 0)`, và thử regex cũ `/(?:Đăng|Posted) (\d+)\/(\d+)/` để rút số lượng (giữ tương thích log hiện tại của `daily.mjs`).
- Job "câm" (chưa nâng cấp) vẫn chạy được qua nhánh fallback → di cư từng pipeline một, không big-bang.

### 4.4 Central state store (`state.mjs`)

Tổng quát hoá `douyin/state.mjs`, lưu trong SQLite (đã có DB sẵn). Một bảng:

```sql
loop_state (
  job_id     TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  status     TEXT NOT NULL,   -- pending | running | done | failed | dead | skipped
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  meta       TEXT,            -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, item_id)
)
```

API giữ đúng hình dạng `state.mjs` cũ để Douyin di cư về sau dễ:

```js
store.get(jobId, itemId)            // → row | null
store.upsert(jobId, itemId, patch)  // merge patch, tự set updated_at, attempts giữ nguyên nếu patch không có
store.list({ jobId, status })       // status nhận string hoặc RegExp
```

**Taxonomy trạng thái thống nhất:**
- `pending` — chờ xử lý (mới discover, hoặc failed-còn-lượt).
- `running` — đang chạy (đặt trước Run; nếu process chết giữa chừng, tick sau coi như cần xử lý lại).
- `done` — verify pass; **Assign sẽ bỏ qua vĩnh viễn** (chống đăng trùng).
- `failed` — verify fail nhưng còn lượt retry → tick sau chạy lại.
- `dead` — hết lượt retry; đã escalate; Assign bỏ qua.
- `skipped` — chủ động bỏ (vd Reels < 0.5MB) — không retry, không escalate.

### 4.5 Escalate (`escalate.mjs`)

Bọc util Telegram hiện có. Message có cấu trúc thay vì `❌` cụt:

```
🚨 [loop] shopee:gia_dung / item prod_123
   bước: verify — "sizeBytes 410000 < 500000 (Reels không phát được)"
   đã thử: 2/2 → đánh dấu DEAD
   log: …(20 dòng cuối)…
```

---

## 5. Idempotency & chống đăng trùng

Đây là ràng buộc an toàn quan trọng nhất — double-post lên FB/TikTok là tác hại thật.

- Bước Assign **bỏ qua mọi item `done`/`dead`**. Central state *chính là* lá chắn dedup.
- Hệ quả: chạy lại `daily.mjs` bao nhiêu lần trong ngày cũng không đăng lại item đã `done`.
- `status: "running"` được ghi *trước* khi Run. Nếu process chết giữa chừng, item ở `running` → tick sau xử lý lại (an toàn vì publish thật của job nên tự kiểm tra trùng ở tầng của nó; v1 chấp nhận khả năng hiếm chạy lại một item đang dở).

---

## 6. Điểm vào (giữ nguyên hành vi)

- `src/daily.mjs` → đổi ruột thành `runAll(registry, { dryRun })` một lần. 9 FB script + TikTok vẫn chạy y hệt hôm nay (cùng stagger, cùng cửa sổ lịch). Các cờ CLI hiện có (`--fb-only`, `--tt-only`, `--skip-cache`, `--schedule-at`, `--schedule-end`) được giữ.
- `src/index.js` (24/7) → tick kernel theo slot lịch; nơi Discover + retry item `pending`/`failed` sống.
- Cờ mới `--dry-run` → stub bước Run (`result = { ok: true }`), chạy đủ Discover/Assign/Persist/Escalate mà **không đăng thật**.

---

## 7. Xử lý lỗi

- Job non-zero exit / timeout / verify-fail → `failed` (còn lượt) hoặc `dead` (hết lượt) + escalate.
- Kernel bọc mỗi job trong try/catch riêng → một job lỗi không làm sập `runAll`.
- `state.mjs` giữ cơ chế tự backup file hỏng như `douyin/state.mjs` (rename `.bak.<ts>` rồi khởi tạo lại) — áp dụng cho lỗi DB không mở được.
- Timeout: `descriptor.run.timeoutMs` → kill subprocess, coi như fail bước Run.

---

## 8. Chiến lược test

- **Unit (kernel):** job giả qua `runScript` stub —
  - job in contract `ok:true` → `done`, Assign lần sau skip (idempotency).
  - job luôn fail → sau `maxAttempts` thành `dead` + `escalate` được gọi đúng 1 lần.
  - job flaky (fail rồi pass) → `failed` rồi `done`.
  - job "câm" exit 0 / exit 1 → fallback parse đúng.
- **Unit (contract):** `parseResult` với (a) có `::LOOP_RESULT::`, (b) chỉ có log + exit 0, (c) log + regex `Đăng X/Y`.
- **Integration:** `node src/daily.mjs --dry-run` chạy full registry, không đăng thật, kiểm tra state ghi đúng và summary khớp.

---

## 9. Lộ trình di cư (tăng dần)

1. **v1:** dựng `src/loop/*`, bọc cụm `daily.mjs` (TikTok + Shopee). Pipeline chạy ở chế độ "câm" (fallback). Chứng minh kernel ổn định qua vài ngày chạy thật.
2. **v1.1:** thêm `printResult()` vào `shopee/reup.mjs` và TikTok pipeline → verify giàu (vd check `sizeBytes`, độ dài video ≥ 60s).
3. **v2:** hút Douyin (di cư `douyin/state.mjs` → central store), YouTube reup, daily-reels, Rừng Xì Tin — mỗi cái chỉ là thêm một descriptor + `printResult()`.

---

## 10. Quyết định mở (xử lý ở giai đoạn plan)

- Vị trí file DB SQLite dùng chung (tái dùng DB hiện có hay file `data/loop_state.db` riêng) — quyết khi viết plan, ưu tiên tái dùng DB sẵn có.
- Có cần lock chống 2 tiến trình kernel chạy đè không — v1 giả định chỉ một tiến trình (như hiện tại); ghi nhận, chưa làm.
