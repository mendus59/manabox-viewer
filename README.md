# MTG Collection Viewer

A static website for sharing a ManaBox collection, with card images and Scryfall-style search.

## How it works

```
ManaBox_Collection.csv ──► build.py ──► site/data/cards.js ──► site/index.html
   (your export)         (Scryfall lookup)   (card data, ~1.8 MB)    (static site)
```

- **`build.py`** reads the ManaBox CSV and merges duplicate printings across binders. It ignores the binder, purchase price, condition, and other columns, keeping only the card, quantity, and foil status. It fetches full card data from Scryfall's `/cards/collection` endpoint (75 cards per request, so ~17 requests for ~1,250 cards) and writes `site/data/cards.js`.
- **`site/`** is a plain HTML/CSS/JS site with no server code and no build tools. All searching happens in the browser against the local data, so loading or searching the site never calls the Scryfall API. Card images load from Scryfall's image CDN, which Scryfall permits.

## Updating the collection

1. Export your collection from ManaBox as CSV and save it over `ManaBox_Collection.csv`, or pass a different path.
2. Run:
   ```
   python build.py
   python build.py path\to\other_export.csv   # alternative
   ```
3. Commit and push `site/data/cards.js`. GitHub Pages redeploys automatically (see below).

Requires Python 3.9+ and no packages. Prices are refreshed each time you build.

## Prices

The site's USD prices are the highest of TCGplayer market (via Scryfall), Card Kingdom near-mint retail, and MTGGoldfish paper for each finish you own.

- **Weekly:** `.github/workflows/prices.yml` runs `refresh_prices.py` every Monday at 12:00 UTC, commits `site/data/cards.js`, and redeploys. It reads only the published site data, so the CSV never needs to be in the repo. Run it by hand from the **Actions** tab with **Update prices → Run workflow**.
- **After a rebuild:** `build.py` writes Scryfall prices only, so run `python refresh_prices.py` afterwards. Add `--no-goldfish` to skip the ~15-minute MTGGoldfish scrape.
- **For the CSV:** `python update_prices.py` writes `ManaBox_Collection_updated.csv` (same columns, with `Purchase price` set to the highest price) and `ManaBox_Collection_prices.csv` (each source's price per row).

## Viewing locally

Open `site/index.html` in a browser by double-clicking it. You don't need a server.

## Hosting on GitHub Pages

The workflow in `.github/workflows/pages.yml` publishes the `site/` folder whenever something under `site/` changes on `main`. You can also run it by hand from the **Actions** tab.

One-time setup: in the repo on GitHub, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**. The site is then live at `https://<username>.github.io/manabox-viewer/`.

ManaBox CSV exports are listed in `.gitignore`, so your purchase prices and binder names never reach the repo. Only the processed `site/data/cards.js` is published.

The `site/` folder also works on any other static host, such as Netlify Drop or Cloudflare Pages.

## Search

The search syntax follows https://scryfall.com/docs/syntax: `t:`, `o:`, `c:`, `id:`, `m:`, `mv`, `pow`/`tou`/`loy`, `r:`, `s:`, `cn:`, `f:`, `kw:`, `a:`, `ft:`, `usd`, `year`/`date`, `is:`/`not:`/`has:`, `produces:`, `order:`/`dir:`, `or`, `-` negation, parentheses, quotes, `/regex/`, and `!"exact name"`. Click **Search help** on the page for examples.

Additions specific to this collection:
- `qty>=2` filters by copies owned.
- `is:foil`/`is:nonfoil` match the copies you own, not the printings that exist.

The **Filters** panel above the results adds point-and-click filters, all combined with the search box: color and color identity (including / exactly / at most), mana value, card type (any of / all of), subtype, set, rarity, format legality, foil/non-foil, and price range.

Unsupported keywords show a warning and are ignored rather than breaking the search. The search box, sort, and view are stored in the URL, so you can send friends a link to a specific search.
