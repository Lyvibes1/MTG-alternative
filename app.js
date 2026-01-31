const API = "https://api.scryfall.com";
const $ = (id) => document.getElementById(id);

const state = { results: [] };

function setStatus(msg) { $("status").textContent = msg; }
function setCardSearchStatus(msg) { $("cardSearchStatus").textContent = msg; }

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function normalizeName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseDecklist(text) {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.startsWith("#") && !l.startsWith("//"));

  return lines.map(line => {
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (m) return { qty: Number(m[1]), name: cleanCardName(m[2]), raw: line };
    return { qty: 1, name: cleanCardName(line), raw: line };
  });
}

function cleanCardName(s) {
  let name = String(s ?? "").trim();
  name = name.replace(/\s*\*F\*\s*$/i, "").trim();
  name = name.replace(/\s+\d+\s*$/i, "").trim();
  name = name.replace(/\s*\([A-Z0-9]{2,6}\)\s*$/i, "").trim();
  return name;
}

async function scryfallNamed(name) {
  const url = `${API}/cards/named?fuzzy=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Scryfall lookup failed for "${name}"`);
  return res.json();
}

// Fetch multiple pages until we have enough pool
async function scryfallSearchMany(q, maxCards = 160) {
  const out = [];
  let next = `${API}/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=usd&dir=asc`;

  while (next && out.length < maxCards) {
    const res = await fetch(next);
    if (!res.ok) throw new Error("Search failed");
    const data = await res.json();

    out.push(...(data.data || []));

    if (data.has_more && data.next_page) {
      next = data.next_page;
    } else {
      next = null;
    }
  }

  return out.slice(0, maxCards);
}

function pickUsdPrice(card) {
  const p = card?.prices || {};
  const candidates = [p.usd, p.usd_foil, p.usd_etched].filter(v => v && !isNaN(Number(v)));
  if (!candidates.length) return null;
  return Math.min(...candidates.map(Number));
}

function getCardImage(card) {
  if (card?.image_uris?.normal) return card.image_uris.normal;
  if (card?.card_faces?.[0]?.image_uris?.normal) return card.card_faces[0].image_uris.normal;
  return null;
}

function primaryTypeFamily(typeLine) {
  const t = (typeLine || "").toLowerCase();
  if (t.includes("creature")) return "creature";
  if (t.includes("instant")) return "instant";
  if (t.includes("sorcery")) return "sorcery";
  if (t.includes("enchantment")) return "enchantment";
  if (t.includes("artifact")) return "artifact";
  if (t.includes("planeswalker")) return "planeswalker";
  if (t.includes("land")) return "land";
  return "other";
}

function ciToQuery(ciArr) {
  if (!ciArr || ciArr.length === 0) return "id:c";
  return `id<=${ciArr.join("").toLowerCase()}`;
}

/* ---------------------------
   HARD "not the same card" protection
---------------------------- */

function isSameCardOrPrinting(target, cand) {
  if (!target || !cand) return false;
  if (target.oracle_id && cand.oracle_id && target.oracle_id === cand.oracle_id) return true;
  if (target.prints_search_uri && cand.prints_search_uri && target.prints_search_uri === cand.prints_search_uri) return true;
  if (normalizeName(target.name) === normalizeName(cand.name)) return true;
  return false;
}

/* ---------------------------
   TEXT SIMILARITY (reliable + fast)
---------------------------- */

const STOP = new Set([
  "the","a","an","and","or","to","of","in","on","for","with","without","from","into","until","as",
  "this","that","those","these","it","its","their","your","you","they","them","each","any","all",
  "at","by","is","are","was","were","be","been","being","if","then","may","can","cannot","can't",
  "have","has","had","do","does","did","when","whenever","where","while","during","after","before",
  "target","targets","player","players","opponent","opponents","creature","creatures","card","cards",
  "spell","spells","ability","abilities","control","controls","controlled","owner","owners",
  "battlefield","graveyard","library","hand","turn","end","step","phase","game",
  "until","end","of","your","next"
]);

function tokenizeOracle(card) {
  const text = String(card?.oracle_text || "")
    .toLowerCase()
    .replace(/[\(\)\[\]\{\},.;:!?]/g, " ");

  const tokens = text
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => t.length >= 4)
    .filter(t => !STOP.has(t))
    .filter(t => !/^\d+$/.test(t));

  // keep unique tokens for set overlap
  return new Set(tokens);
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union ? inter / union : 0;
}

function similarityScore(target, cand, tTokens) {
  const cTokens = tokenizeOracle(cand);
  const jac = jaccard(tTokens, cTokens); // 0..1

  let score = jac * 100;

  // Type-family bonus
  const tType = primaryTypeFamily(target.type_line);
  const cType = primaryTypeFamily(cand.type_line);
  if (tType === cType) score += 10;

  // MV closeness
  const tMV = target.cmc ?? null;
  const cMV = cand.cmc ?? null;
  if (tMV != null && cMV != null) score += Math.max(0, 10 - Math.abs(tMV - cMV) * 2);

  return score;
}

/* ---------------------------
   SUBSTITUTE FINDER (NEW — ALWAYS RETURNS)
   - broad pool filtered by price in query (usd<=cap, usd>0)
   - rank by oracle text similarity
---------------------------- */

async function findFunctionalSubstitutes(targetCard, {
  maxPrice = 10,
  maxResults = 12,
  excludeReserved = true
} = {}) {
  // Guard: ensure number
  maxPrice = Number(maxPrice);
  if (!isFinite(maxPrice) || maxPrice <= 0) maxPrice = 10;

  const ci = targetCard.color_identity || [];
  const ciPart = ciToQuery(ci);

  // IMPORTANT:
  // usd<=cap + usd>0 avoids null-price cards
  // -oracleid prevents reprints of the same card
  const qParts = [
    "f:commander",
    "game:paper",
    ciPart,
    `usd<=${maxPrice}`,
    "usd>0",
    targetCard.oracle_id ? `-oracleid:${targetCard.oracle_id}` : "",
    `!"${targetCard.name.replaceAll('"', '\\"')}"`
  ].filter(Boolean);

  if (excludeReserved) qParts.push("-is:reserved");

  const q = qParts.join(" ");

  let pool;
  try {
    pool = await scryfallSearchMany(q, 180);
  } catch (e) {
    // If anything goes wrong, show the real reason instead of silently failing
    throw new Error(`Scryfall search error. If you're running from file:// try using GitHub Pages or a local server.`);
  }

  const tTokens = tokenizeOracle(targetCard);

  // Score and filter out same-card printings again (belt + suspenders)
  const scored = pool
    .map(c => {
      if (isSameCardOrPrinting(targetCard, c)) return null;
      const price = pickUsdPrice(c);
      if (price == null) return null; // should be rare due to usd>0 filter
      if (price > maxPrice) return null;

      const score = similarityScore(targetCard, c, tTokens);
      return { card: c, price, score };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (a.price - b.price));

  // De-dupe by oracle_id/prints_search_uri
  const seen = new Set();
  const out = [];
  for (const item of scored) {
    const key = item.card.oracle_id || item.card.prints_search_uri || item.card.id;
    if (seen.has(key)) continue;
    seen.add(key);

    // final same-name guard
    if (normalizeName(item.card.name) === normalizeName(targetCard.name)) continue;

    out.push(item);
    if (out.length >= maxResults) break;
  }

  return out;
}

/* ---------------------------
   Archidekt + Moxfield import (unchanged)
---------------------------- */

function extractDeckIdFromUrl(url) {
  const u = String(url || "").trim();
  let m = u.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i);
  if (m) return { site: "moxfield", id: m[1] };

  m = u.match(/archidekt\.com\/decks\/(\d+)/i);
  if (m) return { site: "archidekt", id: m[1] };

  if (/^\d+$/.test(u)) return { site: "archidekt", id: u };
  if (/^[A-Za-z0-9_-]{10,}$/.test(u)) return { site: "moxfield", id: u };

  return null;
}

async function importDeckFromUrl(url) {
  const info = extractDeckIdFromUrl(url);
  if (!info) throw new Error("Could not detect a valid Archidekt or Moxfield deck URL/ID.");

  if (info.site === "archidekt") {
    const apiUrl = `https://archidekt.com/api/decks/${info.id}/`;
    const res = await fetch(apiUrl, { credentials: "omit" });
    if (!res.ok) throw new Error("Archidekt import failed (deck might be private or blocked).");
    const data = await res.json();

    const cards = Array.isArray(data?.cards) ? data.cards : [];
    const lines = cards.map(c => {
      const qty = c?.quantity ?? c?.count ?? 1;
      const name = c?.card?.name ?? c?.name;
      if (!name) return null;
      return `${qty} ${name}`;
    }).filter(Boolean);

    if (!lines.length) throw new Error("Archidekt deck loaded but card list was empty/unexpected.");
    return lines.join("\n");
  }

  if (info.site === "moxfield") {
    const apiUrl = `https://api2.moxfield.com/v2/decks/all/${info.id}`;
    const res = await fetch(apiUrl, { credentials: "omit" });
    if (!res.ok) throw new Error("Moxfield import failed (may be blocked by Cloudflare/CORS or private deck).");
    const data = await res.json();

    const entries = [];
    const mb = data?.mainboard;
    if (mb && typeof mb === "object") {
      for (const k of Object.keys(mb)) {
        const item = mb[k];
        const qty = item?.quantity ?? 1;
        const name = item?.card?.name ?? item?.name;
        if (name) entries.push(`${qty} ${name}`);
      }
    }

    if (!entries.length) throw new Error("Moxfield deck loaded but card list was empty/unexpected.");
    return entries.join("\n");
  }

  throw new Error("Unsupported site.");
}

/* ---------------------------
   Rendering
---------------------------- */

function renderDeckResults(results) {
  const root = $("results");
  root.innerHTML = "";

  if (!results.length) {
    root.innerHTML = `<p class="muted">No results yet. Click Analyze.</p>`;
    return;
  }

  for (const r of results) {
    const priceText = r.price == null ? "N/A" : `$${r.price.toFixed(2)}`;
    const expensive = r.price != null && r.price >= r.threshold;

    const block = document.createElement("div");
    block.className = "result";

    block.innerHTML = `
      <div class="resultHeader">
        <div>
          <div><strong>${r.qty}× ${escapeHtml(r.name)}</strong></div>
          <div class="muted">${escapeHtml(r.typeLine || "")} • MV ${r.mv ?? "?"} • CI ${r.ci?.join("") || "C"}</div>
          <div><a href="${r.url || "#"}" target="_blank" rel="noopener">Open on Scryfall</a></div>
        </div>
        <div class="badge">
          ${priceText}${expensive ? " • expensive" : (r.singleMode ? " • single-card mode" : "")}
        </div>
      </div>

      ${r.image ? `
        <div class="cardGrid" style="grid-template-columns:1fr;">
          <div class="picCard"><img src="${r.image}" alt="${escapeHtml(r.name)}" loading="lazy" /></div>
        </div>
      ` : ""}

      <div class="candidates">
        ${r.candidates.length ? `
          <div class="cardGrid">
            ${r.candidates.map(c => {
              const cImg = getCardImage(c.card);
              return `
                <div class="picCard">
                  ${cImg ? `<img src="${cImg}" alt="${escapeHtml(c.card.name)}" loading="lazy" />` : ""}
                  <div class="picBody">
                    <div class="picTitle">${escapeHtml(c.card.name)}</div>
                    <div class="picMeta">${escapeHtml(c.card.type_line || "")}<br/>~$${c.price.toFixed(2)} • similarity ${Math.round(c.score)}</div>
                    <div class="picRow">
                      <a href="${c.card.scryfall_uri}" target="_blank" rel="noopener">Scryfall</a>
                      <span class="badge">budget</span>
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        ` : `<div class="muted">No substitutes found — try raising the price cap / threshold.</div>`}
      </div>
    `;

    root.appendChild(block);
  }
}

function renderCardSearch({ queriedCard, cheaper, maxPrice }) {
  const root = $("cardSearchResults");
  root.innerHTML = "";

  const qImg = getCardImage(queriedCard);
  const qPrice = pickUsdPrice(queriedCard);

  root.innerHTML = `
    <div class="result">
      <div class="resultHeader">
        <div>
          <div><strong>${escapeHtml(queriedCard.name)}</strong></div>
          <div class="muted">${escapeHtml(queriedCard.type_line || "")} • MV ${queriedCard.cmc ?? "?"} • CI ${queriedCard.color_identity?.join("") || "C"}</div>
          <div><a href="${queriedCard.scryfall_uri}" target="_blank" rel="noopener">Open on Scryfall</a></div>
        </div>
        <div class="badge">${qPrice == null ? "N/A" : `$${qPrice.toFixed(2)}`}</div>
      </div>
      ${qImg ? `<div class="cardGrid" style="grid-template-columns:1fr;"><div class="picCard"><img src="${qImg}" alt="${escapeHtml(queriedCard.name)}" loading="lazy" /></div></div>` : ""}
    </div>

    <h2>Cheaper functional substitutes</h2>
    <p class="muted">Commander-legal • same colors • similar effects • ≤ $${Number(maxPrice).toFixed(2)} • excludes reprints</p>

    ${cheaper.length ? `
      <div class="cardGrid">
        ${cheaper.map(c => {
          const img = getCardImage(c.card);
          return `
            <div class="picCard">
              ${img ? `<img src="${img}" alt="${escapeHtml(c.card.name)}" loading="lazy" />` : ""}
              <div class="picBody">
                <div class="picTitle">${escapeHtml(c.card.name)}</div>
                <div class="picMeta">${escapeHtml(c.card.type_line || "")}<br/>~$${c.price.toFixed(2)} • similarity ${Math.round(c.score)}</div>
                <div class="picRow">
                  <a href="${c.card.scryfall_uri}" target="_blank" rel="noopener">Scryfall</a>
                  <span class="badge">budget</span>
                </div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    ` : `<p class="muted">No substitutes found under that price cap. Try increasing “Cheaper than $”.</p>`}
  `;
}

/* ---------------------------
   CSV export
---------------------------- */

function toCSV(results) {
  const lines = [["qty","original","orig_price","candidate","cand_price","orig_url","cand_url"].join(",")];

  for (const r of results) {
    const origUrl = r.url || "";
    if (!r.candidates.length) {
      lines.push([r.qty, q(r.name), r.price ?? "", "", "", q(origUrl), ""].join(","));
      continue;
    }
    for (const c of r.candidates) {
      lines.push([
        r.qty,
        q(r.name),
        r.price ?? "",
        q(c.card.name),
        c.price ?? "",
        q(origUrl),
        q(c.card.scryfall_uri || "")
      ].join(","));
    }
  }
  return lines.join("\n");

  function q(v){
    const s = String(v ?? "");
    if (/[,"\n]/.test(s)) return `"${s.replaceAll('"','""')}"`;
    return s;
  }
}

/* ---------------------------
   Analyze + Search flows
---------------------------- */

async function analyzeDeck() {
  const text = $("deckInput").value;
  const rows = parseDecklist(text);
  if (!rows.length) {
    setStatus("Paste a decklist first.");
    renderDeckResults([]);
    return;
  }

  const threshold = Number($("priceThreshold").value || 0);
  const maxCandidates = Number($("maxCandidates").value || 8);
  const excludeReserved = $("excludeReserved").checked;

  const singleMode = rows.length === 1;
  const singlePriceCap = Number($("searchMaxPrice")?.value || 10);

  setStatus("Looking up cards on Scryfall…");

  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    setStatus(`Fetching ${i + 1}/${rows.length}: ${row.name}`);

    let card;
    try {
      card = await scryfallNamed(row.name);
    } catch (e) {
      results.push({ qty: row.qty, name: row.name, error: e.message, price: null, candidates: [], threshold });
      continue;
    }

    const price = pickUsdPrice(card);
    const ci = card.color_identity || [];
    const mv = card.cmc ?? null;
    const image = getCardImage(card);

    let candidates = [];

    try {
      if (singleMode) {
        candidates = await findFunctionalSubstitutes(card, {
          maxPrice: singlePriceCap,
          maxResults: maxCandidates,
          excludeReserved
        });
      } else {
        if (price != null && price >= threshold) {
          candidates = await findFunctionalSubstitutes(card, {
            maxPrice: Math.max(0.25, price - 0.01),
            maxResults: maxCandidates,
            excludeReserved
          });
        }
      }
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    }

    results.push({
      qty: row.qty,
      name: card.name,
      typeLine: card.type_line,
      mv,
      ci,
      price,
      image,
      url: card.scryfall_uri,
      threshold,
      candidates,
      singleMode
    });
  }

  state.results = results;
  setStatus(singleMode ? "Done (single-card mode)." : "Done.");
  renderDeckResults(results);
}

async function runCardSearch() {
  const name = $("searchName").value.trim();
  if (!name) {
    setCardSearchStatus("Type a card name first.");
    $("cardSearchResults").innerHTML = "";
    return;
  }

  const maxPrice = Number($("searchMaxPrice").value || 10);
  const maxResults = Math.min(24, Number($("searchMaxResults").value || 12));

  setCardSearchStatus("Searching Scryfall…");
  $("cardSearchResults").innerHTML = "";

  let card;
  try {
    card = await scryfallNamed(name);
  } catch {
    setCardSearchStatus(`Could not find "${name}". Try a different spelling.`);
    return;
  }

  let cheaper = [];
  try {
    cheaper = await findFunctionalSubstitutes(card, {
      maxPrice,
      maxResults,
      excludeReserved: true
    });
  } catch (e) {
    setCardSearchStatus(`Error: ${e.message}`);
    return;
  }

  setCardSearchStatus(`Found "${card.name}". Showing ${cheaper.length} substitutes ≤ $${maxPrice.toFixed(2)}.`);
  renderCardSearch({ queriedCard: card, cheaper, maxPrice });
}

/* ---------------------------
   UI hooks
---------------------------- */

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = { deck: $("tabDeck"), search: $("tabSearch") };

  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      Object.values(panels).forEach(p => p.classList.remove("active"));
      panels[btn.dataset.tab].classList.add("active");
    });
  });
}

$("btnAnalyze").addEventListener("click", analyzeDeck);

$("btnLoadExample").addEventListener("click", () => {
  $("deckInput").value = `1 Rhystic Study`;
  setStatus("Example loaded (single-card). Click Analyze.");
});

$("btnExport")?.addEventListener("click", () => {
  if (!state.results?.length) {
    setStatus("Nothing to export yet — click Analyze first.");
    return;
  }
  const csv = toCSV(state.results);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "cheap-swaps.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
  setStatus("Exported cheap-swaps.csv");
});

$("btnCardSearch").addEventListener("click", runCardSearch);
$("searchName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runCardSearch();
});

$("btnImportUrl")?.addEventListener("click", async () => {
  const url = $("deckUrl").value.trim();
  if (!url) {
    setStatus("Paste an Archidekt or Moxfield deck URL first.");
    return;
  }

  setStatus("Importing deck from URL…");
  try {
    const deckText = await importDeckFromUrl(url);
    $("deckInput").value = deckText;
    setStatus("Imported! Now click Analyze.");
  } catch (e) {
    setStatus(`${e.message} — if this keeps failing, export your deck as text and paste it here.`);
  }
});

setupTabs();
renderDeckResults([]);
