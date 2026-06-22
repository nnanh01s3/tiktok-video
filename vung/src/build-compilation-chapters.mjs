/**
 * Build FFMETADATA1 chapter file for Rừng Xì Tin compilation.
 * Reads each episode's duration via ffprobe, accumulates offsets,
 * accounting for 3s intro prefix and 5s outro suffix.
 */
import { execSync } from "child_process";
import { writeFileSync } from "fs";

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const EPISODES = [
  { num: 1, title: "Quả Chuối Bí Ẩn" },
  { num: 2, title: "Wifi Rừng Bị Lag" },
  { num: 3, title: "Ngày Sống Ảo" },
  { num: 4, title: "Mật Ong Biến Mất" },
  { num: 5, title: "Cuộc Đua Tốc Độ" },
  { num: 6, title: "Hiểu Lầm Tai Hại" },
  { num: 7, title: "Ngày Mưa Chán Đời" },
  { num: 8, title: "Thông Minh Giả Tạo" },
  { num: 9, title: "Hộp Quà Bí Mật" },
  { num: 10, title: "Một Ngày Lười Biếng" },
  { num: 11, title: "Trà Detox Rừng Xanh" },
  { num: 12, title: "Theo Trend Nguy Hiểm" },
  { num: 13, title: "Ngày Đi Học" },
  { num: 14, title: "Cuộc Thi Tài Năng" },
  { num: 15, title: "Anh Hùng Rừng Xanh" },
];

const BASE = "D:/tiktok/vung/output";
const INTRO_MS = 3000;
const OUTRO_MS = 5000;

function probeDurationMs(path) {
  const out = execSync(`${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${path}"`, { encoding: "utf8" });
  return Math.round(parseFloat(out.trim()) * 1000);
}

const lines = [
  ";FFMETADATA1",
  "title=Rừng Xì Tin - Tổng Hợp 15 Tập",
  "artist=Rừng Xì Tin",
  "",
];

let cursor = 0;

// Intro chapter
lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${cursor}`, `END=${cursor + INTRO_MS}`, "title=Intro", "");
cursor += INTRO_MS;

// Episode chapters
for (const { num, title } of EPISODES) {
  const padded = String(num).padStart(2, "0");
  const file = `${BASE}/tap_${padded}/Rừng Xì Tin - Tập ${num} ${title}.mp4`;
  const dur = probeDurationMs(file);
  lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${cursor}`, `END=${cursor + dur}`, `title=Tập ${num}: ${title}`, "");
  cursor += dur;
  console.log(`Tập ${num}: ${title} → ${dur}ms (cursor: ${cursor})`);
}

// Outro chapter
lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${cursor}`, `END=${cursor + OUTRO_MS}`, "title=Outro - Cảm ơn", "");
cursor += OUTRO_MS;

writeFileSync(`${BASE}/chapters.txt`, lines.join("\n"), "utf8");
console.log(`\n✅ chapters.txt written. Total: ${cursor}ms = ${(cursor / 1000).toFixed(1)}s`);
