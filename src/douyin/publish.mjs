/**
 * Publish composed mp4 to enabled channels via social-poster.js.
 */
import "../env.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { createPoster } from "../social-poster.js";
import { parseSRT } from "./utils/srt.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateCaption({ original_title_cn, vn_cues_sample }) {
  const sampleText = vn_cues_sample.slice(0, 3).map(c => c.text).join(" / ");
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: `Bạn viết caption ngắn cho video TikTok/Reels/YouTube Shorts tiếng Việt.
Yêu cầu:
- Tối đa ${DOUYIN_CONFIG.caption.maxChars} ký tự (chưa tính hashtag — sẽ thêm sau)
- Gây tò mò, mời gọi xem
- KHÔNG nhắc Douyin / Trung Quốc / nguồn gốc
- KHÔNG thêm hashtag (sẽ append tự động)
- Output 1 dòng, không quote, không markdown`,
    messages: [{
      role: "user",
      content: `Tiêu đề gốc (tiếng Trung — chỉ để tham khảo): ${original_title_cn}\nNội dung 3 câu đầu (tiếng Việt): ${sampleText}\n\nViết caption:`,
    }],
  });
  const raw = (res.content?.[0]?.text || "").trim();
  return raw.replace(/^["']|["']$/g, "").slice(0, DOUYIN_CONFIG.caption.maxChars);
}

function appendHashtags(caption) {
  const tags = DOUYIN_CONFIG.caption.requiredHashtags.join(" ");
  return `${caption}\n${tags}`;
}

function nextSlotISO(offsetMin = 5) {
  return DateTime.now().setZone("Asia/Ho_Chi_Minh").plus({ minutes: offsetMin }).toISO();
}

async function publishToChannel(name, cfg, { composed_mp4, caption }) {
  if (!cfg.enabled) return { channel: name, status: "skipped", reason: "disabled" };
  const idField = name === "tiktok" ? "pfmTtId"
                : name === "yt_shorts" ? "pfmYtId"
                : "pfmId";
  if (!cfg[idField]) {
    return { channel: name, status: "skipped", reason: `${idField} not configured` };
  }

  const posterConfig = {
    provider: cfg.provider || "postforme",
    [idField]: cfg[idField],
  };
  const poster = createPoster(posterConfig);

  try {
    const mediaRef = await poster.upload(composed_mp4);
    const scheduledAt = nextSlotISO(5);

    let result;
    if (name === "tiktok") {
      result = await poster.scheduleTikTok({ mediaRef, caption, scheduledAt });
    } else if (name === "yt_shorts") {
      result = await poster.scheduleYouTube?.({ mediaRef, caption, scheduledAt })
            || { postId: null, note: "YouTube method not available on poster" };
    } else {
      result = await poster.scheduleFacebook({ mediaRef, caption, scheduledAt });
    }
    return { channel: name, status: "ok", post_id: result.postId, scheduledAt };
  } catch (e) {
    return { channel: name, status: "fail", error: e.message };
  }
}

export async function publish({ composed_mp4, modal_id, original_title_cn, vn_srt_path, dryRun = false }) {
  const vnCues = parseSRT(readFileSync(vn_srt_path, "utf8"));
  const caption = await generateCaption({ original_title_cn, vn_cues_sample: vnCues });
  const fullCaption = appendHashtags(caption);

  log.info("publish", `caption: ${fullCaption.replace(/\n/g, " | ")}`);

  if (dryRun) {
    log.info("publish", "dry-run — not posting");
    return [{ channel: "ALL", status: "dry-run", caption: fullCaption }];
  }

  const results = [];
  for (const [name, cfg] of Object.entries(DOUYIN_CONFIG.channels)) {
    const r = await publishToChannel(name, cfg, { composed_mp4, caption: fullCaption });
    log.info("publish", `${name}: ${r.status}${r.post_id ? ` post_id=${r.post_id}` : ""}${r.error ? ` err=${r.error}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
    results.push(r);
  }
  return results;
}
