"""Apply a catalogue link pack to the repo's stock-sync files.

    python tools/apply_link_pack.py <link-pack.json> [--repo DIR]

A link pack comes from the catalogue review upload tool and holds:
  sku_map_add     {"<Linnworks SKU>": "<Deliveroo item id>"}  new links for sku-map.json
  sku_titles_add  {"<Linnworks SKU>": "<Deliveroo title>"}    channel titles shown in Linnworks
  retired_add     [{item_id, sku, title, reason, retired_on}]  listings being deleted (kept hidden)

It refuses a pack that would give one SKU two listings, link an item id twice, map a NO
(customer returns) SKU, or link a listing that is also being retired.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("pack")
ap.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
a = ap.parse_args()
repo = Path(a.repo)
pack = json.load(open(a.pack, encoding="utf-8"))
smap = json.load(open(repo / "sku-map.json", encoding="utf-8"))
titles = json.load(open(repo / "sku-titles.json", encoding="utf-8"))
retired = json.load(open(repo / "retired-items.json", encoding="utf-8"))

ids = lambda v: [v] if isinstance(v, str) else list(v)
mapped = {i: s for s, v in smap.items() for i in ids(v)}
retiring = {r["item_id"] for r in pack.get("retired_add", [])} | {r["item_id"] for r in retired}
problems = []
for sku, iid in pack.get("sku_map_add", {}).items():
    if re.match(r"^\s*NO\b", sku, re.I) or re.search(r"\bNO\s*$", sku, re.I):
        problems.append(f"{sku}: NO (customer returns) SKU")
    if sku in smap and iid not in ids(smap[sku]):
        problems.append(f"{sku}: already linked to {smap[sku]}")
    if iid in mapped and mapped[iid] != sku:
        problems.append(f"{iid}: already linked to SKU {mapped[iid]}")
    if iid in retiring:
        problems.append(f"{iid} ({sku}): also being retired")
if problems:
    sys.exit("Refused:\n  " + "\n  ".join(problems))

added = 0
for sku, iid in pack.get("sku_map_add", {}).items():
    if sku not in smap:
        smap[sku] = iid
        added += 1
titles.update(pack.get("sku_titles_add", {}))
known = {r["item_id"] for r in retired}
new_retired = [r for r in pack.get("retired_add", []) if r["item_id"] not in known]
retired.extend(new_retired)
# a retired listing never stays in the map
gone = {r["item_id"] for r in retired}
for sku in list(smap):
    kept = [i for i in ids(smap[sku]) if i not in gone]
    if not kept:
        del smap[sku]
    else:
        smap[sku] = kept[0] if len(kept) == 1 else kept

for name, data in (("sku-map.json", dict(sorted(smap.items()))), ("sku-titles.json", dict(sorted(titles.items()))),
                   ("retired-items.json", retired)):
    with open(repo / name, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"sku-map: +{added} -> {len(smap)} SKUs; sku-titles: {len(titles)}; retired: +{len(new_retired)} -> "
      f"{len(retired)}")
