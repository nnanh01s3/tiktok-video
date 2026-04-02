# TikTok Automated Channel System — Design Spec

**Date**: 2026-03-25
**Status**: Draft
**Owner**: nnanh01

## 1. Overview

Build a fully automated TikTok content creation and monetization system using OpenClaw + Genviral Skill. The system runs 24/7 on a VPS, managing 3 niche channels with a closed-loop analytics feedback mechanism.

### Goals

- **Revenue target**: Minimum $1K, target $3K, stretch $5K/month by month 6
- **Automation level**: Full auto (<1 hour/week dashboard review)
- **Channels**: 3 niches (Motivation/Quotes, Dark Psychology/Facts, AI Storytelling)
- **Monetization**: Full stack (Creator Rewards + Affiliate + Brand Deals)

### Non-Goals

- Manual content creation or daily involvement
- Multi-platform distribution in Phase 1 (Reels/Shorts come later)
- Building custom video generation models

## 2. Architecture

### Single Agent, Phased Rollout

One OpenClaw agent manages all 3 channels, deployed in phases to reduce risk.

```
┌─────────────────────────────────────────────────────┐
│                  OpenClaw Agent "TikTokBot"          │
│                  (runs on VPS 24/7)                  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐  │
│  │ Scheduler│──▶│Content Engine│──▶│  Publisher  │  │
│  │ (Cron)   │   │              │   │ (Genviral)  │  │
│  └──────────┘   └──────────────┘   └────────────┘  │
│       │              │                    │         │
│       │         ┌────┴─────┐              │         │
│       │         │ 3 Niche  │              │         │
│       │         │ Pipelines│              │         │
│       │         └──────────┘              │         │
│       │                                   ▼         │
│       │         ┌──────────────────────────┐        │
│       └────────◀│   Analytics Feedback     │        │
│                 │   Loop (daily)           │        │
│                 └──────────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

### Core Components

1. **Scheduler**: Cron-based triggers for content creation. Posts 2–3 videos/day/channel with random jitter (±30 min) to avoid pattern detection.
2. **Content Engine**: Selects niche pipeline, generates script, renders video. Each niche has its own pipeline with different tools and content formulas.
3. **Publisher**: Genviral API (42 commands) handles upload, scheduling, posting to TikTok with optimized captions and hashtags.
4. **Analytics Feedback Loop**: Daily cycle — pull metrics at 06:00, analyze patterns at 06:15, adjust content plan at 06:30, generate report at 07:00.
5. **State Store**: SQLite database (local to VPS) tracks all jobs. Each content job has states: `pending → rendering → rendered → uploading → posted → analyzed`. On agent restart, the agent resumes from the last known state — re-renders if crashed during render, re-uploads if crashed during upload. Duplicate detection uses video content hash + timestamp to prevent double-posting.

### State Recovery & Idempotency

The agent persists all job state to SQLite before each pipeline step. On crash/restart:
- **Crash during render**: Job stays in `rendering` state → agent re-renders from script
- **Crash during upload**: Job stays in `rendered` state → agent re-uploads existing video file
- **Crash during post**: Job stays in `uploading` state → agent checks Genviral API for recent posts to detect duplicates before retrying
- **VPS reboot**: Agent auto-starts via systemd, reads SQLite for pending/in-progress jobs, resumes pipeline

## 3. Niche Pipelines

### Pipeline A — Motivation/Quotes (Phase 1)

**Content formula**: Quote + aesthetic background + AI voice + trending sound
**Video length**: 60–90 seconds (required for Creator Rewards eligibility). Each video presents 3–5 related quotes with transitions, creating a "quote compilation" format rather than single-quote clips.

| Step | Tool/API | Description |
|---|---|---|
| Trending Research | Genviral Analytics API | Scan trending sounds, hashtags in motivation niche |
| Quote Selection | Claude/GPT API | Curate from quote DB + generate originals based on trends |
| Visual Design | Genviral Slideshow API | Aesthetic slideshow with typography |
| Voiceover | ElevenLabs API | Deep, inspirational AI voice |
| Render | Genviral | Combine visual + audio + trending sound |
| Post | Genviral Publisher | Auto-post with optimized caption + hashtags |

**Volume**: 3 videos/day (morning, noon, evening — peak engagement hours)
**Production time per video**: ~2–5 min (automated)

### Pipeline B — Dark Psychology/Facts (Phase 2)

**Content formula**: Shocking hook → psychology insight → "follow for more"
**Video length**: 60–90 seconds (required for Creator Rewards eligibility). Each video covers 2–3 related psychology facts with a narrative arc.

| Step | Tool/API | Description |
|---|---|---|
| Topic Research | Claude API + curated source list | Generate topics from curated psychology book summaries, Wikipedia psychology articles, and trending TikTok hashtags in the niche. No web scraping or Reddit API — LLM generates original facts/insights from its training knowledge, validated against a curated fact database (JSON file of verified psychology concepts, updated monthly). |
| Script Writing | Claude API | Hook-heavy scripts (3–5 second hook → deliver value) |
| Visual Assets | Genviral + Stock imagery | Dramatic slideshow with text overlays |
| Voiceover | ElevenLabs API | Deep, mysterious voice |
| Edit | Genviral | Combine all, auto-add captions |
| Post | Genviral Publisher | Post with engagement-bait caption |

**Volume**: 2–3 videos/day
**Production time per video**: ~3–8 min (automated)

### Pipeline C — AI Storytelling (Phase 3)

**Content formula**: Mini movie 60–90s, cliffhanger ending → "Part 2?"

| Step | Tool/API | Description |
|---|---|---|
| Story Concept | Claude API + trending analysis | Generate story ideas from viral patterns |
| Script | Claude API | 60–90 second script: hook → tension → payoff |
| AI Animation | Kling/Pika API | Generate animation scenes from script |
| Voiceover | ElevenLabs (character voices) | Narrator + character voices |
| SFX/Music | Suno/Stock audio | Background music + sound effects |
| Edit | FFmpeg + custom OpenClaw skill | Combine scenes, sync audio, add captions |
| Post | Genviral Publisher | Post with story-teaser caption |

**Volume**: 1–2 videos/day (more production-intensive)
**Production time per video**: ~10–20 min (automated)

## 4. Analytics Feedback Loop

### Daily Cycle (06:00–07:00 UTC)

1. **06:00** — Pull yesterday's metrics (views, likes, shares, watch time, completion rate)
2. **06:15** — Analyze patterns (top hooks, best posting times, winning visual styles, effective sounds)
3. **06:30** — Adjust today's content plan (double down on what works, drop underperformers, A/B test new variations)
4. **07:00** — Generate daily report (optional: send to Telegram bot)

### Key Metrics per Video

| Metric | Target | Action if Below Target |
|---|---|---|
| Hook Rate (% past 3s) | >70% | Analyze and change opening formula |
| Completion Rate | >40% | Shorten video or improve pacing |
| Engagement Rate | >5% | Add stronger CTA, more relatable content |
| Follower Conversion | >1% | Improve profile bio, pin best videos |

### Optimization Strategy (agent auto-executes)

- Videos with Completion Rate >60% → create more variations
- Videos with Hook Rate <50% → change hook formula
- Identify best posting windows → shift schedule
- Track which sounds/hashtags correlate with performance → prioritize them

## 5. Monetization Engine

### Revenue Phasing

| Phase | Timeline | Revenue Sources | Estimated Monthly |
|---|---|---|---|
| Phase 1 | Month 1–2 | None (building audience) | $0 |
| Phase 2 | Month 2–4 | Affiliate Marketing (TikTok Shop) | $200–800 |
| Phase 3 | Month 4–6 | + Creator Rewards Program | $700–2,000 |
| Phase 4 | Month 6+ | + Brand Deals (inbound) | $1,000–5,000+ |

### Creator Rewards Eligibility

Creator Rewards requires **10,000 followers** and videos **over 1 minute long**. To ensure eligibility:
- All pipelines target 60–90 second video length (see Section 3)
- Quotes pipeline uses "compilation" format (3–5 quotes per video) to reach 60s+
- Psychology pipeline uses narrative arc format (2–3 facts per video) to reach 60s+
- AI Storytelling naturally targets 60–90 seconds
- Follower growth target: 10K across all channels by month 3–4 (combined or per-channel)

### Affiliate Strategy (auto-managed by agent)

**Product matching per niche:**
- Quotes → self-help books, journals, planners, meditation apps
- Dark Psychology → psychology books, online courses, productivity tools
- AI Stories → AI tools, creative software, tech gadgets

**Agent behaviors:**
- Match products with niche from a curated product database
- Rotate affiliate links to A/B test conversion rates
- Track commission per product → prioritize high-converting items
- Auto-insert relevant product links in video descriptions

### Brand Deal Readiness (Month 4+)

- Agent auto-generates media kit from analytics data (stored locally, not auto-sent)
- Niche-specific rate cards based on engagement metrics
- **DM handling is MANUAL** — automated DM responses are high ban risk on TikTok. Agent sends Telegram notification when new DMs are detected. Owner responds manually with pre-prepared rate card templates.

## 6. Deployment Phases

### Phase 1: Quotes Channel (Week 1–2)

**Objective**: Validate the full pipeline end-to-end.

- Set up OpenClaw agent on VPS
- Install and configure Genviral Skill
- Connect TikTok account for Quotes channel
- Configure Pipeline A (Quotes)
- Set up Scheduler: 3 posts/day with jitter
- Set up Analytics Feedback Loop
- Set up monitoring (health checks, Telegram alerts)
- Run for 2 weeks, analyze results

**Success criteria**: Pipeline runs without manual intervention for 14 days, >50% videos get 500+ views.

### Phase 2: + Dark Psychology Channel (Week 3–4)

**Objective**: Add second niche, validate multi-channel management.

- Create/connect TikTok account for Dark Psychology
- Configure Pipeline B
- Add to existing Scheduler
- Verify analytics tracks both channels correctly
- Run for 2 weeks

**Success criteria**: Both channels run stable, Dark Psychology engagement rate >5%.

### Phase 3: + AI Storytelling Channel (Month 2+)

**Objective**: Add premium niche with highest revenue potential.

- Create/connect TikTok account for AI Storytelling
- Configure Pipeline C (includes Kling/Pika integration)
- Set up FFmpeg custom skill for video editing
- Add to Scheduler (lower frequency: 1–2/day)
- Run and optimize

**Success criteria**: AI Storytelling videos average >2K views, average completion rate >40%, and pipeline runs stable for 2 weeks without manual intervention.

## 7. Cost Estimates

### Monthly Operating Costs

| Item | Phase 1 | Phase 2 | Full System |
|---|---|---|---|
| VPS (24/7 agent) | $20–30 | $20–30 | $30–40 |
| Genviral API | $22 | $22 | $22 |
| ElevenLabs (TTS) | $11 | $11 | $22 |
| LLM API (Claude/GPT) | $5–10 | $10–20 | $20–30 |
| Kling/Pika (animation) | — | — | $30–50 |
| Residential proxies (3x) | $5–10 | $10–20 | $15–30 |
| Anti-detect browser | $0–10 | $0–10 | $0–10 |
| **Total** | **$63–93** | **$73–113** | **$139–204** |

**Break-even**: ~Month 3–4 when affiliate revenue covers operating costs.

## 8. Risk Mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Multi-account same-IP detection** | **High** | **Each TikTok account uses a dedicated residential proxy (e.g., Bright Data, Smartproxy ~$5-10/mo per proxy). Each account has a unique browser fingerprint via anti-detect browser profile (GoLogin/AdsPower). Accounts never interact with each other (no follows, no comments). Staggered login patterns.** |
| TikTok account ban (spam detection) | Medium | Rate limit: max 3 videos/day/channel, random jitter ±30 min, vary content styles and formats |
| Low content quality → low engagement | Medium | Analytics feedback loop auto-drops underperforming formats, continuous A/B testing |
| API costs exceed budget | Low | Hard spending caps per API, fallback to free alternatives (Coqui TTS instead of ElevenLabs) |
| Copyright strikes | Low–Medium | Agent checks content originality, royalty-free media only, no copyrighted music/images |
| TikTok policy changes | Low | Multi-platform posting (Reels, Shorts) via Genviral as backup |
| Agent crash/downtime | Low | Health check cron job every 5 min, auto-restart via systemd, Telegram alert when down. SQLite state store ensures job recovery (see Section 2). |
| **Account ban recovery** | Low–Medium | **Maintain 1 backup TikTok account per niche (warmed up with occasional manual posts). If primary account is banned: (1) appeal via TikTok support, (2) switch pipeline to backup account within 24 hours, (3) post-mortem analysis to identify ban trigger, (4) adjust anti-detection settings.** |

## 9. Content Safety Rules

Built into the agent's configuration:

- **No copyrighted material**: Only royalty-free music, images, and original/attributed quotes
- **No misinformation**: Facts must be verifiable, psychology content based on actual research
- **No hate speech or harmful content**: Comply with TikTok Community Guidelines
- **Rate limiting**: Max 3 posts/day/account, random 2–4 hour gaps between posts
- **Human review trigger**: If analytics detect abnormal spikes (positive or negative) → flag for manual review
- **Anti-detection**: Random posting jitter, varied caption lengths, mixed content formats (slideshow/video/image)

## 10. Tech Stack Summary

| Component | Technology |
|---|---|
| Agent Framework | OpenClaw (local-first, extensible) |
| Content Publishing | Genviral Skill (42 API commands) |
| Text-to-Speech | ElevenLabs API |
| LLM (scripts, analysis) | Claude API / GPT API |
| AI Animation | Kling / Pika API |
| Video Editing | FFmpeg (via custom OpenClaw skill) |
| Audio/Music | Suno / Stock audio libraries |
| Hosting | VPS (Ubuntu, 4+ vCPU, 8GB+ RAM, 100GB SSD, unmetered bandwidth) |
| State Store | SQLite (local to VPS) |
| Anti-Detection | Residential proxies + GoLogin/AdsPower browser profiles |
| Monitoring | Cron health checks + Telegram Bot alerts |
| Analytics | Genviral Analytics API + custom dashboards |

## 11. Success Metrics (6-month targets)

| Metric | Target |
|---|---|
| Total followers (3 channels) | 50K–100K |
| Monthly revenue | Min $1K, target $3K, stretch $5K |
| Videos produced/month | ~210 (Pipeline A: 90 + B: 75 + C: 45) |
| System uptime | >99% |
| Average engagement rate | >5% |
| Human time spent/week | <1 hour (dashboard review only) |
