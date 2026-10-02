"""Build a small, labeled footer crop set from the fictional OCR benchmark."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, nargs="?", default=Path("data/ocr-benchmark"))
    parser.add_argument("--output", type=Path, default=Path("data/ocr-company-footer-crops"))
    parser.add_argument("--split", default="test")
    parser.add_argument("--layout", default="company-footer", help="Use a named layout or 'all'.")
    parser.add_argument("--id", dest="record_id")
    parser.add_argument("--invert", action="store_true")
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f"Refusing to overwrite existing data: {args.output.resolve()}")
    records = [
        json.loads(line)
        for line in (args.source / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    records = [item for item in records if (args.layout == "all" or item["layout"] == args.layout) and (args.record_id or item["split"] == args.split)]
    if args.record_id:
        records = [item for item in records if item["id"] == args.record_id]
    if not records:
        raise SystemExit("No matching records were found.")
    args.output.mkdir(parents=True)
    with (args.output / "manifest.jsonl").open("w", encoding="utf-8") as manifest:
        for item in records:
            image = Image.open(args.source / f"{item['id']}.png").convert("RGB")
            width, height = image.size
            # This crop isolates the designed footer band (65%-88% of card height).
            image = image.crop((0, round(height * 0.65), width, round(height * 0.88)))
            if args.invert:
                image = Image.eval(image, lambda channel: 255 - channel)
            image.save(args.output / f"{item['id']}.png", optimize=True)
            manifest.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(json.dumps({"output": str(args.output.resolve()), "count": len(records), "split": args.split, "layout": args.layout, "inverted": args.invert, "synthetic": True}))


if __name__ == "__main__":
    main()
