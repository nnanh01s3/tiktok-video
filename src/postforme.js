/**
 * Post for Me API wrapper — drop-in replacement for PostFast.
 *
 * API Docs: https://api.postforme.dev/docs
 * Same interface as postfast.js but routes to postforme.dev API.
 *
 * Key differences from PostFast:
 *   - Auth: Bearer token (not pf-api-key header)
 *   - Upload: POST /v1/media/create-upload-url → PUT signed URL → returns media_url
 *   - Schedule: POST /v1/social-posts with social_accounts array + media[].url
 *   - FB Reels: platform_configurations.facebook.placement = "reels"
 */
import { readFile, stat } from "fs/promises";

const API_BASE = "https://api.postforme.dev";

function headers() {
  const apiKey = process.env.POSTFORME_API_KEY;
  if (!apiKey) throw new Error("POSTFORME_API_KEY not set in environment");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Upload a video file to Post for Me (via signed URL).
 * Returns the public media_url to use in post creation.
 */
export async function uploadVideo(videoPath, { maxRetries = 3 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Step 1: Get signed upload URL
      const urlRes = await fetch(`${API_BASE}/v1/media/create-upload-url`, {
        method: "POST",
        headers: headers(),
      });

      if (!urlRes.ok) throw new Error(`PostForMe upload URL error ${urlRes.status}: ${await urlRes.text()}`);

      const { upload_url, media_url } = await urlRes.json();

      // Step 2: Upload video to signed URL
      const videoBuffer = await readFile(videoPath);
      const fileSize = (await stat(videoPath)).size;

      const uploadRes = await fetch(upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": fileSize.toString(),
        },
        body: videoBuffer,
      });

      if (!uploadRes.ok) throw new Error(`Upload error ${uploadRes.status}: ${await uploadRes.text()}`);

      return media_url;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = attempt * 5000;
        console.log(`[PostForMe] Upload attempt ${attempt} failed: ${err.message}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Schedule a post on Facebook/TikTok/Instagram.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.socialAccountIds — Account ID(s) to post to
 * @param {string} opts.mediaUrl — Public URL from uploadVideo()
 * @param {string} opts.caption — Post text (max 2200 chars)
 * @param {string} [opts.scheduledAt] — ISO 8601 timestamp (omit for immediate)
 * @param {string} [opts.platform] — "facebook" | "tiktok" | "instagram"
 * @param {Object} [opts.platformConfig] — Platform-specific settings
 * @param {string} [opts.externalId] — Optional external tracking ID
 */
export async function schedulePost(opts) {
  const accountIds = Array.isArray(opts.socialAccountIds)
    ? opts.socialAccountIds
    : [opts.socialAccountIds];

  const body = {
    caption: opts.caption,
    social_accounts: accountIds,
    media: [{ url: opts.mediaUrl, type: "video" }],
  };

  if (opts.scheduledAt) {
    body.scheduled_at = opts.scheduledAt;
  }

  if (opts.externalId) {
    body.external_id = opts.externalId;
  }

  // Platform-specific configurations
  const platformConfig = opts.platformConfig || {};
  if (opts.platform === "facebook") {
    body.platform_configurations = {
      facebook: { placement: "reels", ...platformConfig },
    };
  } else if (opts.platform === "tiktok") {
    body.platform_configurations = {
      tiktok: {
        privacy_status: "public",
        allow_comments: true,
        allow_duet: true,
        allow_stitch: true,
        ...platformConfig,
      },
    };
  } else if (opts.platform === "instagram") {
    body.platform_configurations = {
      instagram: { placement: "reels", share_to_feed: true, ...platformConfig },
    };
  }

  const res = await fetch(`${API_BASE}/v1/social-posts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`PostForMe schedule error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    postId: data.id,
    status: data.status,
    scheduledAt: opts.scheduledAt,
  };
}

/**
 * Get connected social accounts.
 */
export async function getAccounts(platform) {
  const params = new URLSearchParams();
  if (platform) params.set("platform", platform);

  const res = await fetch(`${API_BASE}/v1/social-accounts?${params}`, {
    headers: headers(),
  });

  if (!res.ok) throw new Error(`PostForMe accounts error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Delete a scheduled/published post.
 */
export async function deletePost(postId) {
  const res = await fetch(`${API_BASE}/v1/social-posts/${postId}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) throw new Error(`PostForMe delete error ${res.status}: ${await res.text()}`);
}

/**
 * Get post results (analytics/status).
 */
export async function getPostResults(postId) {
  const params = postId ? `?post_id=${postId}` : "";
  const res = await fetch(`${API_BASE}/v1/social-post-results${params}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`PostForMe results error ${res.status}: ${await res.text()}`);
  return res.json();
}
