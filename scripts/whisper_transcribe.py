"""
faster-whisper transcription with accurate (forced-aligned) timestamps.

Used as the PRIMARY subtitle source for Douyin anime clips, replacing
Gemini ASR whose timestamps are estimates. Whisper aligns text to audio
via attention, giving subtitle timing that matches when lines are spoken.

Usage:
  python scripts/whisper_transcribe.py <audio_path> [--lang zh] [--model large-v3]

Output (stdout): one JSON object:
  {"segments": [{"start": 9.8, "end": 14.0, "text": "..."}], "language": "zh"}
"""
import sys
import json
import argparse

# Windows Python defaults stdout to cp1252, which cannot encode Chinese text;
# print(json.dumps(..., ensure_ascii=False)) would crash with UnicodeEncodeError.
# Force UTF-8 so the JSON (with Chinese) writes cleanly.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--model", default="large-v3")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(json.dumps({"error": f"faster-whisper not installed: {e}"}), flush=True)
        sys.exit(2)

    # int8 on CPU: ~0.4x realtime, good Chinese accuracy. GPU users can bump
    # compute_type to float16 by editing here.
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    # vad_filter skips long music-only stretches (these clips have continuous
    # BGM with sparse dialogue), so we don't get hallucinated cues over music.
    segments, info = model.transcribe(
        args.audio,
        language=args.lang,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 600},
        condition_on_previous_text=False,  # avoid drift/repetition over long audio
    )

    out = []
    for s in segments:
        text = (s.text or "").strip()
        if not text:
            continue
        out.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": text})

    print(json.dumps({"segments": out, "language": info.language}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
