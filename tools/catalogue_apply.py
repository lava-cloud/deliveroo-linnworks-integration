"""Turn the decisions in the "Deliveroo catalogue review" Google Sheet into
Deliveroo upload files (run locally; nothing here touches Deliveroo).

    python tools/catalogue_apply.py <review.xlsx> <live-menu.json> [--out DIR] [--write-repo]

<review.xlsx>    the sheet exported as .xlsx (Drive export keeps Google's
                 calculated values, which this reads)
<live-menu.json> GET /menu/v2/brands/{brand}/sites/{site}/menu, saved

Writes to --out (default: ../deliveroo-uploads/<today> beside the repo):
  catalogue-update.csv   Catalogue Manager bulk edit, one row per kept item:
                         approved title/price/description, PLU = Linnworks
                         SKU, barcode, and the Deliveroo rule settings
  new-products.csv       Catalogue Manager new-item upload for "Add = Yes" rows
  images/                1200 x 800 JPGs on white, named "<SKU> <title>.jpg"
  summary.md             what changed, and every warning
With --write-repo, "Delete from Deliveroo" rows are added to retired-items.json
and removed from sku-map.json, so the next deploy hides them for good.
"""
import argparse
import csv
import datetime as dt
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

import openpyxl
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
PHOTO_DIR = REPO.parents[3] / "Lava Directors" / "Deliveroo" / "Photoshoot Images" / "Deliveroo Images"
UPDATE_COLS = ["item_id", "item_name", "item_description", "delivery_price", "tax_rate", "max_quantity",
               "age_restricted", "plu", "barcodes", "ian", "classifications", "replacement_eligible",
               "substitution_eligible", "internal_name", "returnable"]
NEW_COLS = ["category_id", "category_name", "item_name", "item_description", "delivery_price", "instore_price",
            "tax_rate", "max_quantity", "age_restricted", "barcodes", "classifications", "replacement_eligible",
            "substitution_eligible", "internal_name", "returnable"]
IMG_W, IMG_H = 1200, 800


def is_returns_sku(sku, title=""):
    return bool(re.match(r"^\s*NO\b", sku or "", re.I) or re.search(r"\bNO\s*$", sku or "", re.I)
                or re.match(r"^\s*NO\s*[-_]", title or "", re.I))


def ean_ok(b):
    b = (b or "").strip()
    if not re.fullmatch(r"\d{8}|\d{12}|\d{13}|\d{14}", b):
        return False
    d = [int(x) for x in b]
    s = sum(x * (3 if i % 2 == 0 else 1) for i, x in enumerate(d[:-1][::-1]))
    return (10 - s % 10) % 10 == d[-1]


def tf(v):
    return "TRUE" if v else "FALSE"


def money(v):
    return f"{float(v):.2f}"


def rule_settings(rules):
    """Deliveroo settings implied by the sheet's 'Deliveroo rules' text."""
    rules = rules or ""
    age = bool(re.search(r"Age restricted", rules))
    maxq = "2" if re.search(r"max quantity", rules) else ""
    return age, maxq


def tab(wb, name):
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    hdr = [str(h).strip() if h is not None else "" for h in rows[0]]
    return [dict(zip(hdr, r)) for r in rows[1:] if any(v not in (None, "") for v in r)]


def fetch_image(src):
    """Open an image from the photoshoot folder or a URL."""
    m = re.match(r"Deliveroo photoshoot: (\S+\.jpg)", src or "")
    if m:
        return Image.open(PHOTO_DIR / m.group(1))
    m = re.match(r"(Webstore|Linnworks): (https?://\S+)", src or "")
    if m:
        req = urllib.request.Request(m.group(2), headers={"User-Agent": "Mozilla/5.0 (Lava catalogue tool)"})
        return Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=60).read()))
    return None


def to_deliveroo_image(im):
    """Fit inside 1200 x 800 on white, product centred (Deliveroo's spec)."""
    im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im).convert("RGB")
    scale = min((IMG_W - 80) / im.width, (IMG_H - 60) / im.height)  # up or down, to fill the frame
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", (IMG_W, IMG_H), "white")
    canvas.paste(im, ((IMG_W - im.width) // 2, (IMG_H - im.height) // 2))
    return canvas


def safe_name(s, n=60):
    s = (s or "").replace("/", "-").replace('"', " inch")
    return re.sub(r"\s+", " ", re.sub(r"[^\w\-. ]+", "", s))[:n].strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("review")
    ap.add_argument("menu")
    ap.add_argument("--out")
    ap.add_argument("--write-repo", action="store_true")
    ap.add_argument("--repo", default=str(REPO), help="folder holding sku-map.json and retired-items.json")
    ap.add_argument("--no-images", action="store_true")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.review, data_only=True)
    hw = {r[1]: r[2] for r in wb["How to use"].iter_rows(values_only=True) if r[1]}
    fee = float(hw.get("Deliveroo fee (delivery orders, ex VAT)", 0.225))
    vat = float(hw.get("VAT rate", 0.2))
    target = float(hw.get("Target margin (net of VAT)", 0.3))
    cap = float(hw.get("Price cap: highest mark-up over webstore", 0.35))
    menu = json.load(open(a.menu, encoding="utf-8"))
    menu = menu.get("body", menu)  # a saved {status, body} from /debug/cat/raw
    menu = menu.get("menu", menu)  # the raw Menu API v2 response
    live = {i["id"]: i for i in menu["items"]}
    cats = {(c["name"]["en"] if isinstance(c["name"], dict) else c["name"]): c["id"] for c in menu["categories"]}

    out = Path(a.out) if a.out else REPO.parent / "deliveroo-uploads" / dt.date.today().isoformat()
    (out / "images").mkdir(parents=True, exist_ok=True)
    warn, done = [], {"apply": 0, "keep": 0, "delete": 0, "add": 0, "images": 0}
    images_wanted = []

    def margin(p, cost):
        return (p / (1 + vat) - p * fee - cost) / (p / (1 + vat))

    def check_price(label, price, cost, web):
        if cost and margin(price, cost) < target - 1e-9:
            warn.append(f"{label}: margin {margin(price, cost):.1%} at £{price:.2f} is under the {target:.0%} target")
        if web and price >= web * (1 + cap) - 1e-9:
            warn.append(f"{label}: £{price:.2f} is {price / web - 1:.0%} over the webstore price "
                        f"(Deliveroo can suspend at {cap:.0%})")

    # ------------------------------------------------------------ Products
    update_rows, retire, vat_fixes = [], [], []
    for r in tab(wb, "Products"):
        iid, decision = r.get("Deliveroo item_id"), (r.get("Decision") or "").strip()
        sku = str(r.get("SKU") or "").strip()
        item = live.get(iid)
        label = f"{sku or 'no SKU'} {r.get('Current Deliveroo title', '')[:50]}"
        if item and str(item.get("tax_rate")) not in ("20", "20.0"):
            vat_fixes.append(iid)
        if not item:
            if decision:
                warn.append(f"{label}: no longer on the live menu, skipped")
            continue
        if decision == "Delete from Deliveroo":
            retire.append({"item_id": iid, "sku": sku, "title": r.get("Current Deliveroo title"),
                           "retired_on": dt.date.today().isoformat()})
            done["delete"] += 1
            continue
        if r.get("Status") == "Returns listing":
            warn.append(f"{label}: customer returns listing left on the menu; mark it Delete")
            continue
        if not sku:
            continue  # unlinked: nothing to backfill until it has a SKU
        if is_returns_sku(sku):
            warn.append(f"{label}: SKU {sku} is a customer return (NO) and must not be sold")
            continue
        apply = decision == "Apply proposed changes"
        current_desc = item.get("description")
        current_desc = current_desc.get("en", "") if isinstance(current_desc, dict) else (current_desc or "")
        barcode = str(r.get("Barcode") or "").strip()
        if barcode and not ean_ok(barcode):
            warn.append(f"{label}: barcode {barcode} fails the check digit, left off (fix it in Linnworks)")
            barcode = ""
        if not apply:
            # Keep as is (or not decided yet): only the PLU and a missing barcode change.
            classes = item.get("classifications") or []
            update_rows.append({
                "item_id": iid, "item_name": item["name"]["en"], "item_description": current_desc,
                "delivery_price": money(item["price_info"]["price"] / 100), "tax_rate": "20",
                "max_quantity": item.get("max_quantity") or "",
                "age_restricted": tf("age_restricted" in classes or item.get("contains_alcohol")),
                "plu": sku, "barcodes": ",".join(item.get("barcodes") or []) or barcode,
                "ian": item.get("ian") or "", "classifications": ",".join(classes),
                "replacement_eligible": tf(item.get("is_eligible_as_replacement")),
                "substitution_eligible": tf(item.get("is_eligible_for_substitution")),
                "internal_name": item.get("operational_name") or item["name"]["en"],
                "returnable": tf(item.get("is_returnable", True)),
            })
            done["keep"] += 1
            continue
        name = r.get("Proposed title") or item["name"]["en"]
        desc = r.get("Proposed description") or current_desc
        price = float(r.get("Proposed price £")) if r.get("Proposed price £") not in (None, "") \
            else item["price_info"]["price"] / 100
        if apply:
            check_price(label, price, r.get("Cost £ (ex VAT)") or None, r.get("Webstore price £") or None)
            if len(name) > 100:
                warn.append(f"{label}: title is {len(name)} characters (keep under 100)")
            if desc and len(desc) > 500:
                warn.append(f"{label}: description is {len(desc)} characters (keep under 500)")
            if str(r.get("Deliveroo rules") or "").startswith("Not allowed"):
                warn.append(f"{label}: flagged 'Not allowed' by Deliveroo's rules; check before uploading")
            if price > 275:
                warn.append(f"{label}: £{price:.2f} is over £275, which needs Deliveroo's permission")
            images_wanted.append((sku, name, r.get("Image")))
        age, maxq = rule_settings(r.get("Deliveroo rules"))
        update_rows.append({
            "item_id": iid, "item_name": name, "item_description": desc or "",
            "delivery_price": money(price), "tax_rate": "20", "max_quantity": maxq or (item.get("max_quantity") or ""),
            "age_restricted": tf(age), "plu": sku, "barcodes": barcode or ",".join(item.get("barcodes") or []),
            "ian": item.get("ian") or "", "classifications": ",".join(item.get("classifications") or []),
            "replacement_eligible": "FALSE", "substitution_eligible": "FALSE",
            "internal_name": f"{sku} {name}"[:100], "returnable": tf(item.get("is_returnable", True)),
        })
        done["apply"] += 1

    # ------------------------------------------------------------ Add products
    new_rows = []
    for r in tab(wb, "Add products"):
        if str(r.get("Add to Deliveroo?") or "").strip().lower() != "yes":
            continue
        sku = str(r.get("SKU") or "").strip()
        label = f"new {sku} {str(r.get('Proposed Deliveroo title'))[:50]}"
        if is_returns_sku(sku, r.get("Linnworks title")):
            warn.append(f"{label}: customer return (NO) SKU, refused")
            continue
        if str(r.get("Deliveroo rules") or "").startswith("Not allowed"):
            warn.append(f"{label}: not allowed by Deliveroo's rules, refused")
            continue
        cat = r.get("Category") or "Other"
        if cat not in cats:
            warn.append(f"{label}: unknown category '{cat}', used Other")
            cat = "Other"
        price = r.get("Proposed price £")
        if price in (None, ""):
            warn.append(f"{label}: no proposed price, refused")
            continue
        price = float(price)
        check_price(label, price, r.get("Cost £ (ex VAT)") or None, r.get("Webstore price £") or None)
        barcode = re.sub(r"\s*\(invalid\)", "", str(r.get("Barcode") or "")).strip()
        if barcode and not ean_ok(barcode):
            warn.append(f"{label}: barcode {barcode} fails the check digit, left off")
            barcode = ""
        desc = r.get("Proposed description") or ""
        if not desc:
            warn.append(f"{label}: no description (the listing standard needs one)")
        if price > 275:
            warn.append(f"{label}: over £275 needs Deliveroo's permission")
        age, maxq = rule_settings(r.get("Deliveroo rules"))
        name = r.get("Proposed Deliveroo title") or ""
        new_rows.append({
            "category_id": cats[cat], "category_name": cat, "item_name": name, "item_description": desc,
            "delivery_price": money(price), "instore_price": "", "tax_rate": "20", "max_quantity": maxq,
            "age_restricted": tf(age), "barcodes": barcode, "classifications": "",
            "replacement_eligible": "FALSE", "substitution_eligible": "FALSE",
            "internal_name": f"{sku} {name}"[:100], "returnable": "",
        })
        images_wanted.append((sku, name, r.get("Image")))
        done["add"] += 1

    # ------------------------------------------------------------ files
    for fname, cols, rows in (("catalogue-update.csv", UPDATE_COLS, update_rows),
                              ("new-products.csv", NEW_COLS, new_rows)):
        with open(out / fname, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
    if not a.no_images:
        for sku, name, src in images_wanted:
            if not src:
                warn.append(f"{sku}: no image source")
                continue
            try:
                im = fetch_image(src)
                if im is None:
                    warn.append(f"{sku}: image source not understood: {src[:60]}")
                    continue
                if min(im.size) < 700:
                    warn.append(f"{sku}: source image is only {im.width} x {im.height}; a sharper photo would be better")
                to_deliveroo_image(im).save(out / "images" / f"{sku} {safe_name(name)}.jpg", quality=90)
                done["images"] += 1
            except Exception as e:  # keep going; report it
                warn.append(f"{sku}: image failed ({e})")

    if a.write_repo and retire:
        ret_path, map_path = Path(a.repo) / "retired-items.json", Path(a.repo) / "sku-map.json"
        existing = json.load(open(ret_path, encoding="utf-8")) if ret_path.exists() else []
        have = {x["item_id"] for x in existing}
        existing += [x for x in retire if x["item_id"] not in have]
        json.dump(existing, open(ret_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
        smap = json.load(open(map_path, encoding="utf-8"))
        gone = {x["item_id"] for x in existing}
        new_map = {}
        for s, ids in smap.items():
            kept = [i for i in ([ids] if isinstance(ids, str) else ids) if i not in gone]
            if kept:
                new_map[s] = kept[0] if len(kept) == 1 else kept
        json.dump(new_map, open(map_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    lines = [f"# Deliveroo catalogue changes, {dt.date.today().isoformat()}", "",
             f"- Existing items in catalogue-update.csv: {len(update_rows)} "
             f"({done['apply']} with approved changes, {done['keep']} kept as they are but given PLU and barcode)",
             f"- Deleted (retired, hidden for good): {done['delete']}" + ("" if a.write_repo else " (not written: no --write-repo)"),
             f"- VAT rate corrected to 20% (was 0% on Deliveroo): {sum(1 for x in vat_fixes if x in {u['item_id'] for u in update_rows})}",
             f"- New products in new-products.csv: {done['add']}",
             f"- Images made (1200 x 800): {done['images']}",
             f"- Assumptions read from the sheet: fee {fee:.1%} + VAT, target margin {target:.0%}, price cap {cap:.0%}",
             "", "## Warnings", ""] + ([f"- {w}" for w in warn] or ["- none"])
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"\nWritten to {out}")


if __name__ == "__main__":
    sys.exit(main())
