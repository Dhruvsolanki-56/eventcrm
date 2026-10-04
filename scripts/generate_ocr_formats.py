"""Generate synthetic business cards in many different formats and layouts.

The main benchmark (generate_ocr_benchmark.py) uses one card size and six similar layouts. This set stretches the
reader: portrait cards, dark backgrounds, centered text, labeled phone/email lines, addresses and taglines, Indian
formats, names in capitals, accents and hyphens, and phone-photo distortions. Everything is fictional. It writes the
same manifest as the main benchmark, so `npm run benchmark:ocr -- data/ocr-formats` can score it.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

import generate_ocr_benchmark as base

FORMATS = [
    "portrait", "dark", "centered", "minimal", "labeled-contact", "caps-name", "india", "address-tagline",
    "complex-names", "phone-photo", "low-res", "two-phones",
]
# Where the company sits on the card. The reader must not depend on the company being at the top.
POSITIONS = [
    "company-top-right", "company-middle", "company-bottom", "company-below-title", "company-sidebar",
    "company-big-name-small", "company-vertical-band", "company-footer-bar", "company-two-line", "company-corner-logo",
]
INDIAN_FIRST = ["Aarav", "Aditya", "Ananya", "Arjun", "Deepak", "Divya", "Kavita", "Manoj", "Neha", "Pooja", "Rahul", "Rajesh", "Ravi", "Sneha", "Suresh", "Vikram"]
INDIAN_LAST = ["Agarwal", "Bhatt", "Chopra", "Desai", "Gupta", "Iyer", "Joshi", "Kapoor", "Mehta", "Nair", "Patel", "Reddy", "Sharma", "Singh", "Verma"]
INDIAN_SUFFIX = [" Pvt. Ltd.", " Pvt Ltd", " Industries", " Enterprises", " Solutions", " Exports", ""]
COMPLEX_NAMES = [
    "Anne-Marie O'Brien", "Jose Garcia", "Maria-Elena Rossi", "Jean-Luc Martin", "Sarah O'Neill", "Li-Wei Chen",
    "Fatima Al-Hassan", "Daniel D'Souza", "Emily St. Clair", "Ravi Kumar-Nair", "Noah McCarthy", "Olivia Van Dyke",
]
STREETS = ["142 Harbor Street", "88 Market Road", "2100 Pine Avenue, Suite 400", "17 Lakeview Drive", "905 Industrial Way"]
CITIES = ["Seattle, WA 98101", "Austin, TX 78701", "Portland, OR 97205", "Chicago, IL 60601", "Denver, CO 80202"]
INDIAN_ADDRESSES = ["Plot 45, Sector 18, Gurugram 122015", "12 MG Road, Bengaluru 560001", "B-204 Andheri East, Mumbai 400069", "27 Anna Salai, Chennai 600002"]
TAGLINES = ["Innovative solutions since 1998", "Quality you can rely on", "Your partner in growth", "Designed for tomorrow", "Making business simple"]
TITLES_EXTRA = ["Sales & Marketing Manager", "Head of Partnerships", "Chief Technology Officer", "Managing Director", "Senior Project Engineer"]


def record(index: int, rng: random.Random, fmt: str) -> dict:
    first, last = rng.choice(base.FIRST_NAMES), rng.choice(base.LAST_NAMES)
    company = base.company_for(rng)
    title = rng.choice(base.TITLES + TITLES_EXTRA)
    email, website, domain_root = base.email_and_domain(first, last, company, rng)
    phone = f"+1 ({rng.choice([206, 312, 415, 503, 617])}) 555-{rng.randrange(1000, 10000):04d}"
    name = f"{first} {last}"
    if fmt == "india":
        first, last = rng.choice(INDIAN_FIRST), rng.choice(INDIAN_LAST)
        company = f"{rng.choice(base.COMPANY_A)} {rng.choice(base.COMPANY_B)}{rng.choice(INDIAN_SUFFIX)}"
        domain_root = "".join(ch.lower() for ch in company if ch.isalnum() and ch.lower() not in "")[:20] or "exampleco"
        domain = f"{domain_root}.co.in"
        email, website, name = f"{first.lower()}.{last.lower()}@{domain}", f"www.{domain}", f"{first} {last}"
        phone = f"+91 {rng.choice([98, 99, 97, 88, 70])}{rng.randrange(100, 1000)} {rng.randrange(10000, 100000)}"
    if fmt == "complex-names":
        name = rng.choice(COMPLEX_NAMES)
        parts = [p for p in name.replace("'", "").replace("-", " ").replace(".", "").split() if p]
        email = f"{parts[0].lower()}.{parts[-1].lower()}@{domain_root}.example"
    if fmt == "caps-name":
        name = name.upper()
    if fmt == "minimal":
        company = ""
    return {
        "id": f"card-{index:05d}", "split": "test", "layout": fmt, "name": name, "title": title, "company": company,
        "email": email, "phone": phone, "website": website if fmt != "minimal" else "", "domainRoot": domain_root,
    }


def draw_position_card(rec: dict, rng: random.Random, fonts: list[Path]) -> Image.Image:
    fmt = rec["layout"]
    background, ink, accent = base.PALETTES[rng.randrange(len(base.PALETTES))]
    muted = (96, 101, 104)
    width, height = (1050, 650)
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    path = rng.choice(fonts) if fonts else None
    m = 60
    name_font = base.fit_font(draw, rec["name"], path, 52, 34, 800, True)
    title_font = base.fit_font(draw, rec["title"], path, 28, 20, 800)
    company_font = base.fit_font(draw, rec["company"], path, 34, 22, 900, True)
    contact_font = base.font(path, 25)
    contacts = [rec["email"], rec["phone"], rec["website"]]

    def text_w(text, fnt):
        return draw.textbbox((0, 0), text, font=fnt)[2]

    def block(x, y, with_company_gap=0):
        draw.text((x, y), rec["name"], font=name_font, fill=ink)
        draw.text((x, y + 70), rec["title"], font=title_font, fill=muted)
        for n, v in enumerate(contacts):
            draw.text((x, y + 150 + with_company_gap + n * 48), v, font=contact_font, fill=ink)

    if fmt == "company-top-right":
        draw.text((width - m - text_w(rec["company"], company_font), 50), rec["company"], font=company_font, fill=ink)
        block(m, 190)
    elif fmt == "company-middle":
        draw.text((m, 110), rec["name"], font=name_font, fill=ink)
        draw.text((m, 180), rec["title"], font=title_font, fill=muted)
        draw.text((m, 270), rec["company"], font=company_font, fill=accent)
        for n, v in enumerate(contacts):
            draw.text((m, 360 + n * 48), v, font=contact_font, fill=ink)
    elif fmt == "company-bottom":
        block(m, 90)
        draw.text((m, 540), rec["company"], font=company_font, fill=ink)
    elif fmt == "company-below-title":
        draw.text((m, 120), rec["name"], font=name_font, fill=ink)
        draw.text((m, 190), rec["title"], font=title_font, fill=muted)
        draw.text((m, 236), rec["company"], font=base.font(path, 28, True), fill=ink)
        for n, v in enumerate(contacts):
            draw.text((m, 370 + n * 48), v, font=contact_font, fill=ink)
    elif fmt == "company-sidebar":
        draw.rectangle((0, 0, 330, height), fill=accent)
        words = rec["company"].split()
        for n, word in enumerate(words[:4]):
            draw.text((36, 90 + n * 56), word, font=base.font(path, 38, True), fill=(255, 255, 255))
        block(390, 150)
    elif fmt == "company-big-name-small":
        draw.text((m, 70), rec["company"], font=base.fit_font(draw, rec["company"], path, 60, 30, 930, True), fill=accent)
        draw.text((m, 300), rec["name"], font=base.fit_font(draw, rec["name"], path, 36, 24, 800, True), fill=ink)
        draw.text((m, 350), rec["title"], font=base.font(path, 22), fill=muted)
        for n, v in enumerate(contacts):
            draw.text((m, 430 + n * 42), v, font=base.font(path, 22), fill=ink)
    elif fmt == "company-vertical-band":
        draw.rectangle((0, 0, width, 120), fill=accent)
        draw.text((m, 38), rec["company"], font=base.fit_font(draw, rec["company"], path, 38, 24, 930, True), fill=(255, 255, 255))
        block(m, 190)
    elif fmt == "company-footer-bar":
        block(m, 80)
        draw.rectangle((0, height - 110, width, height), fill=ink)
        draw.text((m, height - 80), rec["company"], font=base.fit_font(draw, rec["company"], path, 34, 22, 930, True), fill=(255, 255, 255))
    elif fmt == "company-two-line":
        words = rec["company"].split()
        half = max(1, len(words) // 2)
        draw.text((m, 50), " ".join(words[:half]), font=company_font, fill=ink)
        draw.text((m, 96), " ".join(words[half:]) or " ", font=company_font, fill=ink)
        block(m, 230)
    else:  # company-corner-logo: a logo mark top-right, company set small beside the contact details
        draw.ellipse((width - 150, 40, width - 50, 140), fill=accent)
        block(m, 110)
        draw.text((width - m - text_w(rec["company"], base.font(path, 24, True)), 560), rec["company"], font=base.font(path, 24, True), fill=ink)
    return image


def canvas(fmt: str, rng: random.Random):
    size = (650, 1050) if fmt == "portrait" else (640, 400) if fmt == "low-res" else (1050, 650)
    palette = base.PALETTES[rng.randrange(len(base.PALETTES))]
    background, ink, accent = palette
    muted = (96, 101, 104)
    if fmt == "dark":
        background, ink, muted = (24, 32, 44), (240, 242, 245), (170, 178, 188)
    return Image.new("RGB", size, background), ink, accent, muted


def draw_card(rec: dict, rng: random.Random, fonts: list[Path]) -> Image.Image:
    fmt = rec["layout"]
    image, ink, accent, muted = canvas(fmt, rng)
    width, height = image.size
    draw = ImageDraw.Draw(image)
    path = rng.choice(fonts) if fonts else None
    scale = width / 1050 if fmt in ("low-res",) else 1.0
    s = lambda v: int(v * scale)  # noqa: E731
    margin = s(60)
    name_text = rec["name"]
    name_font = base.fit_font(draw, name_text, path, s(52), s(30), width - 2 * margin, True)
    title_font = base.fit_font(draw, rec["title"], path, s(29), s(18), width - 2 * margin)
    company_font = base.fit_font(draw, rec["company"] or "x", path, s(32), s(20), width - 2 * margin, True)
    contact_font = base.font(path, s(25))
    small = base.font(path, s(22))

    if fmt == "portrait":
        draw.text((margin, 90), rec["company"], font=company_font, fill=ink)
        draw.line((margin, 160, width - margin, 160), fill=muted, width=2)
        draw.text((margin, 330), name_text, font=base.fit_font(draw, name_text, path, 50, 28, width - 2 * margin, True), fill=ink)
        draw.text((margin, 400), rec["title"], font=base.fit_font(draw, rec["title"], path, 28, 18, width - 2 * margin), fill=muted)
        for n, v in enumerate([rec["email"], rec["phone"], rec["website"]]):
            draw.text((margin, 700 + n * 60), v, font=base.fit_font(draw, v, path, 25, 16, width - 2 * margin), fill=ink)
    elif fmt == "centered":
        def centered(text: str, y: int, fnt, fill):
            w = draw.textbbox((0, 0), text, font=fnt)[2]
            draw.text(((width - w) // 2, y), text, font=fnt, fill=fill)
        draw.ellipse((width // 2 - 32, 50, width // 2 + 32, 114), fill=accent)
        centered(rec["company"], 140, company_font, ink)
        centered(name_text, 240, name_font, ink)
        centered(rec["title"], 315, title_font, muted)
        for n, v in enumerate([rec["email"], rec["phone"], rec["website"]]):
            centered(v, 400 + n * 52, contact_font, ink)
    elif fmt == "labeled-contact":
        draw.text((margin, 70), rec["company"], font=company_font, fill=ink)
        draw.text((margin, 190), name_text, font=name_font, fill=ink)
        draw.text((margin, 262), rec["title"], font=title_font, fill=muted)
        for n, (label, v) in enumerate([("E", rec["email"]), ("T", rec["phone"]), ("W", rec["website"])]):
            draw.text((margin, 360 + n * 52), f"{label}  {v}" if rng.random() < 0.5 else f"{label}: {v}", font=contact_font, fill=ink)
    elif fmt == "address-tagline":
        draw.text((margin, 60), rec["company"], font=company_font, fill=ink)
        draw.text((margin, 108), rng.choice(TAGLINES), font=small, fill=muted)
        draw.text((margin, 200), name_text, font=name_font, fill=ink)
        draw.text((margin, 270), rec["title"], font=title_font, fill=muted)
        lines = [rec["email"], rec["phone"], rec["website"], rng.choice(STREETS), rng.choice(CITIES)]
        for n, v in enumerate(lines):
            draw.text((margin, 360 + n * 46), v, font=contact_font, fill=ink)
    elif fmt == "india":
        draw.text((margin, 60), rec["company"], font=company_font, fill=ink)
        draw.text((margin, 190), name_text, font=name_font, fill=ink)
        draw.text((margin, 262), rec["title"], font=title_font, fill=muted)
        lines = [f"M: {rec['phone']}", f"E: {rec['email']}", rec["website"], rng.choice(INDIAN_ADDRESSES)]
        for n, v in enumerate(lines):
            draw.text((margin, 350 + n * 48), v, font=base.fit_font(draw, v, path, 25, 16, width - 2 * margin), fill=ink)
    elif fmt == "two-phones":
        draw.text((margin, 60), rec["company"], font=company_font, fill=ink)
        draw.text((margin, 190), name_text, font=name_font, fill=ink)
        draw.text((margin, 262), rec["title"], font=title_font, fill=muted)
        office = f"+1 ({rng.choice([206, 312, 415])}) 555-{rng.randrange(1000, 10000):04d}"
        for n, v in enumerate([f"Mobile {rec['phone']}", f"Office {office}", rec["email"], rec["website"]]):
            draw.text((margin, 350 + n * 48), v, font=contact_font, fill=ink)
    elif fmt == "minimal":
        draw.text((margin, 200), name_text, font=name_font, fill=ink)
        draw.text((margin, 272), rec["title"], font=title_font, fill=muted)
        for n, v in enumerate([rec["email"], rec["phone"]]):
            draw.text((margin, 380 + n * 52), v, font=contact_font, fill=ink)
    else:  # dark, caps-name, complex-names, phone-photo, low-res share the classic arrangement
        draw.text((margin + 80, margin), rec["company"], font=company_font, fill=ink)
        draw.rounded_rectangle((margin, margin, margin + 58, margin + 58), radius=16, fill=accent)
        draw.text((margin, 190 if fmt != "low-res" else s(190)), name_text, font=name_font, fill=ink)
        draw.text((margin + 2, s(262)), rec["title"], font=title_font, fill=muted)
        for n, v in enumerate([rec["email"], rec["phone"], rec["website"]]):
            draw.text((margin, s(358) + n * s(49)), v, font=contact_font, fill=ink)

    if fmt == "phone-photo":
        # Perspective-like skew, uneven light, grain, softness and a small rotation: a hand-held photo of a card.
        w, h = image.size
        shift = rng.randrange(18, 48)
        image = image.transform((w, h), Image.Transform.QUAD, (shift, 0, 0, h - 8, w - 2 * shift, h, w - shift, 12), resample=Image.Resampling.BICUBIC, fillcolor=(190, 190, 186))
        shade = Image.linear_gradient("L").resize((w, h)).rotate(rng.choice([0, 90, 180, 270]))
        image = Image.composite(image, Image.new("RGB", (w, h), (120, 120, 118)), shade.point(lambda v: 170 + v // 3))
        image = image.rotate(rng.uniform(-4, 4), resample=Image.Resampling.BICUBIC, fillcolor=(180, 180, 176))
        image = image.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.5, 1.1)))
        noise = Image.effect_noise((w, h), 14).convert("RGB")
        image = Image.blend(image, noise, 0.06)
        image = image.resize((int(w * 0.8), int(h * 0.8)), Image.Resampling.LANCZOS)
    if fmt == "low-res":
        image = image.filter(ImageFilter.GaussianBlur(radius=0.5))
    if fmt == "dark":
        image = ImageEnhance.Contrast(image).enhance(0.92)
    return image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-format", type=int, default=40)
    parser.add_argument("--seed", type=int, default=20261004)
    parser.add_argument("--output", type=Path, default=Path("data/ocr-formats"))
    parser.add_argument("--set", choices=["formats", "positions"], default="formats", help="positions = the company in many places on the card")
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f"Refusing to overwrite existing data: {args.output.resolve()}")
    args.output.mkdir(parents=True)
    fonts = [c for c in base.FONT_CANDIDATES if c.exists()]
    rng = random.Random(args.seed)
    index = 0
    with (args.output / "manifest.jsonl").open("w", encoding="utf-8") as manifest:
        for fmt in (POSITIONS if args.set == "positions" else FORMATS):
            for _ in range(args.per_format):
                rec = record(index, rng, "classic" if args.set == "positions" else fmt)
                rec["layout"] = fmt
                picture = draw_position_card(rec, rng, fonts) if args.set == "positions" else draw_card(rec, rng, fonts)
                picture.save(args.output / f"{rec['id']}.png", optimize=True)
                manifest.write(json.dumps(rec, ensure_ascii=False) + "\n")
                index += 1
    print(json.dumps({"output": str(args.output.resolve()), "count": index, "formats": POSITIONS if args.set == "positions" else FORMATS, "synthetic": True}))


if __name__ == "__main__":
    main()
