import "../src/env.js";
import assert from "node:assert/strict";
import { classifyRelevance } from "../src/shopee/reels-classifier.mjs";

const TECH_TOPIC = "Review điện thoại, laptop, tai nghe, smartwatch, camera, app công nghệ, so sánh spec, unboxing gadget, thủ thuật iOS/Android. KHÔNG bao gồm: game show đoán đồ/đoán người, trivia địa lý/lịch sử, challenge giải trí, lắc chai nước.";

const GIA_DUNG_TOPIC = "Đồ gia dụng, thiết bị nhà bếp, nồi chiên không dầu, máy xay, smart home, mẹo dọn dẹp, tips làm bếp, organize tủ lạnh, dọn nhà. KHÔNG bao gồm: review điện thoại, vlog gia đình, content trẻ em thuần.";

const THOI_TRANG_TOPIC = "OOTD, outfit styling, phối đồ, xu hướng thời trang, try-on haul, phụ kiện (túi, giày, trang sức), street style, diễn show. KHÔNG bao gồm: challenge lắc chai, game trẻ em, gia đình vlog thuần, skincare.";

const cases = [
  {
    name: "Schannel game show → tech (expect OFF-TOPIC)",
    video: {
      id: "test_1",
      title: "Đoán tên người nổi tiếng: Sao mà gợi ý xong lú luôn =))) #schannel #xuhuong",
      duration: 60,
      source_name: "Schannel",
    },
    topic: TECH_TOPIC,
    expectMatch: false,
  },
  {
    name: "BYB challenge → thoi_trang (expect OFF-TOPIC)",
    video: {
      id: "test_2",
      title: "Thử thách lắc chai nước ngẫu nhiên cùng các mẫu nhí #bybacademy",
      duration: 45,
      source_name: "BYB Academy VN",
    },
    topic: THOI_TRANG_TOPIC,
    expectMatch: false,
  },
  {
    name: "Anh Vũ Trọc camera → gia_dung (expect ON-TOPIC)",
    video: {
      id: "test_3",
      title: "Camera giám sát năng lượng mặt trời đang được miễn phí 4K ống kính HD",
      duration: 60,
      source_name: "Anh Vũ Trọc",
    },
    topic: GIA_DUNG_TOPIC,
    expectMatch: true,
  },
];

let passed = 0;
for (const c of cases) {
  const verdict = await classifyRelevance(c.video, c.topic);
  const ok = verdict.match === c.expectMatch;
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${c.name}`);
  console.log(`   → match=${verdict.match} score=${verdict.score.toFixed(2)} reason="${verdict.reason}"`);
  if (ok) passed++;
}

assert.equal(passed, cases.length, `${cases.length - passed} classification case(s) failed`);
console.log(`\n✅ All ${cases.length} classifier verification cases passed`);
