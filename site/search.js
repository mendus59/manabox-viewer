// Scryfall-style search syntax, evaluated locally against the collection.
// Reference: https://scryfall.com/docs/syntax
(function () {
  "use strict";

  const WUBRG = "WUBRG";
  const COLOR_NAMES = {
    white: "W", blue: "U", black: "B", red: "R", green: "G",
    azorius: "WU", dimir: "UB", rakdos: "BR", gruul: "RG", selesnya: "GW",
    orzhov: "WB", izzet: "UR", golgari: "BG", boros: "RW", simic: "GU",
    silverquill: "WB", prismari: "UR", witherbloom: "BG", lorehold: "RW", quandrix: "GU",
    bant: "GWU", esper: "WUB", grixis: "UBR", jund: "BRG", naya: "RGW",
    abzan: "WBG", jeskai: "URW", sultai: "BGU", mardu: "RWB", temur: "GUR",
    yore: "WUBR", glint: "UBRG", dune: "WBRG", ink: "WURG", witch: "WUBG",
  };
  const RARITY = { common: 0, c: 0, uncommon: 1, u: 1, rare: 2, r: 2, special: 3, s: 3, mythic: 4, m: 4, bonus: 5, b: 5 };
  const FORMAT_ALIASES = { edh: "commander", std: "standard", pdh: "paupercommander", penny: "penny", pennydreadful: "penny" };
  const PERMANENT_TYPES = ["artifact", "creature", "enchantment", "land", "planeswalker", "battle"];

  const ALIASES = {
    name: "name",
    c: "color", color: "color", colors: "color",
    id: "identity", identity: "identity", ci: "identity", commander: "identity",
    t: "type", type: "type",
    o: "oracle", oracle: "oracle", fo: "fulloracle", fulloracle: "fulloracle",
    kw: "keyword", keyword: "keyword", keywords: "keyword",
    m: "mana", mana: "mana",
    mv: "mv", cmc: "mv", manavalue: "mv",
    pow: "power", power: "power", tou: "toughness", toughness: "toughness",
    loy: "loyalty", loyalty: "loyalty", def: "defense", defense: "defense",
    pt: "pt", powtou: "pt",
    r: "rarity", rarity: "rarity",
    s: "set", e: "set", set: "set", edition: "set",
    cn: "number", number: "number",
    st: "settype", settype: "settype",
    f: "format", format: "format", legal: "format", banned: "banned", restricted: "restricted",
    a: "artist", artist: "artist",
    ft: "flavor", flavor: "flavor",
    wm: "watermark", watermark: "watermark",
    border: "border", frame: "frame",
    lang: "lang", language: "lang",
    year: "year", date: "date",
    usd: "usd", eur: "eur", tix: "tix",
    game: "game", produces: "produces",
    is: "is", not: "not", has: "has",
    order: "order", direction: "direction", dir: "direction",
    qty: "qty", quantity: "qty", owned: "qty", copies: "qty",
    // Accepted for compatibility with pasted Scryfall queries but have no effect here.
    unique: "ignore", include: "ignore", display: "ignore", prefer: "ignore",
  };

  // ---------- helpers ----------

  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function compareNum(a, op, b) {
    switch (op) {
      case ":": case "=": return a === b;
      case "!=": return a !== b;
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
    }
    return false;
  }

  function statNumber(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/\*/g, "0"));
    return Number.isNaN(n) ? null : n;
  }

  // Set comparison used for colors, identity and produced mana.
  function compareSets(card, query, op) {
    const subset = [...card].every((x) => query.has(x));
    const superset = [...query].every((x) => card.has(x));
    switch (op) {
      case ":": case ">=": return superset;
      case ">": return superset && card.size > query.size;
      case "<=": return subset;
      case "<": return subset && card.size < query.size;
      case "=": return subset && superset;
      case "!=": return !(subset && superset);
    }
    return false;
  }

  function parseColorValue(value, allowColorlessMana) {
    const v = norm(value);
    if (COLOR_NAMES[v]) return { set: new Set(COLOR_NAMES[v]) };
    if (v === "colorless" || (v === "c" && !allowColorlessMana)) return { colorless: true };
    if (v === "m" || v === "multicolor" || v === "multi") return { multicolor: true };
    if (/^\d+$/.test(v)) return { count: parseInt(v, 10) };
    const letters = allowColorlessMana ? /^[wubrgc]+$/ : /^[wubrg]+$/;
    if (letters.test(v)) return { set: new Set(v.toUpperCase()) };
    return null;
  }

  function colorPredicate(getSet, value, op, ctx, label, identity, allowColorlessMana) {
    const q = parseColorValue(value, allowColorlessMana);
    if (!q) return ctx.unknown(`${label}:${value}`, `"${value}" isn't a color`);
    // For identity, ":" means "fits within" (e.g. id:esper finds cards for an Esper deck).
    const effOp = identity && op === ":" ? "<=" : op;
    if (q.colorless) return (c) => (op === "!=" ? getSet(c).size > 0 : getSet(c).size === 0);
    if (q.multicolor) return (c) => (op === "!=" ? getSet(c).size <= 1 : getSet(c).size > 1);
    if (q.count != null) return (c) => compareNum(getSet(c).size, op === ":" ? "=" : op, q.count);
    return (c) => compareSets(getSet(c), q.set, effOp);
  }

  function textPredicate(value, regex, ctx, getTexts) {
    if (regex) {
      let re;
      try { re = new RegExp(value, "im"); } catch (e) { return ctx.unknown(`/${value}/`, "invalid regular expression"); }
      return (c) => getTexts(c).some((t) => re.test(t));
    }
    const v = norm(value);
    if (v.includes("~")) {
      return (c) => {
        const vv = v.replace(/~/g, c._s.names[1] || c._s.names[0]);
        return getTexts(c).some((t) => t.includes(vv));
      };
    }
    return (c) => getTexts(c).some((t) => t.includes(v));
  }

  // Mana costs are compared as multisets of symbols: m:{G}{G} matches any cost with at least two {G}.
  function manaSymbols(cost) {
    const out = {};
    for (const m of (cost || "").matchAll(/\{([^}]+)\}/g)) {
      const s = m[1].toUpperCase();
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  }
  function parseManaQuery(value) {
    if (value.includes("{")) return manaSymbols(value);
    const out = {};
    for (const m of value.toUpperCase().matchAll(/\d+|[A-Z](?:\/[A-Z])?/g)) out[m[0]] = (out[m[0]] || 0) + 1;
    return out;
  }
  function containsSymbols(a, b) {
    return Object.keys(b).every((k) => (a[k] || 0) >= b[k]);
  }

  // Values for numeric card stats, optionally comparing one stat against another (e.g. pow>tou).
  const STAT_GETTERS = {
    power: (c) => c._s.pow,
    toughness: (c) => c._s.tou,
    loyalty: (c) => c._s.loy,
    defense: (c) => c._s.def,
    mv: (c) => [c.cmc || 0],
    pt: (c) => c._s.pow.map((p, i) => p + (c._s.tou[i] ?? 0)),
  };

  function statPredicate(key, value, op, ctx) {
    const get = STAT_GETTERS[key];
    const v = norm(value);
    if (key === "mv" && (v === "even" || v === "odd")) {
      return (c) => Number.isInteger(c.cmc || 0) && ((c.cmc || 0) % 2 === 0) === (v === "even");
    }
    const other = ALIASES[v] && STAT_GETTERS[ALIASES[v]];
    if (other) return (c) => get(c).some((a) => other(c).some((b) => compareNum(a, op, b)));
    const n = parseFloat(v);
    if (Number.isNaN(n)) return ctx.unknown(`${key}:${value}`, `"${value}" isn't a number`);
    return (c) => get(c).some((a) => compareNum(a, op, n));
  }

  function ownedPrice(c, currency) {
    const p = c.prices || {};
    if (currency === "tix") return p.tix ? parseFloat(p.tix) : null;
    const ownsNonfoil = c.owned.qty > c.owned.foil + c.owned.etched;
    const order = currency === "eur"
      ? (ownsNonfoil ? ["eur", "eur_foil"] : ["eur_foil", "eur"])
      : (ownsNonfoil ? ["usd", "usd_foil", "usd_etched"] : c.owned.etched ? ["usd_etched", "usd_foil", "usd"] : ["usd_foil", "usd", "usd_etched"]);
    for (const k of order) if (p[k]) return parseFloat(p[k]);
    return null;
  }

  // ---------- is: / has: ----------

  function isPredicate(value, ctx) {
    const v = norm(value);
    const typeHas = (c, t) => c._s.type.includes(t);
    const simple = {
      foil: (c) => c.owned.foil > 0,
      nonfoil: (c) => c.owned.qty > c.owned.foil + c.owned.etched,
      etched: (c) => c.owned.etched > 0,
      commander: (c) => (typeHas(c, "legendary") && (typeHas(c, "creature") || typeHas(c, "background")))
        || c._s.oracle.includes("can be your commander"),
      spell: (c) => !typeHas(c, "land"),
      permanent: (c) => PERMANENT_TYPES.some((t) => typeHas(c, t)),
      historic: (c) => typeHas(c, "legendary") || typeHas(c, "artifact") || typeHas(c, "saga"),
      vanilla: (c) => typeHas(c, "creature") && !c._s.oracle.trim(),
      bear: (c) => typeHas(c, "creature") && c.cmc === 2 && c.power === "2" && c.toughness === "2",
      modal: (c) => /choose (one|two|three|four|any number|up to)/.test(c._s.oracle),
      dfc: (c) => ["transform", "modal_dfc", "meld", "reversible_card"].includes(c.layout),
      mdfc: (c) => c.layout === "modal_dfc",
      tdfc: (c) => c.layout === "transform",
      hybrid: (c) => /\{[^}]*\/[^}]*\}/.test(c._s.mana) && !/\/P\}/i.test(c._s.mana),
      phyrexian: (c) => /\/?P\}/i.test(c._s.mana) || /\{P\}/i.test(c._s.mana),
      reprint: (c) => !!c.reprint,
      promo: (c) => !!c.promo,
      fullart: (c) => !!c.full_art,
      textless: (c) => !!c.textless,
      reserved: (c) => !!c.reserved,
      digital: (c) => !!c.digital,
      gamechanger: (c) => !!c.game_changer,
      funny: (c) => c.set_type === "funny",
      borderless: (c) => c.border_color === "borderless",
      showcase: (c) => (c.frame_effects || []).includes("showcase"),
      extendedart: (c) => (c.frame_effects || []).includes("extendedart"),
      legendary: (c) => typeHas(c, "legendary"),
      token: (c) => c.layout === "token" || typeHas(c, "token"),
    };
    if (simple[v]) return simple[v];
    // Fall back to matching a layout, frame effect, promo type or finish (is:split, is:adventure, is:galaxyfoil...).
    return (c) => c.layout === v || (c.frame_effects || []).includes(v)
      || (c.promo_types || []).includes(v) || (c.finishes || []).includes(v);
  }

  function hasPredicate(value, ctx) {
    const v = norm(value);
    const fields = { watermark: "watermark", flavor: "flavor_text", indicator: "color_indicator" };
    const field = fields[v];
    if (!field) return ctx.unknown(`has:${value}`, `"has:${value}" isn't supported`);
    return (c) => !!c[field] || (c.card_faces || []).some((f) => !!f[field]);
  }

  // ---------- terms ----------

  function compileTerm(tk, ctx) {
    const { op, value, regex } = tk;

    if (tk.key == null) {
      if (tk.exact) {
        const v = norm(value);
        return (c) => c._s.names.includes(v);
      }
      return textPredicate(value, regex, ctx, (c) => c._s.names);
    }

    const key = ALIASES[tk.key];
    if (!key) return ctx.unknown(`${tk.key}${op}${value}`, `unknown keyword "${tk.key}"`);

    switch (key) {
      case "ignore": return null;
      case "name":
        if (op === "=" && !regex) { const v = norm(value); return (c) => c._s.names.includes(v); }
        return textPredicate(value, regex, ctx, (c) => c._s.names);
      case "color": return colorPredicate((c) => c._s.colors, value, op, ctx, "c", false, false);
      case "identity": return colorPredicate((c) => c._s.identity, value, op, ctx, "id", true, false);
      case "produces": return colorPredicate((c) => c._s.produces, value, op, ctx, "produces", false, true);
      case "type": return textPredicate(value, regex, ctx, (c) => [c._s.type]);
      case "oracle": return textPredicate(value, regex, ctx, (c) => [c._s.oracleNoReminder]);
      case "fulloracle": return textPredicate(value, regex, ctx, (c) => [c._s.oracle]);
      case "flavor": return textPredicate(value, regex, ctx, (c) => [c._s.flavor]);
      case "artist": return textPredicate(value, regex, ctx, (c) => c._s.artists);
      case "watermark": return textPredicate(value, regex, ctx, (c) => c._s.watermarks);
      case "keyword": return textPredicate(value, regex, ctx, (c) => c._s.keywords);
      case "mana": {
        const q = parseManaQuery(value);
        return (c) => {
          const have = c._s.manaSymbols;
          const sup = containsSymbols(have, q), sub = containsSymbols(q, have);
          switch (op) {
            case ":": case ">=": return sup;
            case ">": return sup && !sub;
            case "<=": return sub;
            case "<": return sub && !sup;
            case "=": return sup && sub;
            case "!=": return !(sup && sub);
          }
          return false;
        };
      }
      case "mv": case "power": case "toughness": case "loyalty": case "defense": case "pt":
        return statPredicate(key, value, op, ctx);
      case "rarity": {
        const r = RARITY[norm(value)];
        if (r == null) return ctx.unknown(`r:${value}`, `"${value}" isn't a rarity`);
        return (c) => compareNum(RARITY[c.rarity], op, r);
      }
      case "set": {
        const v = norm(value);
        return (c) => (op === "!=" ? c.set !== v : c.set === v);
      }
      case "settype": { const v = norm(value); return (c) => c.set_type === v; }
      case "number": {
        const n = parseInt(value, 10);
        if ((op === ":" || op === "=" || op === "!=") && String(n) !== value.trim()) {
          const v = norm(value);
          return (c) => (c.collector_number.toLowerCase() === v) !== (op === "!=");
        }
        return (c) => compareNum(parseInt(c.collector_number, 10), op, n);
      }
      case "format": case "banned": case "restricted": {
        const v = norm(value);
        const fmt = FORMAT_ALIASES[v] || v;
        if (key === "format") return (c) => ["legal", "restricted"].includes(c.legalities[fmt]);
        return (c) => c.legalities[fmt] === key;
      }
      case "border": { const v = norm(value); return (c) => c.border_color === v; }
      case "frame": { const v = norm(value); return (c) => c.frame === v || (c.frame_effects || []).includes(v); }
      case "lang": { const v = norm(value); return (c) => v === "any" || c.lang === v; }
      case "game": { const v = norm(value); return (c) => (c.games || []).includes(v); }
      case "year": {
        const y = parseInt(value, 10);
        if (Number.isNaN(y)) return ctx.unknown(`year:${value}`, `"${value}" isn't a year`);
        return (c) => compareNum(parseInt((c.released_at || "0").slice(0, 4), 10), op, y);
      }
      case "date": {
        const v = value.trim();
        return (c) => {
          const d = c.released_at || "";
          if (op === ":" || op === "=") return d.startsWith(v);
          if (op === "!=") return !d.startsWith(v);
          return compareNum(d, op, v);
        };
      }
      case "usd": case "eur": case "tix": {
        const n = parseFloat(value);
        if (Number.isNaN(n)) return ctx.unknown(`${key}:${value}`, `"${value}" isn't a price`);
        return (c) => { const p = ownedPrice(c, key); return p != null && compareNum(p, op, n); };
      }
      case "qty": {
        const n = parseInt(value, 10);
        if (Number.isNaN(n)) return ctx.unknown(`qty:${value}`, `"${value}" isn't a number`);
        return (c) => compareNum(c.owned.qty, op, n);
      }
      case "is": return isPredicate(value, ctx);
      case "not": { const p = isPredicate(value, ctx); return p && ((c) => !p(c)); }
      case "has": return hasPredicate(value, ctx);
      case "order": {
        const v = norm(value);
        if (!SORTS[ORDER_ALIASES[v] || v]) return ctx.unknown(`order:${value}`, `can't sort by "${value}"`);
        ctx.order = ORDER_ALIASES[v] || v;
        return null;
      }
      case "direction": {
        const v = norm(value);
        if (v === "asc" || v === "desc") ctx.dir = v;
        return null;
      }
    }
    return null;
  }

  // ---------- tokenizer & parser ----------

  function tokenize(q) {
    const tokens = [];
    const n = q.length;
    let i = 0;
    const isSpace = (ch) => /\s/.test(ch);
    const readQuoted = () => {
      let s = "";
      i++; // opening quote
      while (i < n && q[i] !== '"') {
        if (q[i] === "\\" && q[i + 1] === '"') i++;
        s += q[i++];
      }
      i++; // closing quote
      return s;
    };
    const readRegex = () => {
      let s = "";
      i++;
      while (i < n && q[i] !== "/") {
        if (q[i] === "\\" && i + 1 < n) s += q[i++];
        s += q[i++];
      }
      i++;
      return s;
    };
    const readWord = () => {
      const start = i;
      while (i < n && !isSpace(q[i]) && q[i] !== ")") i++;
      return q.slice(start, i);
    };

    while (i < n) {
      const ch = q[i];
      if (isSpace(ch)) { i++; continue; }
      if (ch === "(" || ch === ")") { tokens.push({ t: ch }); i++; continue; }
      if (ch === "-" && i + 1 < n && !isSpace(q[i + 1])) { tokens.push({ t: "-" }); i++; continue; }

      if (ch === "!") {
        i++;
        const value = q[i] === '"' ? readQuoted() : readWord();
        if (value) tokens.push({ t: "term", key: null, op: ":", value, exact: true });
        continue;
      }
      if (ch === '"') { tokens.push({ t: "term", key: null, op: ":", value: readQuoted() }); continue; }

      const m = /^([a-zA-Z_]+)(!=|>=|<=|:|=|<|>)/.exec(q.slice(i));
      if (m) {
        i += m[0].length;
        let value, regex = false;
        if (q[i] === '"') value = readQuoted();
        else if (q[i] === "/") { value = readRegex(); regex = true; }
        else value = readWord();
        tokens.push({ t: "term", key: m[1].toLowerCase(), op: m[2], value, regex });
        continue;
      }

      const word = readWord();
      if (/^(or|and)$/i.test(word)) tokens.push({ t: word.toLowerCase() });
      else if (word) tokens.push({ t: "term", key: null, op: ":", value: word });
    }
    return tokens;
  }

  const EMPTY = { type: "and", parts: [] };

  function parse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];

    function parseOr() {
      const parts = [parseAnd()];
      while (peek() && peek().t === "or") { pos++; parts.push(parseAnd()); }
      const nonEmpty = parts.filter((p) => !(p.type === "and" && p.parts.length === 0));
      if (nonEmpty.length === 0) return EMPTY;
      return nonEmpty.length === 1 ? nonEmpty[0] : { type: "or", parts: nonEmpty };
    }
    function parseAnd() {
      const parts = [];
      while (pos < tokens.length) {
        const tk = peek();
        if (tk.t === "or" || tk.t === ")") break;
        if (tk.t === "and") { pos++; continue; }
        parts.push(parseUnary());
      }
      return { type: "and", parts };
    }
    function parseUnary() {
      const tk = tokens[pos++];
      if (tk.t === "-") {
        const next = peek();
        if (!next || next.t === ")" || next.t === "or" || next.t === "and") return EMPTY;
        return { type: "not", node: parseUnary() };
      }
      if (tk.t === "(") {
        const node = parseOr();
        if (peek() && peek().t === ")") pos++;
        return node;
      }
      if (tk.t !== "term") return EMPTY;
      return { type: "term", tk };
    }

    const parts = [parseOr()];
    while (pos < tokens.length) { pos++; parts.push(parseOr()); } // skip stray ")"
    return parts.length === 1 ? parts[0] : { type: "and", parts };
  }

  function build(node, ctx) {
    switch (node.type) {
      case "term": return compileTerm(node.tk, ctx);
      case "not": {
        const p = build(node.node, ctx);
        return p && ((c) => !p(c));
      }
      case "and": {
        const ps = node.parts.map((p) => build(p, ctx)).filter(Boolean);
        if (ps.length === 0) return null;
        return (c) => ps.every((p) => p(c));
      }
      case "or": {
        const ps = node.parts.map((p) => build(p, ctx));
        if (ps.some((p) => !p)) return null; // an ignored branch matches everything
        return (c) => ps.some((p) => p(c));
      }
    }
    return null;
  }

  function compile(query) {
    const ctx = {
      warnings: [],
      order: null,
      dir: null,
      unknown(term, why) { this.warnings.push(`Ignored ${term}: ${why}`); return null; },
    };
    const pred = build(parse(tokenize(query || "")), ctx);
    return { test: pred || (() => true), order: ctx.order, dir: ctx.dir, warnings: ctx.warnings };
  }

  // ---------- sorting ----------

  const ORDER_ALIASES = { cmc: "mv", manavalue: "mv", pow: "power", tou: "toughness", price: "usd", date: "released", quantity: "qty" };
  const byNum = (get, missingLast = Infinity) => (a, b) => (get(a) ?? missingLast) - (get(b) ?? missingLast);
  function colorKey(c) {
    const n = c._s.colors.size;
    if (n === 1) return WUBRG.indexOf([...c._s.colors][0]);
    if (n > 1) return 5 + n / 10;
    return c._s.type.includes("land") ? 8 : 7;
  }
  const SORTS = {
    name: { cmp: (a, b) => a.name.localeCompare(b.name), dir: "asc" },
    set: {
      cmp: (a, b) => (a.released_at || "").localeCompare(b.released_at || "") || a.set.localeCompare(b.set)
        || (parseInt(a.collector_number, 10) - parseInt(b.collector_number, 10)) || a.collector_number.localeCompare(b.collector_number),
      dir: "asc",
    },
    released: { cmp: (a, b) => (a.released_at || "").localeCompare(b.released_at || ""), dir: "desc" },
    mv: { cmp: byNum((c) => c.cmc || 0), dir: "asc" },
    power: { cmp: byNum((c) => c._s.pow[0], -Infinity), dir: "desc" },
    toughness: { cmp: byNum((c) => c._s.tou[0], -Infinity), dir: "desc" },
    rarity: { cmp: byNum((c) => RARITY[c.rarity]), dir: "desc" },
    color: { cmp: byNum(colorKey), dir: "asc" },
    usd: { cmp: byNum((c) => ownedPrice(c, "usd"), -Infinity), dir: "desc" },
    eur: { cmp: byNum((c) => ownedPrice(c, "eur"), -Infinity), dir: "desc" },
    tix: { cmp: byNum((c) => ownedPrice(c, "tix"), -Infinity), dir: "desc" },
    edhrec: { cmp: byNum((c) => c.edhrec_rank), dir: "asc" },
    artist: { cmp: (a, b) => (a.artist || "").localeCompare(b.artist || ""), dir: "asc" },
    qty: { cmp: byNum((c) => c.owned.qty), dir: "desc" },
  };

  function sortCards(cards, order, dir) {
    const s = SORTS[order] || SORTS.name;
    const sign = (dir || s.dir) === "desc" ? -1 : 1;
    return cards.sort((a, b) => sign * s.cmp(a, b) || a.name.localeCompare(b.name));
  }

  // ---------- card preparation ----------

  // Precompute normalised search fields once per card so each search is cheap.
  function prepare(c) {
    const faces = c.card_faces || [];
    const all = faces.length ? faces : [c];
    const collect = (k) => all.map((f) => f[k] ?? c[k]).filter((v) => v != null && v !== "");
    const oracle = norm(faces.length ? faces.map((f) => f.oracle_text || "").join("\n") : c.oracle_text);
    const colors = new Set(c.colors || []);
    faces.forEach((f) => (f.colors || []).forEach((x) => colors.add(x)));
    const mana = c.mana_cost || faces.map((f) => f.mana_cost || "").join(" // ");
    c.owned = c.owned || { qty: 1, foil: 0, etched: 0 };
    c.legalities = c.legalities || {};
    c._s = {
      names: [...new Set([c.name, ...faces.map((f) => f.name)].map(norm))],
      type: norm(c.type_line || faces.map((f) => f.type_line).join(" // ")),
      oracle,
      oracleNoReminder: oracle.replace(/\([^)]*\)/g, ""),
      flavor: norm(collect("flavor_text").join("\n")),
      artists: [...new Set(collect("artist").map(norm))],
      watermarks: collect("watermark").map(norm),
      keywords: (c.keywords || []).map(norm),
      mana,
      manaSymbols: manaSymbols(mana),
      colors,
      identity: new Set(c.color_identity || []),
      produces: new Set(c.produced_mana || []),
      pow: collect("power").map(statNumber).filter((v) => v != null),
      tou: collect("toughness").map(statNumber).filter((v) => v != null),
      loy: collect("loyalty").map(statNumber).filter((v) => v != null),
      def: collect("defense").map(statNumber).filter((v) => v != null),
    };
    return c;
  }

  window.Search = { compile, prepare, sortCards, ownedPrice, SORTS };
})();
