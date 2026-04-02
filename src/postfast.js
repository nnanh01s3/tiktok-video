/**
 * PostFast API integration.
 * Handles video upload and TikTok publishing.
 */
import { readFile, stat } from "fs/promises";

const API_BASE = "https://api.postfa.st";

function headers() {
  const apiKey = process.env.POSTFA_API_KEY;
  if (!apiKey) throw new Error("POSTFA_API_KEY not set");
  return {
    "pf-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

/**
 * Get connected TikTok account(s).
 * Returns array of { id, platform, platformUsername, displayName }
 */
export async function getTikTokAccounts() {
  const res = await fetch(`${API_BASE}/social-media/my-social-accounts`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`PostFast accounts error ${res.status}: ${await res.text()}`);

  const accounts = await res.json();
  return accounts.filter((a) => a.platform === "TIKTOK");
}

/**
 * Upload a video file to PostFast (via S3 signed URL).
 * Returns the S3 key to use in post creation.
 */
export async function uploadVideo(videoPath) {
  // Step 1: Get signed upload URL
  const urlRes = await fetch(`${API_BASE}/file/get-signed-upload-urls`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      contentType: "video/mp4",
      count: 1,
    }),
  });

  if (!urlRes.ok) throw new Error(`PostFast upload URL error ${urlRes.status}: ${await urlRes.text()}`);

  const [{ key, signedUrl }] = await urlRes.json();

  // Step 2: Upload video to S3 via signed URL
  const videoBuffer = await readFile(videoPath);
  const fileSize = (await stat(videoPath)).size;

  const uploadRes = await fetch(signedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": fileSize.toString(),
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) throw new Error(`S3 upload error ${uploadRes.status}: ${await uploadRes.text()}`);

  return key;
}

/**
 * Schedule a TikTok video post.
 * @param {Object} opts
 * @param {string} opts.socialMediaId - TikTok account UUID from getTikTokAccounts()
 * @param {string} opts.videoKey - S3 key from uploadVideo()
 * @param {string} opts.caption - Video description (max 2200 chars)
 * @param {string} opts.scheduledAt - ISO 8601 timestamp
 * @param {string} [opts.firstComment] - Optional pinned first comment
 * @param {Object} [opts.controls] - TikTok-specific settings
 */
export async function schedulePost(opts) {
  const body = {
    posts: [
      {
        content: opts.caption,
        mediaItems: [
          {
            key: opts.videoKey,
            type: "VIDEO",
            sortOrder: 0,
            coverTimestamp: opts.coverTimestamp || "3",
          },
        ],
        scheduledAt: opts.scheduledAt,
        socialMediaId: opts.socialMediaId,
        ...(opts.firstComment && { firstComment: opts.firstComment }),
      },
    ],
    status: "SCHEDULED",
    approvalStatus: "APPROVED",
    controls: {
      tiktokPrivacy: "PUBLIC",
      tiktokAllowComments: true,
      tiktokAllowDuet: true,
      tiktokAllowStitch: true,
      tiktokAutoAddMusic: false,
      ...(opts.controls || {}),
    },
  };

  const res = await fetch(`${API_BASE}/social-posts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`PostFast schedule error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    postIds: data.postIds,
    scheduledAt: opts.scheduledAt,
  };
}

/**
 * Get analytics for posted videos.
 * @param {string} startDate - ISO date (YYYY-MM-DD)
 * @param {string} endDate - ISO date
 * @param {string[]} [socialMediaIds] - Filter by account IDs
 */
export async function getAnalytics(startDate, endDate, socialMediaIds = []) {
  const params = new URLSearchParams({ startDate, endDate });
  if (socialMediaIds.length > 0) {
    params.set("socialMediaIds", socialMediaIds.join(","));
  }

  const res = await fetch(`${API_BASE}/social-posts/analytics?${params}`, {
    headers: headers(),
  });

  if (!res.ok) throw new Error(`PostFast analytics error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return data.data || [];
}

/**
 * Delete a scheduled post (only works for SCHEDULED or FAILED status).
 */
export async function deletePost(postId) {
  const res = await fetch(`${API_BASE}/social-posts/${postId}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) throw new Error(`PostFast delete error ${res.status}: ${await res.text()}`);
}
