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

    ocr = PaddleOCR(lang='ch', use_angle_cls=False, show_log=False)

    for raw in sys.stdin:
        path = raw.strip()
        if not path:
            continue
        try:
            result = ocr.ocr(path)
        except Exception as e:
            print(json.dumps({"frame_path": path, "text": "", "confidence": 0.0, "boxes": 0, "error": str(e)}), flush=True)
            continue

        texts = []
        confs = []
        if result and result[0]:
            for line in result[0]:
                if not line or len(line) < 2:
                    continue
                bbox, (txt, conf) = line[0], line[1]
                texts.append(txt)
                confs.append(float(conf))

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
