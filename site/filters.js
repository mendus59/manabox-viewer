// Point-and-click filters shown above the results. They combine (AND) with the search box.
(function () {
  "use strict";

  const SYMBOL = (s) => `https://svgs.scryfall.io/card-symbols/${s}.svg`;
  const COLORS = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["C", "Colorless"]];
  const TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land", "Battle", "Legendary"];
  const MANA_VALUES = ["0", "1", "2", "3", "4", "5", "6", "7+"];
  const RARITIES = [["common", "Common"], ["uncommon", "Uncommon"], ["rare", "Rare"], ["mythic", "Mythic"], ["special", "Special"], ["bonus", "Bonus"]];
  const FORMATS = ["commander", "standard", "pioneer", "modern", "legacy", "vintage", "pauper", "brawl", "historic", "timeless", "oathbreaker", "paupercommander", "premodern", "oldschool"];
  const FORMAT_LABELS = { paupercommander: "Pauper Commander", oldschool: "Old School" };
  const COLOR_MODES = [["include", "Including"], ["exact", "Exactly"], ["atmost", "At most"]];

  const state = {
    colors: new Set(), colorMode: "include",
    identity: new Set(), identityMode: "atmost",
    types: new Set(), typeMode: "any",
    subtype: "", set: "",
    mv: new Set(), rarity: new Set(),
    format: "", finish: "",
    priceMin: "", priceMax: "",
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  // Split type lines ("Legendary Creature — Elf Druid // Land") into type words and subtypes.
  function prepareTypes(c) {
    const lines = (c.card_faces || []).map((f) => f.type_line).filter(Boolean);
    if (!lines.length) lines.push(...(c.type_line || "").split(" // "));
    const types = new Set(), subtypes = new Set();
    for (const line of lines) {
      const [left, right] = line.split("—");
      left.trim().split(/\s+/).forEach((w) => w && types.add(w.toLowerCase()));
      (right || "").trim().split(/\s+/).forEach((w) => w && subtypes.add(w));
    }
    c._f = { types, subtypes: new Set([...subtypes].map((s) => s.toLowerCase())), subtypeNames: subtypes };
  }

  function colorTest(selected, mode, getSet) {
    if (!selected.size) return null;
    const want = new Set([...selected].filter((x) => x !== "C"));
    return (c) => {
      const have = getSet(c);
      if (!want.size) return have.size === 0; // only "Colorless" picked
      const superset = [...want].every((x) => have.has(x));
      const subset = [...have].every((x) => want.has(x));
      if (mode === "exact") return superset && subset;
      if (mode === "atmost") return subset;
      return superset;
    };
  }

  function predicate() {
    const tests = [
      colorTest(state.colors, state.colorMode, (c) => c._s.colors),
      colorTest(state.identity, state.identityMode, (c) => c._s.identity),
    ];
    if (state.types.size) {
      const types = [...state.types];
      tests.push(state.typeMode === "all"
        ? (c) => types.every((t) => c._f.types.has(t))
        : (c) => types.some((t) => c._f.types.has(t)));
    }
    if (state.subtype) {
      const st = state.subtype.trim().toLowerCase();
      tests.push((c) => c._f.subtypes.has(st));
    }
    if (state.set) tests.push((c) => c.set === state.set);
    if (state.mv.size) {
      tests.push((c) => {
        const mv = Math.floor(c.cmc || 0);
        return state.mv.has(mv >= 7 ? "7+" : String(mv));
      });
    }
    if (state.rarity.size) tests.push((c) => state.rarity.has(c.rarity));
    if (state.format) tests.push((c) => ["legal", "restricted"].includes(c.legalities[state.format]));
    if (state.finish === "foil") tests.push((c) => c.owned.foil + c.owned.etched > 0);
    if (state.finish === "nonfoil") tests.push((c) => c.owned.qty > c.owned.foil + c.owned.etched);
    const min = parseFloat(state.priceMin), max = parseFloat(state.priceMax);
    if (!Number.isNaN(min) || !Number.isNaN(max)) {
      tests.push((c) => {
        const p = Search.ownedPrice(c, "usd");
        return p != null && (Number.isNaN(min) || p >= min) && (Number.isNaN(max) || p <= max);
      });
    }
    const active = tests.filter(Boolean);
    return active.length ? (c) => active.every((t) => t(c)) : () => true;
  }

  function activeCount() {
    return [state.colors.size, state.identity.size, state.types.size, state.subtype, state.set, state.mv.size,
      state.rarity.size, state.format, state.finish, state.priceMin || state.priceMax].filter(Boolean).length;
  }

  // ---------- URL params ----------

  const SET_PARAMS = { colors: "fc", identity: "fi", types: "ft", mv: "fmv", rarity: "fr" };
  const VALUE_PARAMS = {
    colorMode: "fcm", identityMode: "fim", typeMode: "ftm", subtype: "fst", set: "fs",
    format: "ffmt", finish: "ff", priceMin: "pmin", priceMax: "pmax",
  };
  const DEFAULTS = { colorMode: "include", identityMode: "atmost", typeMode: "any" };

  function readParams(p) {
    for (const [k, name] of Object.entries(SET_PARAMS)) {
      const v = p.get(name);
      const values = v ? v.split(",").filter(Boolean) : [];
      // Colors are stored as uppercase symbols, everything else lowercase.
      state[k] = new Set(values.map((x) => (k === "colors" || k === "identity" ? x.toUpperCase() : x.toLowerCase())));
    }
    for (const [k, name] of Object.entries(VALUE_PARAMS)) state[k] = p.get(name) || DEFAULTS[k] || "";
  }

  function writeParams(p) {
    for (const [k, name] of Object.entries(SET_PARAMS)) if (state[k].size) p.set(name, [...state[k]].join(","));
    for (const [k, name] of Object.entries(VALUE_PARAMS)) if (state[k] && state[k] !== DEFAULTS[k]) p.set(name, state[k]);
  }

  // ---------- UI ----------

  const chip = (group, value, label, title) =>
    `<button type="button" class="chip${state[group].has(value) ? " on" : ""}" data-group="${group}" data-value="${esc(value)}"
      aria-pressed="${state[group].has(value)}"${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
  const select = (field, options) =>
    `<select data-field="${field}">${options.map(([v, l]) => `<option value="${esc(v)}"${state[field] === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const colorChips = (group) => COLORS.map(([s, name]) =>
    chip(group, s, `<img class="sym" src="${SYMBOL(s)}" alt="${name}">`, name)).join("");

  function render(container, cards) {
    const sets = new Map(), subtypes = new Map(), rarities = new Set();
    for (const c of cards) {
      const s = sets.get(c.set) || { name: c.set_name, n: 0 };
      s.n++;
      sets.set(c.set, s);
      c._f.subtypeNames.forEach((t) => subtypes.set(t, (subtypes.get(t) || 0) + 1));
      rarities.add(c.rarity);
    }
    const setOptions = [["", "All sets"], ...[...sets].sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([code, s]) => [code, `${s.name} (${code.toUpperCase()}) · ${s.n}`])];
    const subtypeOptions = [...subtypes].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, n]) => `<option value="${esc(t)}">${n} card${n === 1 ? "" : "s"}</option>`).join("");

    container.innerHTML = `
      <div class="fgroup">
        <div class="fhead"><span>Color</span>${select("colorMode", COLOR_MODES)}</div>
        <div class="chips">${colorChips("colors")}</div>
      </div>
      <div class="fgroup">
        <div class="fhead"><span>Color identity</span>${select("identityMode", COLOR_MODES)}</div>
        <div class="chips">${colorChips("identity")}</div>
      </div>
      <div class="fgroup">
        <div class="fhead"><span>Mana value</span></div>
        <div class="chips">${MANA_VALUES.map((v) => chip("mv", v, v)).join("")}</div>
      </div>
      <div class="fgroup wide">
        <div class="fhead"><span>Type</span>${select("typeMode", [["any", "Any of"], ["all", "All of"]])}</div>
        <div class="chips">${TYPES.map((t) => chip("types", t.toLowerCase(), t)).join("")}</div>
      </div>
      <div class="fgroup">
        <div class="fhead"><label for="f-subtype">Subtype</label></div>
        <input id="f-subtype" type="search" list="f-subtypes" data-field="subtype" value="${esc(state.subtype)}" placeholder="e.g. Elf, Equipment, Saga" autocomplete="off">
        <datalist id="f-subtypes">${subtypeOptions}</datalist>
      </div>
      <div class="fgroup">
        <div class="fhead"><span>Set</span></div>
        ${select("set", setOptions)}
      </div>
      <div class="fgroup">
        <div class="fhead"><span>Rarity</span></div>
        <div class="chips">${RARITIES.filter(([r]) => rarities.has(r)).map(([r, l]) => chip("rarity", r, l)).join("")}</div>
      </div>
      <div class="fgroup">
        <div class="fhead"><span>Legal in</span></div>
        ${select("format", [["", "Any format"], ...FORMATS.map((f) => [f, FORMAT_LABELS[f] || cap(f)])])}
      </div>
      <div class="fgroup">
        <div class="fhead"><span>Finish</span></div>
        ${select("finish", [["", "Foil and non-foil"], ["foil", "Foil only"], ["nonfoil", "Non-foil only"]])}
      </div>
      <div class="fgroup">
        <div class="fhead"><span>Price (USD)</span></div>
        <div class="range">
          <input type="number" min="0" step="0.5" inputmode="decimal" data-field="priceMin" value="${esc(state.priceMin)}" placeholder="Min" aria-label="Minimum price">
          <span>–</span>
          <input type="number" min="0" step="0.5" inputmode="decimal" data-field="priceMax" value="${esc(state.priceMax)}" placeholder="Max" aria-label="Maximum price">
        </div>
      </div>`;
  }

  function init({ container, cards, params, onChange }) {
    cards.forEach(prepareTypes);
    readParams(params);
    render(container, cards);

    container.addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      const set = state[b.dataset.group];
      const v = b.dataset.value;
      set.has(v) ? set.delete(v) : set.add(v);
      b.classList.toggle("on", set.has(v));
      b.setAttribute("aria-pressed", set.has(v));
      onChange();
    });
    let debounce;
    const onField = (e) => {
      const field = e.target.dataset.field;
      if (!field) return;
      state[field] = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(onChange, e.target.tagName === "SELECT" ? 0 : 150);
    };
    container.addEventListener("input", onField);
    container.addEventListener("change", onField);

    return {
      clear() {
        readParams(new URLSearchParams());
        render(container, cards);
        onChange();
      },
    };
  }

  window.Filters = { init, predicate, activeCount, writeParams };
})();
