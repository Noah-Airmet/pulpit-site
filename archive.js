// Served verbatim from public/ — Astro does not rewrite this file for the
// deploy base, so derive it from the attribute the page template stamps.
const BASE = (() => { const b = document.body.dataset.base || "/"; return b.endsWith("/") ? b : `${b}/`; })();

const PAGE = 120;
const FIELDS = ["id", "title", "speaker", "calling", "group", "topgroup", "era", "category", "conference", "year", "fdate", "fidelity", "sigil"];
const CATEGORY_ORDER = ["general_conference", "tabernacle_address", "special_conference", "other"];
const CATEGORY_LABELS = {
  general_conference: "General Conference",
  tabernacle_address: "Tabernacle address",
  special_conference: "Special conference",
  other: "Other occasion",
};

let DATA = [];
let ORDER = [];
let selectedCallings = new Set();
let selectedEras = new Set();
let selectedCategories = new Set();
let selectedSpeakers = new Set();
let selectedConferences = new Set();
let query = "";
let from = "";
let to = "";
let mode = "group";
let page = 0;
// "ledger" is the flat chronological list; "contents" is the finding-aid
// drilldown (decade → conference → talks). Persisted per browser.
let view = localStorage.getItem("pulpit:archiveview") === "contents" ? "contents" : "ledger";
const openDecades = new Set();
const openBuckets = new Set();
let confDate = new Map();

const el = (selector) => document.querySelector(selector);
const esc = (value) => String(value || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function expand(row) {
  return Object.fromEntries(FIELDS.map((field, index) => [field, row[index]]));
}

function passTextAndDate(row) {
  if (query) {
    const haystack = `${row.title} ${row.speaker}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (from && (!row.fdate || row.fdate < from)) return false;
  if (to && (!row.fdate || row.fdate > to)) return false;
  return true;
}

function passes(row, except = "") {
  if (!passTextAndDate(row)) return false;
  if (except !== "calling" && selectedCallings.size && !selectedCallings.has(row[mode])) return false;
  if (except !== "era" && selectedEras.size && !selectedEras.has(row.era)) return false;
  if (except !== "category" && selectedCategories.size && !selectedCategories.has(row.category)) return false;
  if (except !== "speaker" && selectedSpeakers.size && !selectedSpeakers.has(row.speaker)) return false;
  if (except !== "conference" && selectedConferences.size && !selectedConferences.has(row.conference)) return false;
  return true;
}

function filtered() {
  return DATA.filter((row) => passes(row));
}

function countBy(field, except) {
  const counts = new Map();
  for (const row of DATA) {
    if (!passes(row, except)) continue;
    const key = row[field] || "Unknown / untagged";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function renderOptions(target, entries, selected, field, except) {
  const counts = countBy(field, except);
  const box = el(target);
  box.innerHTML = "";
  for (const name of entries) {
    const n = counts.get(name) || 0;
    const div = document.createElement("div");
    div.className = `opt${selected.has(name) ? " sel" : ""}${n === 0 && !selected.has(name) ? " zero" : ""}`;
    const label = field === "category" ? (CATEGORY_LABELS[name] || name) : name;
    div.innerHTML = `<span class="nm"><span class="mk">${selected.has(name) ? "■" : "□"}</span>${esc(label)}</span><span class="ct">${n}</span>`;
    div.addEventListener("click", () => {
      selected.has(name) ? selected.delete(name) : selected.add(name);
      page = 0;
      render();
    });
    box.appendChild(div);
  }
}

function topEntries(field, except, limit = 80) {
  return [...countBy(field, except).entries()]
    .filter(([name]) => name && name !== "Unknown / untagged")
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

// Conferences list chronologically — it is a calendar, not a popularity
// contest. confDate maps each conference to its first talk's date.
function conferenceEntries(except) {
  return [...countBy("conference", except).keys()]
    .filter((name) => name && name !== "Unknown / untagged")
    .sort((a, b) => (confDate.get(a) || "9999").localeCompare(confDate.get(b) || "9999"));
}

function renderList(rows) {
  const list = el("#list");
  list.innerHTML = "";
  const start = page * PAGE;
  const visible = rows.slice(start, start + PAGE);
  if (!visible.length) {
    list.innerHTML = `<div class="empty">No talks match these filters.</div>`;
    return;
  }
  for (const row of visible) {
    const a = document.createElement("a");
    a.className = "row";
    a.href = `${BASE}talks/${row.id}/`;
    const metaBits = [`<span class="sp">${esc(row.speaker) || "-"}</span>`];
    const call = row[mode];
    if (call && call !== "Unknown / untagged") metaBits.push(`<span class="cg">${esc(call)}</span>`);
    if (row.conference) metaBits.push(esc(row.conference));
    else if (row.category && CATEGORY_LABELS[row.category]) metaBits.push(esc(CATEGORY_LABELS[row.category]));
    if (row.year) metaBits.push(String(row.year));
    a.innerHTML = `<p class="rt">${esc(row.title)}</p><div class="rm"><span class="sig" title="${esc(row.fidelity)}">${row.sigil}</span>${metaBits.join('<span class="dot">·</span>')}</div>`;
    list.appendChild(a);
  }
}

// --- Contents view: the finding aid ------------------------------------
// Decade → conference → talks, built from the already-filtered rows. Talk
// rows are appended only when a conference is first opened; summaries are
// cheap enough to build eagerly. Open state survives re-filtering.

function talkRow(row) {
  const a = document.createElement("a");
  a.className = "toc-talk";
  a.href = `${BASE}talks/${row.id}/`;
  const call = row[mode];
  a.innerHTML = `<span class="sig" title="${esc(row.fidelity)}">${row.sigil}</span>` +
    `<span class="toc-talk-title">${esc(row.title)}</span>` +
    `<span class="toc-talk-meta">${esc(row.speaker) || "-"}${call && call !== "Unknown / untagged" ? ` · ${esc(call)}` : ""}</span>`;
  return a;
}

function renderContents(rows) {
  const box = el("#contents");
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<div class="empty">No talks match these filters.</div>`;
    return;
  }
  // Group in one chronological pass (rows arrive date-sorted).
  const decades = new Map();
  for (const row of rows) {
    if (!row.year) continue;
    const decade = Math.floor(row.year / 10) * 10;
    if (!decades.has(decade)) decades.set(decade, new Map());
    const buckets = decades.get(decade);
    const key = row.conference || `${CATEGORY_LABELS[row.category] || "Other records"} — ${row.year}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  for (const [decade, buckets] of decades) {
    const decadeEl = document.createElement("details");
    decadeEl.className = "toc-decade";
    if (openDecades.has(decade)) decadeEl.open = true;
    const talkCount = [...buckets.values()].reduce((n, list) => n + list.length, 0);
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="toc-title">${decade}s</span>` +
      `<span class="toc-meta">${buckets.size} ${buckets.size === 1 ? "gathering" : "gatherings"} · ${talkCount} ${talkCount === 1 ? "discourse" : "discourses"}</span>`;
    decadeEl.appendChild(summary);
    decadeEl.addEventListener("toggle", () => {
      decadeEl.open ? openDecades.add(decade) : openDecades.delete(decade);
    });
    for (const [key, list] of buckets) {
      const confEl = document.createElement("details");
      confEl.className = "toc-conf";
      const bucketId = `${decade}|${key}`;
      const confSummary = document.createElement("summary");
      confSummary.innerHTML = `<span class="toc-title">${esc(key)}</span>` +
        `<span class="toc-meta">${list.length} ${list.length === 1 ? "discourse" : "discourses"}</span>`;
      confEl.appendChild(confSummary);
      const holder = document.createElement("div");
      holder.className = "toc-rows";
      confEl.appendChild(holder);
      const fill = () => {
        if (holder.childElementCount) return;
        for (const row of list) holder.appendChild(talkRow(row));
      };
      confEl.addEventListener("toggle", () => {
        confEl.open ? (openBuckets.add(bucketId), fill()) : openBuckets.delete(bucketId);
      });
      if (openBuckets.has(bucketId)) { confEl.open = true; fill(); }
      decadeEl.appendChild(confEl);
    }
    box.appendChild(decadeEl);
  }
}

function setView(next) {
  view = next;
  localStorage.setItem("pulpit:archiveview", view);
  el("#vLedger").classList.toggle("on", view === "ledger");
  el("#vContents").classList.toggle("on", view === "contents");
  page = 0;
  render();
}

function renderPager(rows) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE));
  if (page >= totalPages) page = totalPages - 1;
  el("#pager").innerHTML = `
    <button type="button" id="prev"${page === 0 ? " disabled" : ""}>Previous</button>
    <span>Page ${page + 1} of ${totalPages}</span>
    <button type="button" id="next"${page >= totalPages - 1 ? " disabled" : ""}>Next</button>
  `;
  el("#prev")?.addEventListener("click", () => { if (page > 0) { page -= 1; render(); } });
  el("#next")?.addEventListener("click", () => { if (page < totalPages - 1) { page += 1; render(); } });
}

function render() {
  renderOptions("#callings", ORDER, selectedCallings, mode, "calling");
  renderOptions("#eras", topEntries("era", "era", 12), selectedEras, "era", "era");
  renderOptions("#categories", CATEGORY_ORDER, selectedCategories, "category", "category");
  renderOptions("#speakers", topEntries("speaker", "speaker"), selectedSpeakers, "speaker", "speaker");
  renderOptions("#conferences", conferenceEntries("conference"), selectedConferences, "conference", "conference");

  const rows = filtered().sort((a, b) => (a.fdate || "9999").localeCompare(b.fdate || "9999") || a.title.localeCompare(b.title));
  el("#count").textContent = rows.length === DATA.length ? `${rows.length} discourses` : `${rows.length} of ${DATA.length}`;
  const contentsMode = view === "contents";
  el("#list").hidden = contentsMode;
  el("#pager").hidden = contentsMode;
  el("#contents").hidden = !contentsMode;
  if (contentsMode) {
    renderContents(rows);
  } else {
    renderList(rows);
    renderPager(rows);
  }
}

function collapse(headId, bodyId) {
  const head = el(headId);
  const body = el(bodyId);
  head.addEventListener("click", () => {
    head.classList.toggle("closed");
    body.classList.toggle("closed");
  });
}

function bindControls() {
  collapse("#callhead", "#callbody");
  collapse("#erahead", "#erabody");
  collapse("#categoryhead", "#categorybody");
  collapse("#speakerhead", "#speakerbody");
  collapse("#conferencehead", "#conferencebody");
  collapse("#datehead", "#datebody");

  el("#mAt").addEventListener("click", () => {
    mode = "group";
    selectedCallings.clear();
    el("#mAt").classList.add("on");
    el("#mTop").classList.remove("on");
    page = 0;
    render();
  });

  el("#mTop").addEventListener("click", () => {
    mode = "topgroup";
    selectedCallings.clear();
    el("#mTop").classList.add("on");
    el("#mAt").classList.remove("on");
    page = 0;
    render();
  });

  el("#vLedger").addEventListener("click", () => setView("ledger"));
  el("#vContents").addEventListener("click", () => setView("contents"));

  el("#q").addEventListener("input", (event) => {
    query = event.target.value.trim().toLowerCase();
    page = 0;
    render();
  });
  el("#from").addEventListener("change", (event) => { from = event.target.value; page = 0; render(); });
  el("#to").addEventListener("change", (event) => { to = event.target.value; page = 0; render(); });
  el("#clear").addEventListener("click", () => {
    selectedCallings.clear();
    selectedEras.clear();
    selectedCategories.clear();
    selectedSpeakers.clear();
    selectedConferences.clear();
    query = "";
    from = "";
    to = "";
    el("#q").value = "";
    el("#from").value = "";
    el("#to").value = "";
    page = 0;
    render();
  });
}

async function init() {
  bindControls();
  const payload = await fetch(`${BASE}archive-data.json`).then((response) => response.json());
  ORDER = payload.calling_order;
  DATA = payload.rows.map(expand);
  confDate = new Map();
  for (const row of DATA) {
    if (!row.conference || !row.fdate) continue;
    const seen = confDate.get(row.conference);
    if (!seen || row.fdate < seen) confDate.set(row.conference, row.fdate);
  }
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "contents") view = "contents";
  el("#vLedger").classList.toggle("on", view === "ledger");
  el("#vContents").classList.toggle("on", view === "contents");
  if (params.get("from")) { from = params.get("from"); el("#from").value = from; }
  if (params.get("to")) { to = params.get("to"); el("#to").value = to; }
  if (params.get("calling")) selectedCallings.add(params.get("calling"));
  if (params.get("category")) selectedCategories.add(params.get("category"));
  // Facets start collapsed; reopen any the URL pre-filtered so the active
  // selection is visible.
  if (selectedCallings.size) { el("#callhead").classList.remove("closed"); el("#callbody").classList.remove("closed"); }
  if (selectedCategories.size) { el("#categoryhead").classList.remove("closed"); el("#categorybody").classList.remove("closed"); }
  if (from || to) { el("#datehead").classList.remove("closed"); el("#datebody").classList.remove("closed"); }
  render();
}

init();
