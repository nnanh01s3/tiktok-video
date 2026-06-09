"""
Stdin/stdout PaddleOCR batch runner.

Usage:
  echo "path/to/frame1.jpg\npath/to/frame2.jpg" | python scripts/paddle_ocr_batch.py

For each input line (frame path), prints ONE JSON line to stdout:
  {"frame_path": str, "text": str, "confidence": float, "boxes": int}
"""
import sys
import json

def main():
    try:
        from paddleocr import PaddleOCR
    except ImportError as e:
        print(json.dumps({"error": f"paddleocr not installed: {e}"}), flush=True)
        sys.exit(2)

    # Newer paddleocr (3.x) removed show_log and use_angle_cls.
    # Try modern API first, fall back to old API for back-compat.
    import logging
    logging.getLogger("ppocr").setLevel(logging.ERROR)
    try:
        ocr = PaddleOCR(lang='ch')
    except (TypeError, ValueError):
        ocr = PaddleOCR(lang='ch', use_angle_cls=False)

    for raw in sys.stdin:
        path = raw.strip()
        if not path:
            continue
        try:
            # paddleocr 3.x renamed .ocr() → .predict(); keep both for compat
            if hasattr(ocr, 'predict'):
                result = ocr.predict(path)
            else:
                result = ocr.ocr(path)
        except Exception as e:
            print(json.dumps({"frame_path": path, "text": "", "confidence": 0.0, "boxes": 0, "error": str(e)}), flush=True)
            continue

        texts = []
        confs = []
        if result and len(result) > 0:
            first = result[0]
            # paddleocr 3.x: dict with rec_texts / rec_scores
            if isinstance(first, dict):
                rec_texts = first.get('rec_texts', []) or []
                rec_scores = first.get('rec_scores', []) or []
                for i, txt in enumerate(rec_texts):
                    conf = float(rec_scores[i]) if i < len(rec_scores) else 0.0
                    texts.append(txt)
                    confs.append(conf)
            # paddleocr 2.x: list of [bbox, (text, conf)] entries
            elif isinstance(first, list):
                for line in first:
                    if not line or len(line) < 2:
                        continue
                    try:
                        bbox, payload = line[0], line[1]
                        if isinstance(payload, (list, tuple)) and len(payload) >= 2:
                            txt, conf = payload[0], payload[1]
                            texts.append(txt)
                            confs.append(float(conf))
                    except Exception:
                        continue

        merged = " ".join(texts).strip()
        avg_conf = (sum(confs) / len(confs)) if confs else 0.0
        print(json.dumps({
            "frame_path": path,
            "text": merged,
            "confidence": round(avg_conf, 3),
            "boxes": len(texts),
        }, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
