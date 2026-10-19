#!/usr/bin/env python3
"""Refresh the prices in site/data/cards.js without the ManaBox CSV.

For every printing in the site data, sets prices.usd / usd_foil / usd_etched
to the highest current price from TCGplayer (via Scryfall), Card Kingdom and
MTGGoldfish. Only the finishes you own are checked on MTGGoldfish. The weekly
GitHub Actions job runs this; you can also run it after build.py:

    python refresh_prices.py
    python refresh_prices.py --no-goldfish   # skip the slow scrape

Only standard-library modules are used, so no pip install is needed.
"""
import argparse
import json
import sys
from datetime import datetime, timezone

from build import OUT, PRICE_KEYS, fetch_cards
from update_prices import card_kingdom_prices, goldfish_price, money

FINISHES = {"usd": False, "usd_foil": True, "usd_etched": True}  # price key -> counts as foil


def owned_keys(card):
    o = card["owned"]
    keys = []
    if o["qty"] > o["foil"] + o["etched"]:
        keys.append("usd")
    if o["foil"]:
        keys.append("usd_foil")
    if o["etched"]:
        keys.append("usd_etched")
    return keys


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-goldfish", action="store_true", help="skip MTGGoldfish (it takes ~15 minutes)")
    args = parser.parse_args()

    text = OUT.read_text(encoding="utf-8")
    payload = json.loads(text[text.index("=") + 1:].strip().rstrip(";"))
    cards = payload["cards"]
    print(f"Read {len(cards)} printings from {OUT.name}")

    print("Fetching TCGplayer prices via Scryfall")
    fresh, _ = fetch_cards([{"id": c["id"]} for c in cards], "Scryfall")
    tcg = {c["id"]: c.get("prices") or {} for c in fresh}
    print("Fetching Card Kingdom pricelist")
    ck = card_kingdom_prices()

    wanted = [(c, k) for c in cards for k in owned_keys(c)]
    goldfish = {}
    if not args.no_goldfish:
        print(f"Fetching MTGGoldfish prices for {len(wanted)} printings")
        for n, (c, k) in enumerate(wanted, start=1):
            print(f"  MTGGoldfish: {n}/{len(wanted)}", end="\r", flush=True)
            goldfish[(c["id"], k)] = goldfish_price(c["set_name"], c["collector_number"], c["name"], FINISHES[k])
        print()

    raised = 0
    for c in cards:
        scry = tcg.get(c["id"])
        if scry is not None:
            # Start from Scryfall's current prices (TCGplayer for USD), dropping stale values.
            c["prices"] = {k: scry[k] for k in PRICE_KEYS if scry.get(k)}
        for k, foil in FINISHES.items():
            found = [money(c["prices"].get(k)), ck.get((c["id"], foil)), goldfish.get((c["id"], k))]
            if k == "usd_etched" and not c["prices"].get(k):
                found[1] = None  # don't give a card an etched price from CK's foil listing
            best = max((p for p in found if p), default=None)
            if best:
                if best > (money(c["prices"].get(k)) or 0):
                    raised += k in owned_keys(c)
                c["prices"][k] = f"{best:.2f}"

    payload["prices_updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    OUT.write_text("window.COLLECTION = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
                   encoding="utf-8")
    print(f"Wrote {OUT.name}: {raised} owned prices raised above TCGplayer, "
          f"{sum(1 for v in goldfish.values() if v)}/{len(goldfish)} found on MTGGoldfish")


if __name__ == "__main__":
    sys.exit(main())
