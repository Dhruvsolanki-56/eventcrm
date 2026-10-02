"""Generate privacy-safe synthetic business-card images for OCR evaluation.

The images and contact details are fictional. Output defaults below the ignored
data/ directory; an existing output directory is never overwritten.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps


FIRST_NAMES = [
    "Aarav", "Aisha", "Amara", "Amir", "Anika", "Arjun", "Avery", "Camila", "Chen", "Dalia",
    "Daniel", "Elena", "Eli", "Fatima", "Harper", "Hiro", "Iris", "Jamal", "Jin", "Jordan",
    "Kai", "Leila", "Leo", "Liam", "Lucia", "Maya", "Mina", "Noah", "Nora", "Omar", "Priya",
    "Ravi", "Rosa", "Sam", "Sana", "Sofia", "Theo", "Yuki", "Zara", "Zoe",
]
LAST_NAMES = [
    "Alvarez", "Bennett", "Brooks", "Chen", "Cohen", "Desai", "Ellis", "Foster", "Garcia", "Gupta",
    "Haddad", "Hassan", "Ito", "Johnson", "Kim", "Khan", "Lee", "Martin", "Miller", "Nguyen",
    "Olsen", "Park", "Patel", "Reed", "Rivera", "Rossi", "Shah", "Singh", "Tanaka", "Thompson",
    "Walker", "Wang", "White", "Williams", "Wilson", "Yamamoto", "Young", "Zhang", "Zimmerman",
]
COMPANY_A = [
    "Alder", "Amber", "Atlas", "Aurora", "Beacon", "Bluebird", "Brightline", "Cedar", "Cinder", "Cobalt",
    "Copper", "Crest", "Evergreen", "Fieldstone", "Foxglove", "Granite", "Harbor", "Ironwood", "Juniper", "Lighthouse",
    "Maple", "Meridian", "Northstar", "Oak", "Orchid", "Pioneer", "Redwood", "Silverline", "Summit", "Willow",
]
COMPANY_B = [
    "Analytics", "Automation", "Brands", "Commerce", "Creative", "Design", "Dynamics", "Engineering", "Foods", "Freight",
    "Health", "Industries", "Labs", "Logistics", "Materials", "Media", "Networks", "Packaging", "Partners", "Products",
    "Research", "Retail", "Services", "Software", "Solutions", "Systems", "Technologies", "Textiles", "Trading", "Works",
]
TITLES = [
    "Account Executive", "Business Development Lead", "Chief Operating Officer", "Customer Success Manager",
    "Design Engineer", "Director of Operations", "Event Partnerships Manager", "Founder and CEO", "Global Sales Director",
    "Marketing Specialist", "Operations Manager", "Product Designer", "Regional Sales Manager", "Senior Buyer",
    "Strategic Accounts Lead", "VP of Sales",
]
SUFFIXES = ["", "", "", " Inc.", " LLC", " Ltd.", " Group", " Partners", " Studio", " Technologies", " Systems"]
LAYOUTS = ["classic", "brand-first", "reversed", "split-columns", "contact-first", "company-footer"]
PALETTES = [
    ((250, 249, 246), (28, 38, 54), (40, 91, 140)),
    ((248, 250, 252), (20, 34, 47), (12, 119, 112)),
    ((250, 247, 243), (50, 41, 35), (177, 91, 51)),
    ((244, 246, 241), (28, 43, 37), (93, 122, 66)),
    ((250, 248, 252), (42, 35, 58), (109, 78, 146)),
    ((246, 249, 250), (33, 44, 52), (45, 116, 137)),
]
FONT_CANDIDATES = [
    Path(r"C:\Windows\Fonts\arial.ttf"), Path(r"C:\Windows\Fonts\calibri.ttf"),
    Path(r"C:\Windows\Fonts\segoeui.ttf"), Path(r"C:\Windows\Fonts\verdana.ttf"),
    Path(r"C:\Windows\Fonts\georgia.ttf"), Path(r"C:\Windows\Fonts\tahoma.ttf"),
]


def font(path: Path | None, size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if path:
        candidate = path
        if bold:
            bold_candidate = path.with_name(path.stem + "bd" + path.suffix)
            if bold_candidate.exists():
                candidate = bold_candidate
        try:
            return ImageFont.truetype(str(candidate), size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def fit_font(draw: ImageDraw.ImageDraw, text: str, path: Path | None, start: int, minimum: int, max_width: int, bold: bool = False):
    size = start
    while size > minimum:
        current = font(path, size, bold)
        if draw.textbbox((0, 0), text, font=current)[2] <= max_width:
            return current
        size -= 1
    return font(path, minimum, bold)


def company_for(rng: random.Random) -> str:
    base = f"{rng.choice(COMPANY_A)} {rng.choice(COMPANY_B)}"
    suffix = rng.choice(SUFFIXES)
    company = base + suffix
    if rng.random() < 0.34:
        company = company.upper()
    return company


def email_and_domain(first: str, last: str, company: str, rng: random.Random) -> tuple[str, str, str]:
    words = [part.lower() for part in COMPANY_A + COMPANY_B if part.lower() in company.lower()]
    domain_root = "".join(ch.lower() for ch in company if ch.isalnum())
    domain_root = (domain_root[:24] or "exampleco")
    domain = f"{domain_root}.example"
    if rng.random() < 0.78:
        local = f"{first.lower()}.{last.lower()}"
    else:
        local = rng.choice(["hello", "contact", "sales", "info"])
    email = f"{local}@{domain}"
    website = f"www.{domain}"
    del words
    return email, website, domain_root


def card_record(index: int, rng: random.Random) -> dict:
    first = rng.choice(FIRST_NAMES)
    last = rng.choice(LAST_NAMES)
    company = company_for(rng)
    title = rng.choice(TITLES)
    email, website, domain_root = email_and_domain(first, last, company, rng)
    phone = f"+1 ({rng.choice([206, 312, 415, 503, 617, 702, 919])}) 555-{rng.randrange(1000, 10000):04d}"
    return {
        "id": f"card-{index:05d}", "split": "test" if index % 5 == 0 else "train",
        "layout": LAYOUTS[index % len(LAYOUTS)], "name": f"{first} {last}", "title": title,
        "company": company, "email": email, "phone": phone, "website": website,
        "domainRoot": domain_root,
    }


def draw_card(record: dict, rng: random.Random, font_paths: list[Path], index: int) -> Image.Image:
    width, height = 1050, 650
    background, ink, accent = PALETTES[index % len(PALETTES)]
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    margin = rng.choice([54, 64, 76])
    font_path = rng.choice(font_paths) if font_paths else None
    layout = record["layout"]
    draw.rounded_rectangle((22, 22, width - 23, height - 23), radius=20, outline=(223, 224, 220), width=2)
    draw.rounded_rectangle((margin, margin + 2, margin + 58, margin + 60), radius=17, fill=accent)
    draw.text((margin + 15, margin + 12), record["company"][:1], font=font(font_path, 30, True), fill=(255, 255, 255))

    name_font = fit_font(draw, record["name"], font_path, 52, 38, 740, True)
    title_font = fit_font(draw, record["title"], font_path, 29, 23, 820)
    company_font = fit_font(draw, record["company"], font_path, 31, 23, 850, True)
    contact_font = font(font_path, 25)
    contact_lines = [record["email"], record["phone"], record["website"]]

    if layout == "classic":
        draw.text((margin + 82, margin + 7), record["company"], font=company_font, fill=ink)
        draw.text((margin, 190), record["name"], font=name_font, fill=ink)
        draw.text((margin + 2, 261), record["title"], font=title_font, fill=(96, 101, 104))
        draw.line((margin, 324, width - margin, 324), fill=(219, 221, 219), width=2)
        for line_no, value in enumerate(contact_lines):
            draw.text((margin, 358 + line_no * 49), value, font=contact_font, fill=ink)
    elif layout == "brand-first":
        draw.text((margin + 85, margin + 1), record["company"], font=company_font, fill=ink)
        draw.text((margin, 205), record["name"], font=name_font, fill=ink)
        draw.text((margin + 2, 276), record["title"], font=title_font, fill=(91, 97, 99))
        for line_no, value in enumerate(contact_lines):
            draw.text((margin, 364 + line_no * 48), value, font=contact_font, fill=ink)
    elif layout == "reversed":
        draw.text((margin, 122), record["title"], font=title_font, fill=(96, 101, 104))
        draw.text((margin, 177), record["name"], font=name_font, fill=ink)
        draw.text((margin, 262), record["company"], font=company_font, fill=ink)
        for line_no, value in enumerate(contact_lines):
            draw.text((margin, 336 + line_no * 49), value, font=contact_font, fill=ink)
    elif layout == "split-columns":
        draw.text((margin + 85, margin + 4), record["company"], font=company_font, fill=ink)
        draw.text((margin, 210), record["name"], font=name_font, fill=ink)
        draw.text((margin + 2, 280), record["title"], font=title_font, fill=(96, 101, 104))
        draw.line((530, 180, 530, 540), fill=(219, 221, 219), width=2)
        for line_no, value in enumerate(contact_lines):
            draw.text((572, 212 + line_no * 62), value, font=contact_font, fill=ink)
    elif layout == "contact-first":
        draw.text((margin, 135), record["company"], font=company_font, fill=ink)
        for line_no, value in enumerate(contact_lines):
            draw.text((margin, 201 + line_no * 43), value, font=font(font_path, 23), fill=(69, 74, 78))
        draw.text((margin, 379), record["name"], font=name_font, fill=ink)
        draw.text((margin + 2, 451), record["title"], font=title_font, fill=(96, 101, 104))
    else:
        draw.text((margin, 134), record["name"], font=name_font, fill=ink)
        draw.text((margin + 2, 205), record["title"], font=title_font, fill=(96, 101, 104))
        for line_no, value in enumerate(contact_lines[:2]):
            draw.text((margin, 280 + line_no * 48), value, font=contact_font, fill=ink)
        draw.rounded_rectangle((margin - 8, 438, width - margin + 8, 535), radius=8, fill=accent)
        draw.text((margin + 12, 463), record["company"], font=company_font, fill=(255, 255, 255))
        draw.text((width - margin - 290, 472), record["website"], font=font(font_path, 22), fill=(255, 255, 255))

    # A minority of cards simulate ordinary phone-camera softness, glare, and skew.
    if index % 13 == 0:
        image = image.filter(ImageFilter.GaussianBlur(radius=0.55))
    if index % 17 == 0:
        overlay = Image.new("RGBA", image.size, (255, 255, 255, 0))
        odraw = ImageDraw.Draw(overlay)
        odraw.polygon([(650, 20), (970, 20), (610, 630), (430, 630)], fill=(255, 255, 255, 24))
        image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    if index % 19 == 0:
        image = image.rotate(rng.choice([-1.5, -1, 1, 1.5]), resample=Image.Resampling.BICUBIC, fillcolor=background)
    if index % 23 == 0:
        image = ImageEnhance.Contrast(image).enhance(0.82)
    return image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=1200)
    parser.add_argument("--seed", type=int, default=20260930)
    parser.add_argument("--output", type=Path, default=Path("data/ocr-benchmark"))
    parser.add_argument("--invert", action="store_true", help="Invert rendered card colors to benchmark contrast-sensitive OCR.")
    args = parser.parse_args()
    if args.count < 1000:
        raise SystemExit("Generate at least 1,000 samples so the benchmark includes a useful held-out set.")
    if args.output.exists():
        raise SystemExit(f"Refusing to overwrite existing data: {args.output.resolve()}")
    args.output.mkdir(parents=True)
    font_paths = [candidate for candidate in FONT_CANDIDATES if candidate.exists()]
    rng = random.Random(args.seed)
    manifest_path = args.output / "manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as manifest:
        for index in range(args.count):
            record = card_record(index, rng)
            image = draw_card(record, rng, font_paths, index)
            if args.invert:
                image = ImageOps.invert(image)
            image.save(args.output / f"{record['id']}.png", optimize=True)
            manifest.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(json.dumps({"output": str(args.output.resolve()), "count": args.count, "seed": args.seed, "test_count": args.count // 5, "synthetic": True, "inverted": args.invert}))


if __name__ == "__main__":
    main()
