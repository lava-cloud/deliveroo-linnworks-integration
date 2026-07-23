// ---------------------------------------------------------------------------
// build-sku-map.js
// Matches Deliveroo catalogue items (Partner Hub export) to Linnworks SKUs by
// product title (Deliveroo names were generated from our eBay titles, which
// Linnworks also holds), then writes:
//   1. ../sku-map.json                       Linnworks SKU -> Deliveroo item_id
//   2. <downloads>/deliveroo-catalogue-with-plu.csv   re-import file for
//      Catalogue Manager bulk edit: plu = Linnworks SKU, barcodes = EAN
//   3. ../mapping-report.md                  match stats + review lists
//
// Usage: node tools/build-sku-map.js <deliveroo-export.csv> <linnworks-export.csv>
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const [, , DELIV_CSV, LINN_CSV, EBAY_CSV] = process.argv;
if (!DELIV_CSV || !LINN_CSV) {
  console.error("Usage: node tools/build-sku-map.js <deliveroo.csv> <linnworks.csv> [ebay-listings.csv]");
  process.exit(1);
}

// --- tiny CSV parser (handles quotes, doubled quotes, embedded commas/newlines)
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvField(v) {
  v = v == null ? "" : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

const pre = (s) =>
  String(s).toLowerCase().replace(/&/g, "and").replace(/pe[- ]?x/g, "pex");
const norm = (s) => pre(s).replace(/[^a-z0-9]+/g, "");
const tokens = (s) => [...new Set(pre(s).split(/[^a-z0-9]+/).filter(Boolean))];
const dice = (a, b) => {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
};

// --- load files
const dRows = parseCsv(fs.readFileSync(DELIV_CSV, "utf8"));
const dHeader = dRows[0];
const dIdx = Object.fromEntries(dHeader.map((h, i) => [h.trim(), i]));
const dItems = dRows.slice(1).filter((r) => r[dIdx.item_id]);

const lRows = parseCsv(fs.readFileSync(LINN_CSV, "utf8"));
const lItems = lRows.slice(1)
  .map((r) => ({ sku: r[0], barcode: r[1] || "", title: r[2] || "" }))
  .filter((r) => r.sku && r.title)
  // never auto-match damaged/defective stock SKUs
  .filter((r) => !/defect|damaged/i.test(r.title) && !/-\s*DEF\b/i.test(r.sku));

// --- variant handling ------------------------------------------------------
// Linnworks titles carry variant prefixes (SINGLE -, NO -, 10 PACK -) and
// trailing **CODE** junk. Deliveroo names mark the NO variant with a trailing
// "- No" and packs with "N X ... Multipack". Match on the CORE title, then use
// the variant tag to pick the right SKU.
function linnVariant(title) {
  let core = title.replace(/\*\*[^*]+\*\*/g, " ").trim();
  let tag = "SINGLE";
  let m;
  if ((m = core.match(/^\s*SINGLE\s*-\s*/i))) core = core.slice(m[0].length);
  else if ((m = core.match(/^\s*NO\s*-\s*/i))) { tag = "NO"; core = core.slice(m[0].length); }
  else if ((m = core.match(/^\s*(\d+)\s*PACK\s*-\s*/i))) { tag = "PACK:" + m[1]; core = core.slice(m[0].length); }
  return { tag, core: core.trim() };
}
function delivVariant(name) {
  let core = name.trim();
  let tag = "SINGLE";
  let m;
  if ((m = core.match(/\s*[-(]\s*No\s*[)]?\s*$/i))) { tag = "NO"; core = core.slice(0, m.index); }
  if ((m = core.match(/^\s*(\d+)\s*X\s+/i))) { tag = "PACK:" + m[1]; core = core.slice(m[0].length).replace(/\s*Multipack\s*$/i, ""); }
  return { tag, core: core.trim() };
}
const numTokens = (s) =>
  new Set((String(s).toLowerCase().match(/\d+(?:\.\d+)?[a-z]*/g) || []));
const numsCompatible = (dName, lTitle) => {
  const dn = numTokens(dName), ln = numTokens(lTitle);
  for (const t of dn) if (!ln.has(t)) return false; // every Deliveroo numeric must appear in candidate
  return true;
};

const lParsed = lItems.map((li) => {
  const v = linnVariant(li.title);
  return { li, tag: v.tag, core: v.core, norm: norm(v.core), t: tokens(v.core) };
});
const byNorm = new Map();
for (const p of lParsed) {
  if (!byNorm.has(p.norm)) byNorm.set(p.norm, []);
  byNorm.get(p.norm).push(p);
}

// --- eBay listings index (primary matching source when provided) -----------
// Deliveroo item names were copied from eBay titles, so title->custom label
// (= Linnworks SKU) is the highest-fidelity route.
const linnSkuSet = new Set(lItems.map((l) => l.sku));
const linnBySku = new Map(lItems.map((l) => [l.sku, l]));
let ebByNorm = new Map(), ebParsed = [];
if (EBAY_CSV) {
  const eb = parseCsv(fs.readFileSync(EBAY_CSV, "utf8").replace(/^﻿/, ""));
  const eh = eb[0];
  const ti = eh.indexOf("Title");
  const ci = eh.findIndex((h) => h.toLowerCase().includes("custom label"));
  const rows = eb.slice(1).filter((r) => r[ti] && r[ci] && r[ci].trim());
  for (const r of rows) {
    const title = r[ti], sku = r[ci].trim();
    const p = { title, sku, norm: norm(title), t: tokens(title) };
    ebParsed.push(p);
    if (!ebByNorm.has(p.norm)) ebByNorm.set(p.norm, []);
    ebByNorm.get(p.norm).push(p);
  }
}

// Prefer candidate whose variant tag matches the Deliveroo variant.
function pickByTag(cands, tag) {
  const exact = cands.filter((c) => c.tag === tag);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  if (tag === "SINGLE" && cands.length === 1) return cands[0];
  return null;
}

// --- match
const matches = [];    // {d, li, method, score}
const ambiguous = [];  // {d, candidates:[{li,score}]}
const unmatched = [];  // {d, best}
for (const r of dItems) {
  const dName = r[dIdx.item_name];

  // --- Pass 1: eBay title (exact, then fuzzy) -> custom label -> SKU
  if (ebParsed.length) {
    const g = ebByNorm.get(norm(dName)) || [];
    const labels = [...new Set(g.map((p) => p.sku))];
    if (labels.length === 1 && linnSkuSet.has(labels[0])) {
      matches.push({ d: r, li: linnBySku.get(labels[0]), method: "ebay-exact", score: 1 });
      continue;
    }
    if (labels.length > 1) {
      const inLinn = labels.filter((s) => linnSkuSet.has(s));
      if (inLinn.length === 1) {
        matches.push({ d: r, li: linnBySku.get(inLinn[0]), method: "ebay-exact", score: 1 });
        continue;
      }
      ambiguous.push({
        d: r,
        candidates: labels.map((s) => ({ li: linnBySku.get(s) || { sku: s, title: "(label not in Linnworks export)", barcode: "" }, score: 1 })),
      });
      continue;
    }
    if (labels.length === 1 && !linnSkuSet.has(labels[0])) {
      // eBay identifies the product but its label isn't in the inventory
      // export (channel SKU / archived). Remember it and fall through to
      // title-matching against Linnworks; report the discrepancy.
      r._ebayLabel = labels[0];
    }
    // eBay fuzzy
    const dt0 = tokens(dName);
    let b = null, s2 = null;
    for (const p of ebParsed) {
      const s = dice(dt0, p.t);
      if (!b || s > b.score) { s2 = b; b = { p, score: s }; }
      else if (!s2 || s > s2.score) s2 = { p, score: s };
    }
    if (b && b.score >= 0.9 && (!s2 || s2.p.sku === b.p.sku || b.score - s2.score >= 0.03) &&
        numsCompatible(dName, b.p.title) && linnSkuSet.has(b.p.sku)) {
      matches.push({ d: r, li: linnBySku.get(b.p.sku), method: "ebay-fuzzy", score: b.score });
      continue;
    }
  }

  // --- Pass 2: Linnworks item titles (variant-aware), as before
  const dv = delivVariant(dName);
  const exactGroup = byNorm.get(norm(dv.core)) || [];
  if (exactGroup.length) {
    const pick = pickByTag(exactGroup, dv.tag);
    if (pick) {
      matches.push({ d: r, li: pick.li, method: "exact", score: 1 });
      continue;
    }
    ambiguous.push({ d: r, candidates: exactGroup.map((p) => ({ li: p.li, score: 1 })) });
    continue;
  }
  const dt = tokens(dv.core);
  const scored = [];
  for (const p of lParsed) scored.push({ p, score: dice(dt, p.t) });
  scored.sort((a, b) => b.score - a.score);
  // Group top scorers by core so SINGLE/NO twins of the same product don't
  // read as "ambiguous"; then pick within the group by variant tag.
  const best = scored[0];
  const bestGroup = scored.filter((s) => s.score >= best.score - 0.001 && s.p.norm === best.p.norm);
  const nextDiff = scored.find((s) => s.p.norm !== best.p.norm);
  const margin = nextDiff ? best.score - nextDiff.score : 1;
  const numOk = numsCompatible(dv.core, best.p.core);
  const confident =
    numOk &&
    ((best.score >= 0.78 && margin >= 0.04) ||
      // lower bar allowed when numerics agree AND the gap to the next
      // different product is clear
      (best.score >= 0.6 && margin >= 0.06));
  if (confident) {
    const pick = pickByTag(bestGroup.map((s) => s.p), dv.tag) || (bestGroup.length === 1 ? bestGroup[0].p : null);
    if (pick) {
      matches.push({ d: r, li: pick.li, method: r._ebayLabel ? "title+label-mismatch" : "fuzzy", score: best.score });
      continue;
    }
  }
  if (best.score >= 0.6) {
    const cands = scored.slice(0, 3).map((s) => ({ li: s.p.li, score: s.score }));
    ambiguous.push({ d: r, candidates: cands });
  } else {
    unmatched.push({ d: r, best: best ? { li: best.p.li, score: best.score } : null });
  }
}

// --- duplicates: one Linnworks SKU matched by multiple Deliveroo items
const bySku = new Map();
for (const m of matches) {
  if (!bySku.has(m.li.sku)) bySku.set(m.li.sku, []);
  bySku.get(m.li.sku).push(m);
}
const dupes = [...bySku.entries()].filter(([, ms]) => ms.length > 1);

// --- outputs
const repoRoot = path.join(__dirname, "..");

// 1. sku-map.json (first match wins for duplicate SKUs; dupes listed in report)
const skuMap = {};
for (const [sku, ms] of bySku.entries()) skuMap[sku] = ms[0].d[dIdx.item_id];
fs.writeFileSync(path.join(repoRoot, "sku-map.json"), JSON.stringify(skuMap, null, 2));

// 2. re-import CSV with plu + barcodes filled for confident matches
const outRows = [dHeader.map(csvField).join(",")];
const matchedByItemId = new Map(matches.map((m) => [m.d[dIdx.item_id], m]));
for (const r of dItems) {
  const m = matchedByItemId.get(r[dIdx.item_id]);
  const copy = [...r];
  if (m) {
    copy[dIdx.plu] = m.li.sku;
    if (m.li.barcode) copy[dIdx.barcodes] = m.li.barcode;
  }
  outRows.push(copy.map(csvField).join(","));
}
const reimportPath = path.join(path.dirname(DELIV_CSV), "deliveroo-catalogue-with-plu.csv");
fs.writeFileSync(reimportPath, outRows.join("\r\n"));

// 3. report
const lines = [];
lines.push(`# Deliveroo ↔ Linnworks mapping report`);
lines.push(``);
lines.push(`Deliveroo items: ${dItems.length} · Linnworks SKUs: ${lItems.length}`);
const byMethod = {};
for (const m of matches) byMethod[m.method] = (byMethod[m.method] || 0) + 1;
lines.push(`Matched: **${matches.length}** (${Object.entries(byMethod).map(([k, v]) => `${k} ${v}`).join(", ")})`);
lines.push(`Needs review: **${ambiguous.length}** · Unmatched: **${unmatched.length}** · Duplicate-SKU groups: **${dupes.length}**`);
lines.push(``);
const mismatches = matches.filter((m) => m.method === "title+label-mismatch");
if (mismatches.length) {
  lines.push(`## eBay label ≠ Linnworks SKU (matched by title; check channel mapping / archived SKUs)`);
  for (const m of mismatches)
    lines.push(`- "${m.d[dIdx.item_name]}" → [${m.li.sku}] (eBay label was \`${m.d._ebayLabel}\`)`);
  lines.push(``);
}
const lowConf = matches.filter((m) => m.score < 0.78).sort((a, b) => a.score - b.score);
if (lowConf.length) {
  lines.push(`## Low-confidence auto-matches (score < 0.78) — double-check these`);
  for (const m of lowConf)
    lines.push(`- (${m.score.toFixed(2)}) "${m.d[dIdx.item_name]}" → [${m.li.sku}] "${m.li.title}"`);
  lines.push(``);
}
if (dupes.length) {
  lines.push(`## Duplicates (same Linnworks SKU ↔ multiple Deliveroo items — consider deleting extras on Deliveroo)`);
  for (const [sku, ms] of dupes) {
    lines.push(`- **${sku}**:`);
    for (const m of ms) lines.push(`  - ${m.d[dIdx.item_id]} — ${m.d[dIdx.item_name]}`);
  }
  lines.push(``);
}
if (ambiguous.length) {
  lines.push(`## Needs review (pick the right SKU, then edit plu in the re-import CSV manually)`);
  for (const a of ambiguous) {
    lines.push(`- DELIVEROO: "${a.d[dIdx.item_name]}" (${a.d[dIdx.item_id]})`);
    for (const c of a.candidates)
      lines.push(`    - candidate: [${c.li.sku}] "${c.li.title}" (score ${c.score.toFixed(2)})`);
  }
  lines.push(``);
}
if (unmatched.length) {
  lines.push(`## Unmatched Deliveroo items (no Linnworks title close enough)`);
  for (const u of unmatched) {
    const hint = u.best ? ` — nearest: [${u.best.li.sku}] "${u.best.li.title}" (${u.best.score.toFixed(2)})` : "";
    lines.push(`- "${u.d[dIdx.item_name]}" (${u.d[dIdx.item_id]})${hint}`);
  }
  lines.push(``);
}
fs.writeFileSync(path.join(repoRoot, "mapping-report.md"), lines.join("\n"));

console.log(`Deliveroo items: ${dItems.length} | Linnworks SKUs: ${lItems.length}`);
console.log(`Matched: ${matches.length} (exact ${matches.filter((m) => m.method === "exact").length} / fuzzy ${matches.filter((m) => m.method === "fuzzy").length})`);
console.log(`Review: ${ambiguous.length} | Unmatched: ${unmatched.length} | Dupe SKU groups: ${dupes.length}`);
console.log(`Wrote: sku-map.json (${Object.keys(skuMap).length} SKUs), mapping-report.md`);
console.log(`Wrote re-import CSV: ${reimportPath}`);
