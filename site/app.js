(function () {
  "use strict";

  const PAGE_SIZE = 120;
  const LEGAL_FORMATS = ["standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper", "brawl", "historic", "timeless"];

  const data = window.COLLECTION || { cards: [] };
  const all = data.cards.map(Search.prepare);
  const totalCopies = all.reduce((n, c) => n + c.owned.qty, 0);

  const $ = (sel) => document.querySelector(sel);
  const els = {
    q: $("#q"), sort: $("#sort"), dir: $("#dir"), status: $("#status"), warnings: $("#warnings"),
    results: $("#results"), sentinel: $("#sentinel"), dialog: $("#card-dialog"), preview: $("#hover-preview"),
    filters: $("#filters"), filterCount: $("#filter-count"), filterClear: $("#filter-clear"),
  };

  const params = new URLSearchParams(location.search);
  const state = {
    query: params.get("q") || "",
    sort: params.get("order") || "name",
    dir: params.get("dir") || null, // null = the sort's natural direction
    view: params.get("view") === "list" ? "list" : "grid",
    results: [],
    shown: 0,
    effectiveDir: "asc",
  };

  // ---------- rendering helpers ----------

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  function symbols(text) {
    return esc(text).replace(/\{([^}]+)\}/g, (m, s) => {
      const file = s.replace(/\//g, "").toUpperCase();
      return `<img class="sym" src="https://svgs.scryfall.io/card-symbols/${encodeURIComponent(file)}.svg" alt="{${s}}" title="{${s}}" onerror="this.replaceWith(this.alt)">`;
    });
  }

  function images(c, size) {
    if (c.image_uris) return [c.image_uris[size] || c.image_uris.normal];
    return (c.card_faces || []).map((f) => f.image_uris && (f.image_uris[size] || f.image_uris.normal)).filter(Boolean);
  }

  const money = (n) => (n == null ? "" : "$" + n.toFixed(2));
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  const dollars = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // USD value of every copy owned, pricing each finish separately (falling back to another finish's price).
  function ownedValue(c) {
    const p = c.prices || {};
    const price = (...keys) => { for (const k of keys) if (p[k]) return parseFloat(p[k]); return 0; };
    const nonfoil = c.owned.qty - c.owned.foil - c.owned.etched;
    return nonfoil * price("usd", "usd_foil", "usd_etched")
      + c.owned.foil * price("usd_foil", "usd", "usd_etched")
      + c.owned.etched * price("usd_etched", "usd_foil", "usd");
  }
  const totalValue = all.reduce((n, c) => n + ownedValue(c), 0);

  // ---------- search ----------

  function run() {
    const compiled = Search.compile(state.query);
    const order = compiled.order || state.sort;
    const dir = compiled.dir || state.dir || Search.SORTS[order].dir;
    state.effectiveDir = dir;
    const filterTest = Filters.predicate();
    state.results = Search.sortCards(all.filter((c) => compiled.test(c) && filterTest(c)), order, dir);
    const nFilters = Filters.activeCount();
    els.filterCount.textContent = nFilters || "";
    els.filterClear.hidden = !nFilters;

    els.sort.value = order;
    els.dir.textContent = dir === "desc" ? "↓ Desc" : "↑ Asc";
    els.warnings.innerHTML = compiled.warnings.map((w) => `<li>${esc(w)}</li>`).join("");

    const copies = state.results.reduce((n, c) => n + c.owned.qty, 0);
    els.status.textContent = state.results.length === all.length
      ? `${all.length.toLocaleString()} cards (${totalCopies.toLocaleString()} copies)`
      : `${state.results.length.toLocaleString()} of ${all.length.toLocaleString()} cards (${copies.toLocaleString()} copies) · ${dollars(state.results.reduce((n, c) => n + ownedValue(c), 0))}`;

    els.results.innerHTML = "";
    els.results.className = state.view;
    state.shown = 0;
    if (!state.results.length) {
      els.results.innerHTML = `<p class="empty">No cards match that search.</p>`;
    } else if (state.view === "list") {
      els.results.innerHTML = `<table class="list"><thead><tr>
        <th class="num">Qty</th><th>Name</th><th>Cost</th><th class="hide-sm">Type</th>
        <th>Set</th><th class="hide-sm">#</th><th class="hide-sm">Rarity</th><th class="num">Price</th>
      </tr></thead><tbody></tbody></table>`;
    }
    fill();
    syncUrl();
  }

  // Render pages until the sentinel is comfortably below the viewport.
  function fill() {
    while (state.shown < state.results.length && els.sentinel.getBoundingClientRect().top < innerHeight + 1200) renderMore();
  }

  function renderMore() {
    const batch = state.results.slice(state.shown, state.shown + PAGE_SIZE);
    const start = state.shown;
    state.shown += batch.length;
    if (state.view === "list") {
      els.results.querySelector("tbody").insertAdjacentHTML("beforeend", batch.map((c, i) => listRow(c, start + i)).join(""));
    } else {
      els.results.insertAdjacentHTML("beforeend", batch.map((c, i) => tile(c, start + i)).join(""));
    }
  }

  function tile(c, i) {
    const imgs = images(c, "normal");
    const img = imgs.length
      ? `<img loading="lazy" src="${esc(imgs[0])}" alt="${esc(c.name)}">`
      : `<span class="placeholder">${esc(c.name)}</span>`;
    const badges = [
      c.owned.qty > 1 ? `<span class="badge">×${c.owned.qty}</span>` : "",
      c.owned.foil ? `<span class="badge foil">${c.owned.foil < c.owned.qty ? c.owned.foil + " " : ""}Foil</span>` : "",
      c.owned.etched ? `<span class="badge foil">Etched</span>` : "",
    ].join("");
    return `<div class="tile" data-i="${i}">
      <button type="button" class="tile-img" title="${esc(c.name)}">${img}</button>
      <div class="badges">${badges}</div>
      ${imgs.length > 1 ? `<button type="button" class="flip" title="Flip card" aria-label="Flip card">⟲</button>` : ""}
    </div>`;
  }

  function listRow(c, i) {
    const cost = c.mana_cost || (c.card_faces || []).map((f) => f.mana_cost).filter(Boolean).join(" // ");
    return `<tr data-i="${i}">
      <td class="num">${c.owned.qty}</td>
      <td class="name">${esc(c.name)}${c.owned.foil ? `<span class="foil-dot">foil</span>` : ""}</td>
      <td>${symbols(cost)}</td>
      <td class="hide-sm">${esc(c.type_line || "")}</td>
      <td class="set" title="${esc(c.set_name)}">${esc(c.set)}</td>
      <td class="hide-sm">${esc(c.collector_number)}</td>
      <td class="hide-sm">${cap(c.rarity)}</td>
      <td class="num">${money(Search.ownedPrice(c, "usd"))}</td>
    </tr>`;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.query) p.set("q", state.query);
    if (state.sort !== "name") p.set("order", state.sort);
    if (state.dir) p.set("dir", state.dir);
    if (state.view !== "grid") p.set("view", state.view);
    Filters.writeParams(p);
    const qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }

  // ---------- card dialog ----------

  let openIndex = -1;

  function faceHtml(f, c) {
    const stats = f.power != null ? `${f.power}/${f.toughness}`
      : f.loyalty != null ? `Loyalty: ${f.loyalty}`
      : f.defense != null ? `Defense: ${f.defense}` : "";
    const oracle = (f.oracle_text || "").split("\n").map((line) => `<p>${symbols(line)}</p>`).join("");
    return `<section class="face">
      <h2><span>${esc(f.name)}</span><span>${symbols(f.mana_cost || "")}</span></h2>
      <div class="type">${esc(f.type_line || c.type_line || "")}</div>
      <div class="oracle">${oracle}</div>
      ${f.flavor_text ? `<p class="flavor">${esc(f.flavor_text)}</p>` : ""}
      ${stats ? `<p class="stats">${esc(stats)}</p>` : ""}
    </section>`;
  }

  function openCard(i, face = 0) {
    const c = state.results[i];
    if (!c) return;
    openIndex = i;
    const imgs = images(c, "large");
    const faces = c.card_faces && !c.oracle_text ? c.card_faces : [c];
    const finishes = [];
    const nonfoil = c.owned.qty - c.owned.foil - c.owned.etched;
    if (nonfoil) finishes.push(`${nonfoil} non-foil`);
    if (c.owned.foil) finishes.push(`${c.owned.foil} foil`);
    if (c.owned.etched) finishes.push(`${c.owned.etched} etched`);
    const p = c.prices || {};
    const prices = [["usd", "$"], ["usd_foil", "$", " foil"], ["usd_etched", "$", " etched"], ["eur", "€"], ["tix", "", " tix"]]
      .filter(([k]) => p[k]).map(([k, pre, post = ""]) => `${pre}${p[k]}${post}`).join(" · ");
    const legal = LEGAL_FORMATS.filter((f) => c.legalities[f])
      .map((f) => `<span class="${c.legalities[f]}" title="${c.legalities[f]}">${cap(f)}${c.legalities[f] === "legal" ? "" : " (" + c.legalities[f] + ")"}</span>`).join("");

    els.dialog.querySelector(".dlg-img").innerHTML = imgs.length
      ? `<img src="${esc(imgs[face % imgs.length])}" alt="${esc(c.name)}">${imgs.length > 1 ? `<button type="button" class="flip" data-flip="${face + 1}" title="Flip card" aria-label="Flip card">⟲</button>` : ""}`
      : "";
    els.dialog.querySelector(".dlg-info").innerHTML = `
      ${faces.map((f) => faceHtml(f, c)).join("")}
      <dl class="meta">
        <dt>Set</dt><dd>${esc(c.set_name)} (${esc(c.set.toUpperCase())}) #${esc(c.collector_number)} · ${cap(c.rarity)}</dd>
        <dt>Owned</dt><dd>${c.owned.qty} (${finishes.join(", ")})</dd>
        ${c.artist ? `<dt>Artist</dt><dd>${esc(c.artist)}</dd>` : ""}
        ${prices ? `<dt>Price</dt><dd>${esc(prices)}</dd>` : ""}
        ${legal ? `<dt>Legal</dt><dd class="legal">${legal}</dd>` : ""}
      </dl>
      <div class="dlg-nav">
        <button type="button" class="ghost" data-step="-1" ${i === 0 ? "disabled" : ""}>← Prev</button>
        <a href="${esc((c.scryfall_uri || "").replace(/\?utm_source=api$/, ""))}" target="_blank" rel="noopener">View on Scryfall ↗</a>
        <button type="button" class="ghost" data-step="1" ${i === state.results.length - 1 ? "disabled" : ""}>Next →</button>
      </div>`;
    if (!els.dialog.open) els.dialog.showModal();
  }

  // ---------- events ----------

  let debounce;
  els.q.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.query = els.q.value; run(); }, 150);
  });
  els.sort.addEventListener("change", () => { state.sort = els.sort.value; state.dir = null; run(); });
  els.dir.addEventListener("click", () => { state.dir = state.effectiveDir === "asc" ? "desc" : "asc"; run(); });
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    run();
  }));
  document.querySelectorAll(".ex").forEach((b) => b.addEventListener("click", () => {
    els.q.value = state.query = b.textContent;
    b.closest("details").open = false;
    run();
  }));

  els.results.addEventListener("click", (e) => {
    const host = e.target.closest("[data-i]");
    if (!host) return;
    const i = +host.dataset.i;
    if (e.target.closest(".flip")) {
      const img = host.querySelector("img");
      const imgs = images(state.results[i], "normal");
      const next = (imgs.indexOf(img.getAttribute("src")) + 1) % imgs.length;
      img.src = imgs[next];
      return;
    }
    openCard(i);
  });

  els.dialog.addEventListener("click", (e) => {
    if (e.target === els.dialog || e.target.closest("[data-close]")) return els.dialog.close();
    const flip = e.target.closest("[data-flip]");
    if (flip) return openCard(openIndex, +flip.dataset.flip);
    const step = e.target.closest("[data-step]");
    if (step) openCard(openIndex + +step.dataset.step);
  });

  document.addEventListener("keydown", (e) => {
    if (els.dialog.open) {
      if (e.key === "ArrowRight") openCard(openIndex + 1);
      if (e.key === "ArrowLeft") openCard(openIndex - 1);
      return;
    }
    if (e.key === "/" && document.activeElement !== els.q) { e.preventDefault(); els.q.focus(); }
  });

  // Hover preview of the card image in list view (desktop only).
  els.results.addEventListener("mousemove", (e) => {
    const row = state.view === "list" && e.target.closest("tr[data-i]");
    if (!row || !matchMedia("(hover: hover)").matches) { els.preview.style.display = "none"; return; }
    const src = images(state.results[+row.dataset.i], "normal")[0];
    if (!src) return;
    if (els.preview.dataset.src !== src) {
      els.preview.innerHTML = `<img src="${esc(src)}" alt="">`;
      els.preview.dataset.src = src;
    }
    const w = 244, h = 340;
    const x = e.clientX + 24 + w > innerWidth ? e.clientX - w - 24 : e.clientX + 24;
    els.preview.style.left = x + "px";
    els.preview.style.top = Math.min(e.clientY - 40, innerHeight - h - 10) + "px";
    els.preview.style.display = "block";
  });
  els.results.addEventListener("mouseleave", () => { els.preview.style.display = "none"; });

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) fill();
  }, { rootMargin: "1200px" }).observe(els.sentinel);

  // ---------- start ----------

  $("#total").innerHTML = `Total value <strong>${dollars(totalValue)}</strong>`;
  if (data.generated) {
    const day = (d) => new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    $("#updated").textContent = `Collection updated ${day(data.generated)}.`
      + (data.prices_updated ? ` Prices updated ${day(data.prices_updated)} (highest of TCGplayer, Card Kingdom and MTGGoldfish).` : "");
  }
  const filters = Filters.init({ container: $("#filters-body"), cards: all, params, onChange: () => run() });
  els.filterClear.addEventListener("click", (e) => { e.preventDefault(); filters.clear(); });
  // Start with the panel collapsed on phones unless the link already has filters applied.
  if (matchMedia("(max-width: 700px)").matches && !Filters.activeCount()) els.filters.open = false;

  els.q.value = state.query;
  document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x.dataset.view === state.view));
  run();
})();
