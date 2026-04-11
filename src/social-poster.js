/**
 * Unified Social Poster — routes to PostFast or PostForMe based on config.
 *
 * Each page in config.mjs has a `provider` field:
 *   - "postfast"  → uses src/postfast.js (legacy, until 29/4/2026)
 *   - "postforme" → uses src/postforme.js (new, unlimited accounts)
 *
 * Usage:
 *   import { createPoster } from "./social-poster.js";
 *   const poster = createPoster(PAGE);  // reads PAGE.provider
 *   const mediaRef = await poster.upload(videoPath);
 *   const result = await poster.schedule({ mediaRef, caption, scheduledAt, platform: "facebook" });
 */
import { readFile, stat } from "fs/promises";

// Lazy imports to avoid loading unused modules
let _postfast, _postforme;

async function getPostFast() {
  if (!_postfast) _postfast = await import("./postfast.js");
  return _postfast;
}

async function getPostForMe() {
  if (!_postforme) _postforme = await import("./postforme.js");
  return _postforme;
}

/**
 * Create a poster instance for a page config.
 *
 * @param {Object} pageConfig — from PAGES in config.mjs
 * @param {string} pageConfig.provider — "postfast" or "postforme"
 * @param {string} [pageConfig.fbId] — PostFast Facebook UUID
 * @param {string} [pageConfig.pfmId] — PostForMe account ID
 * @param {string} [pageConfig.ttId] — PostFast TikTok UUID
 * @param {string} [pageConfig.pfmTtId] — PostForMe TikTok account ID
 * @returns {SocialPoster}
 */
export function createPoster(pageConfig) {
  return new SocialPoster(pageConfig);
}

class SocialPoster {
  constructor(config) {
    this.provider = config.provider || "postfast";
    this.fbId = config.fbId || null;       // PostFast FB UUID
    this.pfmId = config.pfmId || null;     // PostForMe FB account ID
    this.ttId = config.ttId || null;       // PostFast TT UUID
    this.pfmTtId = config.pfmTtId || null; // PostForMe TT account ID
  }

  /**
   * Upload video. Returns a media reference (format depends on provider).
   * PostFast: S3 key string
   * PostForMe: public media URL string
   */
  async upload(videoPath) {
    if (this.provider === "postforme") {
      const pfm = await getPostForMe();
      return pfm.uploadVideo(videoPath);
    }
    const pf = await getPostFast();
    return pf.uploadVideo(videoPath);
  }

  /**
   * Schedule a post to Facebook.
   *
   * @param {Object} opts
   * @param {string} opts.mediaRef — from upload() (S3 key or media URL)
   * @param {string} opts.caption — Post text
   * @param {string} opts.scheduledAt — ISO 8601 timestamp
   * @param {string} [opts.firstComment] — Optional affiliate link comment
   * @returns {Promise<{postId: string}>}
   */
  async scheduleFacebook(opts) {
    if (this.provider === "postforme") {
      const pfm = await getPostForMe();
      return pfm.schedulePost({
        socialAccountIds: this.pfmId,
        mediaUrl: opts.mediaRef,
        caption: opts.caption,
        scheduledAt: opts.scheduledAt,
        platform: "facebook",
      });
    }

    // PostFast
    const pf = await getPostFast();
    return pf.schedulePost({
      socialMediaId: this.fbId,
      videoKey: opts.mediaRef,
      caption: opts.caption,
      scheduledAt: opts.scheduledAt,
      firstComment: opts.firstComment,
      controls: { facebookContentType: "REEL" },
    });
  }

  /**
   * Schedule a post to TikTok.
   */
  async scheduleTikTok(opts) {
    const ttAccountId = this.provider === "postforme" ? this.pfmTtId : this.ttId;
    if (!ttAccountId) return null; // No TikTok account configured

    if (this.provider === "postforme") {
      const pfm = await getPostForMe();
      return pfm.schedulePost({
        socialAccountIds: ttAccountId,
        mediaUrl: opts.mediaRef,
        caption: opts.caption,
        scheduledAt: opts.scheduledAt,
        platform: "tiktok",
      });
    }

    const pf = await getPostFast();
    return pf.schedulePost({
      socialMediaId: ttAccountId,
      videoKey: opts.mediaRef,
      caption: opts.caption,
      scheduledAt: opts.scheduledAt,
      controls: {
        tiktokPrivacy: "PUBLIC",
        tiktokAllowComments: true,
        tiktokAllowDuet: true,
        tiktokAllowStitch: true,
      },
    });
  }

  /**
   * Get the Facebook account ID for this page (provider-agnostic).
   */
  getFacebookId() {
    return this.provider === "postforme" ? this.pfmId : this.fbId;
  }

  /**
   * Get the TikTok account ID for this page (provider-agnostic).
   */
  getTikTokId() {
    return this.provider === "postforme" ? this.pfmTtId : this.ttId;
  }

  /**
   * Post an affiliate comment on a Facebook post.
   * Only supported on PostFast. PostForMe doesn't have this endpoint.
   */
  async postComment(postId, commentText) {
    if (this.provider === "postforme") {
      // PostForMe: no comment API — skip silently
      return null;
    }
    const key = process.env.POSTFA_API_KEY || process.env.POSTFAST_API_KEY;
    if (!key) return null;

    const res = await fetch(`https://api.postfa.st/social-posts/${postId}/comments`, {
      method: "POST",
      headers: { "pf-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ content: commentText }),
    });
    if (!res.ok) return null;
    return res.json();
  }
}

export default SocialPoster;
