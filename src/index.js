/**
 * TikTokBot — Main entry point.
 *
 * Scheduler: 3 posts/day at peak VN hours (6:00AM, 11:50AM, 6:00PM ICT).
 * Pipeline: tries Veo first, falls back to FFmpeg slideshow on quota errors.
 * TTS: evening slot uses ElevenLabs (premium), others use Edge TTS (free).
 */
import dotenv from "dotenv";
dotenv.config({ path: "./config/.env" });
import cron from "node-cron";
import { runPipeline as runVeoPipeline } from "./pipeline-quotes-veo.js";
import { getDb, getQuoteStats, getPendingJobs } from "./db.js";

const TIMEZONE = "Asia/Ho_Chi_Minh";

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    log(`Telegram alert failed: ${err.message}`);
  }
}

function addJitter(minutes = 30) {
  return Math.floor(Math.random() * minutes * 60 * 1000);
}

/**
 * Check if a video has already been posted for this slot today.
 */
function alreadyPostedToday(slot) {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM videos
         WHERE status = 'posted'
           AND date(posted_at) = ?
           AND job_id LIKE ?`
      )
      .get(today, `%-${slot}-%`);
    return row.cnt > 0;
  } catch {
    return false;
  }
}

/**
 * Run pipeline: Imagen (primary).
 * Veo tạm tắt — sẽ bật lại sau khi tối ưu chi phí.
 */
async function runWithFallback(slot) {
  const ttsProvider = slot === "evening" ? "elevenlabs" : "edge";

  // Hybrid mode: Veo 3 for 8s hook + Imagen for slides
  // skipHook=false → generates Veo hook if available
  // forceImagen=true → slides always use Imagen + Ken Burns (not Veo per-slide)
  try {
    log(`[${slot}] Running pipeline: Veo hook + Imagen slides (TTS: ${ttsProvider})...`);
    const result = await runVeoPipeline({ ttsProvider, forceImagen: true, skipHook: false });
    if (result.success) return result;
    log(`[${slot}] Pipeline returned failure: ${result.error}`);
  } catch (err) {
    log(`[${slot}] Pipeline error: ${err.message}`);
  }

  // Fallback: no hook, Imagen only
  try {
    log(`[${slot}] Retrying without Veo hook...`);
    const result = await runVeoPipeline({ ttsProvider, forceImagen: true, skipHook: true });
    if (result.success) return result;
    log(`[${slot}] Fallback also failed: ${result.error}`);
  } catch (err) {
    log(`[${slot}] Fallback error: ${err.message}`);
  }

  return { success: false, error: "All pipelines failed" };
}

async function scheduledPost(slot) {
  // Duplicate check
  if (alreadyPostedToday(slot)) {
    log(`[${slot}] Already posted today, skipping`);
    return;
  }

  const jitter = addJitter(30);
  log(`[${slot}] Post scheduled with ${(jitter / 60000).toFixed(0)}min jitter`);

  setTimeout(async () => {
    try {
      log(`[${slot}] Starting pipeline...`);
      const result = await runWithFallback(slot);

      if (result.success) {
        log(`[${slot}] Posted: ${result.jobId} (${result.category}, ${result.duration?.toFixed(0)}s)`);
        await sendTelegramAlert(
          `✅ *${slot} post*\nCategory: ${result.category}\nDuration: ${result.duration?.toFixed(0)}s\nPipeline: ${result.veoCost ? "Veo" : "FFmpeg"}`
        );
      } else {
        log(`[${slot}] Pipeline failed: ${result.error}`);
        // Retry once after 5 minutes
        log(`[${slot}] Retrying in 5 minutes...`);
        setTimeout(async () => {
          try {
            const retry = await runWithFallback(slot);
            if (retry.success) {
              log(`[${slot}] Retry succeeded: ${retry.jobId}`);
              await sendTelegramAlert(`✅ *${slot} retry succeeded*\n${retry.category}`);
            } else {
              log(`[${slot}] Retry also failed: ${retry.error}`);
              await sendTelegramAlert(`❌ *${slot} failed after retry*: ${retry.error}`);
            }
          } catch (retryErr) {
            log(`[${slot}] Retry error: ${retryErr.message}`);
            await sendTelegramAlert(`❌ *${slot} retry error*: ${retryErr.message}`);
          }
        }, 5 * 60 * 1000);
      }
    } catch (err) {
      log(`[${slot}] Pipeline error: ${err.message}`);
      await sendTelegramAlert(`❌ *${slot} pipeline error*: ${err.message}`);
    }
  }, jitter);
}

function healthCheck() {
  try {
    const db = getDb();
    const stats = getQuoteStats();
    const pending = getPendingJobs();
    const totalUnused = stats.reduce((sum, s) => sum + s.unused, 0);

    log(`Health: DB OK, ${totalUnused} unused quotes, ${pending.length} pending jobs`);

    if (totalUnused < 200) {
      sendTelegramAlert(`⚠️ *Low quotes*: Only ${totalUnused} unused quotes remaining. Run seed script.`);
    }
  } catch (err) {
    log(`Health check failed: ${err.message}`);
    sendTelegramAlert(`❌ *Health check failed*: ${err.message}`);
  }
}

function dailyStats() {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const row = db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) as posted,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM videos WHERE date(created_at) = ?`
      )
      .get(today);

    const stats = getQuoteStats();
    const totalUnused = stats.reduce((sum, s) => sum + s.unused, 0);

    const msg = `📊 *Daily Report (${today})*\nPosted: ${row.posted || 0}\nFailed: ${row.failed || 0}\nQuotes remaining: ${totalUnused}`;
    log(msg.replace(/\*/g, ""));
    sendTelegramAlert(msg);
  } catch (err) {
    log(`Daily stats error: ${err.message}`);
  }
}

function startScheduler() {
  log("=== TikTokBot Scheduler Starting ===");

  // 3 posts/day at VN peak hours (ICT = UTC+7)
  cron.schedule("0 6 * * *", () => scheduledPost("morning"), { timezone: TIMEZONE });
  cron.schedule("50 11 * * *", () => scheduledPost("noon"), { timezone: TIMEZONE });
  cron.schedule("0 18 * * *", () => scheduledPost("evening"), { timezone: TIMEZONE });

  // Health check every 30 minutes
  cron.schedule("*/30 * * * *", healthCheck);

  // Daily stats at 23:00 ICT
  cron.schedule("0 23 * * *", dailyStats, { timezone: TIMEZONE });

  // Startup health check
  healthCheck();

  log("Scheduler running. Posts: 6:00AM, 11:50AM, 6:00PM ICT + jitter ±30min");
  log("Pipeline: Imagen + Ken Burns (primary)");
  log("TTS: ElevenLabs (evening) → Edge TTS (morning/noon)");
  log("Ctrl+C to stop.\n");

  sendTelegramAlert("🟢 *TikTokBot started*\nSchedule: 3 posts/day (7AM, 12PM, 7PM ICT)\nPipeline: Imagen + Ken Burns");
}

process.on("SIGINT", () => {
  log("Shutting down...");
  sendTelegramAlert("🔴 *TikTokBot stopped*");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down...");
  process.exit(0);
});

startScheduler();
