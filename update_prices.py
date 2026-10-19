#!/usr/bin/env python3
"""Refresh collection prices from TCGplayer, Card Kingdom and MTGGoldfish.

Reads a ManaBox CSV export, looks up each card's current price at every
source, and writes two files next to the input:

    <name>_updated.csv   same columns as the export, with "Purchase price"
                         set to the highest price found
    <name>_prices.csv    one row per CSV row with each source's price

    python update_prices.py                       # uses ManaBox_Collection.csv
    python update_prices.py path/to/export.csv
    python update_prices.py --no-goldfish         # skip the slow scrape

Sources:
  - TCGplayer: market price, via Scryfall's card data (prices.usd / usd_foil / usd_etched)
  - Card Kingdom: near-mint retail price from CK's public pricelist, matched on Scryfall ID
  - MTGGoldfish: paper price from the card's price page (one request per printing)

Only standard-library modules are used, so no pip install is needed.
"""
import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from build import DEFAULT_CSV, fetch_cards

CK_URL = "https://api.cardkingdom.com/api/v2/pricelist"
GOLDFISH = "https://www.mtggoldfish.com/price/"
UA = "patsmtg-collection-viewer/1.0"
GOLDFISH_DELAY = 0.75  # seconds between MTGGoldfish requests
PRICE_RE = re.compile(r"<div class='price-box paper'>.*?price-box-price'>\$\s*([\d,]+\.\d+)", re.S)


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def money(value):
    try:
        n = float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("'", "")).strip("-")


def tcgplayer_prices(rows):
    """Scryfall ID -> Scryfall card, which carries TCGplayer market prices."""
    ids = sorted({r["Scryfall ID"] for r in rows if r["Scryfall ID"]})
    cards, missing = fetch_cards([{"id": i} for i in ids], "Scryfall")
    for m in missing:
        print(f"  ! not found on Scryfall: {m}")
    return {c["id"]: c for c in cards}


def card_kingdom_prices():
    """(Scryfall ID, is_foil) -> highest CK near-mint retail price."""
    data = json.loads(get(CK_URL, timeout=300))["data"]
    out = {}
    for item in data:
        price = money(item.get("price_retail"))
        sid = item.get("scryfall_id")
        if price and sid:
            key = (sid, item.get("is_foil") == "true")
            out[key] = max(out.get(key, 0), price)
    return out


def goldfish_price(set_name, number, name, foil):
    """Paper price from MTGGoldfish, or None if the page can't be found."""
    card = slug(name)
    urls = [f"{GOLDFISH}{slug(set_name)}/{urllib.request.quote(number)}/{card}{'-foil' if foil else ''}"]
    if not foil:
        # Older URL form, which MTGGoldfish redirects to the printing it picks.
        urls.append(GOLDFISH + urllib.request.quote(set_name.replace(" ", "+"), safe="+:") + "/"
                    + urllib.request.quote(name.replace(" ", "+"), safe="+"))
    for url in urls:
        for attempt in range(3):
            try:
                html = get(url, timeout=60).decode("utf-8", "replace")
                m = PRICE_RE.search(html)
                return money(m.group(1)) if m else None
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break
                time.sleep(5 * (attempt + 1))
            except (urllib.error.URLError, OSError):
                time.sleep(5 * (attempt + 1))
            except ValueError:
                break
            finally:
                time.sleep(GOLDFISH_DELAY)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", nargs="?", default=DEFAULT_CSV, type=Path, help="ManaBox CSV export")
    parser.add_argument("--no-goldfish", action="store_true", help="skip MTGGoldfish (it takes ~15 minutes)")
    args = parser.parse_args()

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames
        rows = list(reader)
    print(f"Read {len(rows)} rows from {args.csv}")

    print("Fetching TCGplayer prices via Scryfall")
    scryfall = tcgplayer_prices(rows)
    print("Fetching Card Kingdom pricelist")
    ck = card_kingdom_prices()

    goldfish = {}
    if not args.no_goldfish:
        wanted = sorted({(r["Set name"], r["Collector number"], r["Name"], r["Foil"] != "normal") for r in rows})
        print(f"Fetching MTGGoldfish prices for {len(wanted)} printings")
        for n, key in enumerate(wanted, start=1):
            print(f"  MTGGoldfish: {n}/{len(wanted)}", end="\r", flush=True)
            goldfish[key] = goldfish_price(*key)
        print()

    report = []
    for r in rows:
        sid, finish = r["Scryfall ID"], r["Foil"]
        foil = finish != "normal"
        prices = (scryfall.get(sid) or {}).get("prices") or {}
        tcg_key = {"foil": "usd_foil", "etched": "usd_etched"}.get(finish, "usd")
        found = {
            "TCGplayer": money(prices.get(tcg_key)),
            "Card Kingdom": ck.get((sid, foil)),
            "MTGGoldfish": goldfish.get((r["Set name"], r["Collector number"], r["Name"], foil)),
        }
        best = max(((p, s) for s, p in found.items() if p), default=None)
        old = money(r["Purchase price"])
        if best:
            r["Purchase price"] = f"{best[0]:.2f}"
        report.append({
            "Name": r["Name"], "Set code": r["Set code"], "Collector number": r["Collector number"],
            "Foil": finish, "Quantity": r["Quantity"], "Binder Name": r["Binder Name"],
            "Old price": f"{old:.2f}" if old else "",
            **{s: f"{p:.2f}" if p else "" for s, p in found.items()},
            "New price": f"{best[0]:.2f}" if best else "", "Source": best[1] if best else "",
        })

    updated = args.csv.with_name(args.csv.stem + "_updated.csv")
    with open(updated, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    details = args.csv.with_name(args.csv.stem + "_prices.csv")
    with open(details, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(report[0]))
        w.writeheader()
        w.writerows(report)

    def total(col):
        return sum(float(x[col] or 0) * int(x["Quantity"]) for x in report)
    unpriced = [x for x in report if not x["New price"]]
    print(f"Wrote {updated.name} and {details.name}")
    print(f"  collection value: ${total('Old price'):,.2f} before, ${total('New price'):,.2f} now")
    for s in ("TCGplayer", "Card Kingdom", "MTGGoldfish"):
        print(f"  {s}: priced {sum(1 for x in report if x[s])} rows, highest for {sum(1 for x in report if x['Source'] == s)}")
    for x in unpriced:
        print(f"  ! no price found: {x['Name']} ({x['Set code']} {x['Collector number']}, {x['Foil']})")


if __name__ == "__main__":
    sys.exit(main())
