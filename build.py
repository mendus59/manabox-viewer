#!/usr/bin/env python3
"""Build the collection data for the web app.

Reads a ManaBox CSV export, looks every card up on Scryfall, and writes
site/data/cards.js. Re-run this whenever you export a new CSV:

    python build.py                        # uses ManaBox_Collection.csv
    python build.py path/to/export.csv

Only standard-library modules are used, so no pip install is needed.
"""
import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT / "ManaBox_Collection.csv"
OUT = ROOT / "site" / "data" / "cards.js"

API = "https://api.scryfall.com/cards/collection"
HEADERS = {
    # Scryfall asks API clients to send a descriptive User-Agent and Accept header.
    "User-Agent": "patsmtg-collection-viewer/1.0",
    "Accept": "application/json",
    "Content-Type": "application/json",
}
BATCH_SIZE = 75      # Scryfall's maximum identifiers per collection request
REQUEST_DELAY = 0.1  # Scryfall asks for 50-100 ms between requests

CARD_FIELDS = [
    "id", "oracle_id", "name", "lang", "released_at", "scryfall_uri", "layout",
    "mana_cost", "cmc", "type_line", "oracle_text", "power", "toughness",
    "loyalty", "defense", "colors", "color_identity", "color_indicator",
    "keywords", "produced_mana", "games", "reserved", "game_changer",
    "finishes", "set", "set_name", "set_type", "collector_number", "digital",
    "rarity", "flavor_text", "artist", "border_color", "frame", "frame_effects",
    "full_art", "textless", "promo", "promo_types", "reprint", "watermark",
    "edhrec_rank",
]
FACE_FIELDS = [
    "name", "mana_cost", "type_line", "oracle_text", "power", "toughness",
    "loyalty", "defense", "colors", "color_indicator", "flavor_text", "artist",
    "watermark",
]
IMAGE_SIZES = ["normal", "large"]
PRICE_KEYS = ["usd", "usd_foil", "usd_etched", "eur", "eur_foil", "tix"]


def read_collection(path):
    """Merge CSV rows into one entry per Scryfall printing with owned counts."""
    owned = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for line, row in enumerate(csv.DictReader(f), start=2):
            sid = (row.get("Scryfall ID") or "").strip()
            set_code = (row.get("Set code") or "").strip().lower()
            number = (row.get("Collector number") or "").strip()
            if not sid and not (set_code and number):
                print(f"  ! line {line}: no Scryfall ID or set/number, skipping {row.get('Name')!r}")
                continue
            key = sid or f"{set_code}/{number}"
            entry = owned.setdefault(key, {
                "id": sid, "set": set_code, "number": number, "name": row.get("Name", ""),
                "qty": 0, "foil": 0, "etched": 0,
            })
            qty = int(row.get("Quantity") or 1)
            entry["qty"] += qty
            finish = (row.get("Foil") or "").strip().lower()
            if finish in ("foil", "etched"):
                entry[finish] += qty
    return owned


def post_collection(identifiers):
    body = json.dumps({"identifiers": identifiers}).encode()
    for attempt in range(5):
        req = urllib.request.Request(API, data=body, headers=HEADERS, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(2 ** attempt)
                continue
            raise
        except urllib.error.URLError:
            time.sleep(2 ** attempt)
    raise RuntimeError("Scryfall kept failing; try again later.")


def fetch_cards(identifiers, label):
    """Yield Scryfall card objects and collect identifiers that weren't found."""
    found, missing = [], []
    batches = [identifiers[i:i + BATCH_SIZE] for i in range(0, len(identifiers), BATCH_SIZE)]
    for n, batch in enumerate(batches, start=1):
        print(f"  {label}: batch {n}/{len(batches)}", end="\r", flush=True)
        result = post_collection(batch)
        found.extend(result.get("data", []))
        missing.extend(result.get("not_found", []))
        time.sleep(REQUEST_DELAY)
    print()
    return found, missing


def pick(source, fields):
    return {k: source[k] for k in fields if source.get(k) not in (None, "", [], False)}


def trim(card):
    """Keep only what the site needs, to keep the data file small."""
    out = pick(card, CARD_FIELDS)
    if card.get("image_uris"):
        out["image_uris"] = pick(card["image_uris"], IMAGE_SIZES)
    if card.get("card_faces"):
        faces = []
        for face in card["card_faces"]:
            f = pick(face, FACE_FIELDS)
            if face.get("image_uris"):
                f["image_uris"] = pick(face["image_uris"], IMAGE_SIZES)
            faces.append(f)
        out["card_faces"] = faces
    out["prices"] = pick(card.get("prices") or {}, PRICE_KEYS)
    # Only keep formats where the card has a status other than "not_legal".
    out["legalities"] = {k: v for k, v in (card.get("legalities") or {}).items() if v != "not_legal"}
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", nargs="?", default=DEFAULT_CSV, type=Path, help="ManaBox CSV export")
    args = parser.parse_args()

    print(f"Reading {args.csv}")
    owned = read_collection(args.csv)
    print(f"  {len(owned)} unique printings, {sum(e['qty'] for e in owned.values())} cards")

    print("Fetching card data from Scryfall")
    by_id = [{"id": e["id"]} for e in owned.values() if e["id"]]
    cards, missing = fetch_cards(by_id, "by Scryfall ID")
    owned_by_id = {e["id"]: e for e in owned.values() if e["id"]}
    pairs = [(card, owned_by_id[card["id"]]) for card in cards if card["id"] in owned_by_id]

    # Retry anything Scryfall didn't recognise (or that had no ID) by set + collector number.
    missing_ids = {m.get("id") for m in missing}
    retry = [e for e in owned.values() if (not e["id"] or e["id"] in missing_ids) and e["set"] and e["number"]]
    if retry:
        retry_cards, still_missing = fetch_cards(
            [{"set": e["set"], "collector_number": e["number"]} for e in retry], "by set/number")
        by_set_number = {(e["set"], e["number"]): e for e in retry}
        for card in retry_cards:
            entry = by_set_number.get((card["set"], card["collector_number"]))
            if entry:
                pairs.append((card, entry))
        for m in still_missing:
            entry = by_set_number.get((m.get("set"), m.get("collector_number")))
            print(f"  ! not found on Scryfall: {entry['name'] if entry else m}")

    merged = {}
    for card, entry in pairs:
        out = merged.get(card["id"])
        if out is None:
            out = merged[card["id"]] = trim(card)
            out["owned"] = {"qty": 0, "foil": 0, "etched": 0}
        for k in ("qty", "foil", "etched"):
            out["owned"][k] += entry[k]

    result = sorted(merged.values(), key=lambda c: (c["name"], c["set"], c["collector_number"]))
    payload = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "cards": result,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("window.COLLECTION = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
                   encoding="utf-8")
    total = sum(c["owned"]["qty"] for c in result)
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(result)} printings, {total} cards "
          f"({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
