// One constant for the backend address. Change this one line when you deploy.
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "http://127.0.0.1:8000"
  : "https://recipe-explorer-2nkr.onrender.com";
const MIN_N = 5; // a cuisine needs at least this many matching recipes with a value to be ranked
const BOOK_KEY = "recipe-explorer-cookbook";
const BOOK_MAX = 50;
const RECENT_FROM = "2022-01"; // the "2022 onward" timeline view

// The single shared colour scale for the whole dashboard.
const REGION_COLORS = {
  "Europe": "#0072B2",
  "Asia": "#D55E00",
  "Latin America & Caribbean": "#009E73",
  "North America": "#CC79A7",
  "Middle East": "#E69F00",
  "Other": "#7a7a7a"
};
const REGIONS = Object.keys(REGION_COLORS);

const METRICS = {
  total_time: { label: "Median total time (minutes)", hint: "quickest first", sortAsc: true, zero: true, fmt: v => `${v} min` },
  calories:   { label: "Median calories (kcal)", hint: "richest first", sortAsc: false, zero: true, fmt: v => `${v} kcal` },
  rating:     { label: "Median rating (stars, 1 to 5)", hint: "best rated first", sortAsc: false, zero: false, fmt: v => `${v.toFixed(2)} stars` }
};

// Slider stops. null means "no limit".
const TIME_STOPS = [15, 30, 45, 60, 90, 120, 180, 240, 480, null];
const CAL_STOPS = [100, 200, 300, 400, 500, 750, 1000, null];

// The ONE shared state object. Views read it; they never update each other directly.
// dateFrom/dateTo = brushed month range ("YYYY-MM") or null. openId = recipe whose card is open.
// lastId = last recipe viewed (keeps the ring on the scatterplot). book = cookbook ids, newest first.
const state = {
  metric: "total_time", selected: new Set(), maxTime: null, maxCal: null,
  dateFrom: null, dateTo: null, openId: null, lastId: null, book: []
};

const margin = { top: 24, right: 24, bottom: 8, left: 150 };
const W = 480, ROW_H = 18;
const SC = { w: 620, h: 440, m: { top: 14, right: 16, bottom: 48, left: 58 } };
const TL = { w: 1160, h: 280, m: { top: 16, right: 20, bottom: 42, left: 52 } };

const parseMonth = d3.timeParse("%Y-%m");
const fmtMonth = d3.timeFormat("%Y-%m");
const fmtLabel = d3.timeFormat("%b %Y");

let summary = [], rankData = [], recipes = [], scatterData = [], domains = {};
let byId = new Map(), scatterIds = new Set(), cuisineRegion = {};
let rankSvg, gAxis, gRows, scDots, ring, sx, sy, ringFor = null;
let rankTimer = null, rankReq = 0, lastFocus = null;
// timeline
let tlSvg, tx, ty, gXAxis, gBars, gHi, gNote, gBrush, brush;
let tlMonths = [], tlBounds = {}, tlEnd = null, tlYMax = 1, tlView = "all";
let tlBaseMap = new Map(), tlHiMap = new Map();
const ingCache = new Map(); // recipe id -> ingredients text, so reopening a card is instant
const tip = d3.select("#tooltip");

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtTime(min) {
  if (min < 60) return `${min} min`;
  if (min < 1440) { const h = Math.floor(min / 60), r = min % 60; return r ? `${h} h ${r} min` : `${h} h`; }
  const d = Math.floor(min / 1440), h = Math.round((min % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}
const tickTime = v => (v < 60 ? `${v} min` : v < 1440 ? `${v / 60} h` : `${v / 1440} d`);
const limitsActive = () => state.maxTime !== null || state.maxCal !== null;
const datesActive = () => state.dateFrom !== null;

// Missing values cannot pass an active slider limit.
function passesLimits(r) {
  if (state.maxTime !== null && !(r.total_time !== null && r.total_time <= state.maxTime)) return false;
  if (state.maxCal !== null && !(r.calories !== null && r.calories <= state.maxCal)) return false;
  return true;
}
function inDates(r) {
  return (state.dateFrom === null || r.month >= state.dateFrom) && (state.dateTo === null || r.month <= state.dateTo);
}
// A recipe passes if it satisfies the sliders AND the brushed date range.
const passes = r => passesLimits(r) && inDates(r);

// Recipes matching the sliders, the date range and the selected cuisines. Surprise me! picks from these.
function matching() {
  return recipes.filter(r => passes(r) && (state.selected.size === 0 || state.selected.has(r.cuisine)));
}

function dateText() {
  const f = fmtLabel(parseMonth(state.dateFrom)), t = fmtLabel(parseMonth(state.dateTo));
  return f === t ? f : `${f} to ${t}`;
}

async function init() {
  const status = document.getElementById("status");
  try {
    const [sRes, rRes] = await Promise.all([
      fetch(`${API_BASE}/api/cuisines/summary`),
      fetch(`${API_BASE}/api/recipes`)
    ]);
    if (!sRes.ok || !rRes.ok) throw new Error(`HTTP ${sRes.status}/${rRes.status}`);
    summary = await sRes.json();
    recipes = await rRes.json();
  } catch (err) {
    status.textContent = `Could not load data: ${err.message}. The server may be waking up, so wait a minute and reload.`;
    console.error(err);
    return;
  }
  status.hidden = true;
  rankData = summary;

  byId = new Map(recipes.map(r => [r.id, r]));
  cuisineRegion = Object.fromEntries(summary.map(d => [d.cuisine, d.region]));
  // Log axes cannot show zero or missing values, so only recipes with both values are plotted.
  scatterData = recipes.filter(r => r.total_time > 0 && r.calories > 0);
  scatterIds = new Set(scatterData.map(r => r.id));
  state.book = loadBook();

  // Fixed ranking-axis domains, computed once from the full (unfiltered) data.
  for (const k of Object.keys(METRICS)) {
    const vals = summary.map(d => d[k].median).filter(v => v !== null);
    const [lo, hi] = d3.extent(vals);
    domains[k] = METRICS[k].zero ? [0, hi] : [Math.floor((lo - 0.1) * 10) / 10, Math.ceil((hi + 0.1) * 10) / 10];
  }

  document.getElementById("subtitle").textContent =
    `${recipes.length} Allrecipes dishes from ${summary.length} cuisines. Drag across the timeline to pick dates, click cuisines or regions to compare them, ` +
    `and click a dot or hit Surprise me! for a recipe card. Every card you open is saved in your cookbook.`;
  document.getElementById("dashboard").hidden = false;

  const timeSlider = document.getElementById("time-slider");
  const calSlider = document.getElementById("cal-slider");
  timeSlider.max = TIME_STOPS.length - 1; timeSlider.value = TIME_STOPS.length - 1;
  calSlider.max = CAL_STOPS.length - 1; calSlider.value = CAL_STOPS.length - 1;
  const onSlider = () => {
    state.maxTime = TIME_STOPS[+timeSlider.value];
    state.maxCal = CAL_STOPS[+calSlider.value];
    updateSliderLabels();
    renderScatter();         // instant, in the browser
    renderTimeline();
    renderSelectionBar();
    queueRankingUpdate();    // debounced, asks the backend
  };
  timeSlider.addEventListener("input", onSlider);
  calSlider.addEventListener("input", onSlider);
  document.getElementById("reset-btn").addEventListener("click", () => {
    timeSlider.value = TIME_STOPS.length - 1; calSlider.value = CAL_STOPS.length - 1; onSlider();
  });
  document.getElementById("surprise-btn").addEventListener("click", surprise);
  updateSliderLabels();

  const backdrop = document.getElementById("card-backdrop");
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeCard(); });

  // cookbook button and panel
  const bookBtn = document.getElementById("book-btn");
  const bookPanel = document.getElementById("book-panel");
  bookBtn.addEventListener("click", toggleBook);
  bookPanel.addEventListener("click", onBookClick);
  document.addEventListener("click", e => {
    if (bookPanel.hidden) return;
    const path = e.composedPath(); // taken at click time, so it survives the panel re-rendering
    if (path.includes(bookPanel) || path.includes(bookBtn)) return;
    closeBook();
  });
  renderBook();

  buildLegend();
  buildRanking();
  buildScatter();
  buildTimeline();
  d3.selectAll("input[name=metric]").on("change", function () { state.metric = this.value; render(); });
  d3.select("#clear-btn").on("click", clearSelection);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (state.openId) closeCard();                                   // the card is on top
    else if (!document.getElementById("book-panel").hidden) closeBook();
    else clearSelection();
  });
  render();
}

function updateSliderLabels() {
  document.getElementById("time-out").textContent =
    state.maxTime === null ? "any time" : `up to ${fmtTime(state.maxTime)}`;
  document.getElementById("cal-out").textContent =
    state.maxCal === null ? "any amount" : `up to ${state.maxCal} kcal`;
}

// ---- state changes: the only places the selection is modified ----
function toggleCuisine(c) {
  state.selected.has(c) ? state.selected.delete(c) : state.selected.add(c);
  render();
}
function toggleRegion(region) {
  const members = summary.filter(d => d.region === region).map(d => d.cuisine);
  const allIn = members.every(c => state.selected.has(c));
  members.forEach(c => (allIn ? state.selected.delete(c) : state.selected.add(c)));
  render();
}
// Pair 1: the date range (set by brushing the timeline) filters the scatterplot and re-aggregates the ranking.
function setDateRange(from, to) {
  if (from === state.dateFrom && to === state.dateTo) return;
  state.dateFrom = from;
  state.dateTo = to;
  renderScatter();
  renderSelectionBar();
  updateTimelineControls();
  renderTimelineCaption();
  queueRankingUpdate();
}
function clearDates() { setDateRange(null, null); syncBrush(); }
function clearSelection() {
  state.selected.clear();
  clearDates();
  render();
}

function render() {
  renderRanking();
  renderScatter();
  renderTimeline();
  renderSelectionBar();
}

// ---- backend-driven ranking update (debounced, with stale-response protection) ----
function queueRankingUpdate() {
  clearTimeout(rankTimer);
  document.getElementById("ranking-panel").classList.add("loading");
  rankTimer = setTimeout(fetchRanking, 150);
}
async function fetchRanking() {
  const id = ++rankReq;
  const p = new URLSearchParams();
  if (state.maxTime !== null) p.set("max_time", state.maxTime);
  if (state.maxCal !== null) p.set("max_cal", state.maxCal);
  if (state.dateFrom !== null) p.set("from", state.dateFrom);
  if (state.dateTo !== null) p.set("to", state.dateTo);
  try {
    const res = await fetch(`${API_BASE}/api/cuisines/summary?${p}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (id !== rankReq) return; // a newer request has superseded this one
    rankData = data;
    renderRanking();
  } catch (err) {
    if (id !== rankReq) return;
    document.getElementById("ranking-caption").textContent = `Could not update the ranking: ${err.message}.`;
    console.error(err);
  } finally {
    if (id === rankReq) document.getElementById("ranking-panel").classList.remove("loading");
  }
}

// ---- legend ----
function buildLegend() {
  d3.select("#legend").selectAll("button").data(Object.entries(REGION_COLORS)).join("button")
    .attr("class", "legend-item")
    .attr("title", "Click to select every cuisine in this region")
    .html(([name, color]) => `<span class="swatch" style="background:${color}"></span>${esc(name)}`)
    .on("click", (e, [name]) => toggleRegion(name));
}

// ---- ranking view ----
function buildRanking() {
  rankSvg = d3.select("#ranking").append("svg").attr("width", W);
  gAxis = rankSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${margin.top})`);
  gRows = rankSvg.append("g");
}

function renderRanking() {
  const k = state.metric, m = METRICS[k];
  const rows = rankData
    .filter(d => d[k].median !== null && d[k].n >= MIN_N)
    .sort((a, b) =>
      (m.sortAsc ? d3.ascending(a[k].median, b[k].median) : d3.descending(a[k].median, b[k].median))
      || d3.ascending(a.cuisine, b.cuisine));
  const hidden = summary.length - rows.length;
  const dimmed = d => state.selected.size > 0 && !state.selected.has(d.cuisine);

  const x = d3.scaleLinear().domain(domains[k]).range([margin.left, W - margin.right]).clamp(true);
  const y = d3.scaleBand().domain(rows.map(d => d.cuisine)).range([margin.top, margin.top + rows.length * ROW_H]);

  rankSvg.attr("height", margin.top + rows.length * ROW_H + margin.bottom);
  gAxis.transition().duration(300).call(d3.axisTop(x).ticks(6).tickSize(-rows.length * ROW_H));

  const sel = gRows.selectAll("g.row")
    .data(rows, d => d.cuisine)
    .join(
      enter => {
        const g = enter.append("g").attr("class", "row")
          .attr("transform", d => `translate(0,${y(d.cuisine)})`)
          .style("opacity", 0);
        g.append("rect").attr("width", W).attr("height", ROW_H).attr("fill", "transparent");
        g.append("line").attr("class", "stem").attr("x1", margin.left).attr("y1", ROW_H / 2).attr("y2", ROW_H / 2);
        g.append("circle").attr("class", "dot").attr("r", 5).attr("cy", ROW_H / 2);
        g.append("text").attr("class", "label").attr("x", margin.left - 8).attr("y", ROW_H / 2).attr("text-anchor", "end");
        return g;
      },
      update => update,
      exit => exit.transition().duration(300).style("opacity", 0).remove()
    );

  sel.classed("selected", d => state.selected.has(d.cuisine))
    .on("mousemove", (e, d) => {
      placeTip(e, `<strong>${esc(d.cuisine)}</strong><br>${esc(d.region)}<br>${m.fmt(d[k].median)}<br>` +
        `${d[k].n} of ${d.n} matching recipes have this value<br><em>Click to select</em>`);
    })
    .on("mouseleave", hideTip)
    .on("click", (e, d) => toggleCuisine(d.cuisine));

  sel.transition().duration(300).style("opacity", d => (dimmed(d) ? 0.35 : 1)).attr("transform", d => `translate(0,${y(d.cuisine)})`);
  sel.select(".stem").transition().duration(300).attr("x2", d => x(d[k].median));
  sel.select(".dot").attr("fill", d => REGION_COLORS[d.region]).transition().duration(300).attr("cx", d => x(d[k].median));
  sel.select(".label").text(d => d.cuisine);

  // The axis is fixed (computed from all the data) so filtered states stay comparable.
  // A value beyond it is pinned to the edge, and the caption says so.
  const outside = rows.filter(d => d[k].median < domains[k][0] || d[k].median > domains[k][1]).length;

  document.getElementById("axis-title").textContent = `${m.label}, sorted ${m.hint}`;
  document.getElementById("ranking-empty").hidden = rows.length > 0;
  const note = hidden > 0
    ? `${hidden} of ${summary.length} cuisines are hidden because fewer than ${MIN_N} matching recipes have this value.`
    : `All ${summary.length} cuisines are shown.`;
  document.getElementById("ranking-caption").textContent =
    `Each dot is one cuisine's median across its recipes, coloured by region. ${note}` +
    (m.zero ? "" : " This axis does not start at zero, so compare positions, not distances from the edge.") +
    (outside > 0 ? ` The axis stays fixed when you filter, so ${outside} ${outside === 1 ? "dot sits" : "dots sit"} pinned at its edge (hover for the real value).` : "");
}

// ---- scatterplot view ----
function buildScatter() {
  const svg = d3.select("#scatter").append("svg").attr("viewBox", `0 0 ${SC.w} ${SC.h}`);
  sx = d3.scaleLog().domain(d3.extent(scatterData, d => d.total_time)).range([SC.m.left, SC.w - SC.m.right]).nice();
  sy = d3.scaleLog().domain(d3.extent(scatterData, d => d.calories)).range([SC.h - SC.m.bottom, SC.m.top]).nice();

  const inDomain = s => v => v >= s.domain()[0] && v <= s.domain()[1];
  const xTicks = [5, 15, 30, 60, 120, 240, 480, 1440, 4320, 14400].filter(inDomain(sx));
  const yTicks = [10, 30, 100, 300, 1000, 3000].filter(inDomain(sy));

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${SC.h - SC.m.bottom})`)
    .call(d3.axisBottom(sx).tickValues(xTicks).tickFormat(tickTime).tickSize(-(SC.h - SC.m.top - SC.m.bottom)));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${SC.m.left},0)`)
    .call(d3.axisLeft(sy).tickValues(yTicks).tickFormat(d3.format(",")).tickSize(-(SC.w - SC.m.left - SC.m.right)));
  svg.append("text").attr("class", "axis-title").attr("x", (SC.m.left + SC.w - SC.m.right) / 2)
    .attr("y", SC.h - 8).attr("text-anchor", "middle").text("Total time (log scale)");
  svg.append("text").attr("class", "axis-title").attr("transform", "rotate(-90)")
    .attr("x", -(SC.m.top + SC.h - SC.m.bottom) / 2).attr("y", 14).attr("text-anchor", "middle")
    .text("Calories, kcal (log scale)");

  scDots = svg.append("g").selectAll("circle").data(scatterData, d => d.id).join("circle")
    .attr("cx", d => sx(d.total_time)).attr("cy", d => sy(d.calories))
    .attr("r", 2.8).attr("fill", d => REGION_COLORS[d.region]).attr("fill-opacity", 0.6)
    .on("mousemove", (e, d) => {
      const rating = d.avg_rating === null ? "no ratings yet" : `${d.avg_rating} stars (${d.total_ratings} ratings)`;
      placeTip(e, `<strong>${esc(d.name)}</strong><br>${esc(d.cuisine)} · ${esc(d.region)}<br>` +
        `${fmtTime(d.total_time)} · ${d.calories} kcal<br>${rating}<br><em>Click for the recipe card</em>`);
    })
    .on("mouseleave", hideTip)
    .on("click", (e, d) => openCard(d.id));

  ring = svg.append("g").append("circle").attr("class", "ring").attr("r", 9).attr("display", "none");
}

function renderScatter() {
  const any = state.selected.size > 0;
  const isSel = d => state.selected.has(d.cuisine);

  // Sliders and the date range FILTER (non-matching recipes disappear);
  // cuisine selection HIGHLIGHTS (the rest recede).
  scDots.attr("pointer-events", d => (passes(d) ? "all" : "none"))
    .transition().duration(250)
    .attr("fill-opacity", d => (!passes(d) ? 0 : !any ? 0.6 : isSel(d) ? 0.95 : 0.1))
    .attr("r", d => (any && isSel(d) ? 4 : 2.8));
  scDots.filter(d => any && isSel(d) && passes(d)).raise();
  updateRing();

  const shown = scatterData.filter(passes);
  const missing = recipes.length - scatterData.length;
  const what = [limitsActive() && "slider limits", datesActive() && "date range"].filter(Boolean).join(" and ");
  let text = `Each dot is one recipe, coloured by region. ${scatterData.length} of ${recipes.length} recipes can be plotted; ` +
    `${missing} lack a time or calorie value. Both axes are logarithmic because a few recipes take days.`;
  if (what) text += ` Recipes outside the ${what} are hidden (${shown.length} dots remain).`;
  if (shown.length === 0) text = "No recipes match these limits and dates. Loosen a slider, widen the date range, or press Clear selection.";
  else if (any && shown.filter(isSel).length === 0) text = "None of the selected cuisines has a plottable recipe within the current limits and dates, so nothing is highlighted.";
  document.getElementById("scatter-caption").textContent = text;
}

// Ring around the recipe whose card is open (or was viewed last).
function updateRing() {
  const focusId = state.openId || state.lastId;
  const rec = focusId && byId.get(focusId);
  if (rec && scatterIds.has(rec.id) && passes(rec)) {
    ring.attr("display", null).attr("cx", sx(rec.total_time)).attr("cy", sy(rec.calories));
    if (ringFor !== rec.id) ring.interrupt().attr("r", 22).transition().duration(400).attr("r", 9);
    ringFor = rec.id;
  } else {
    ring.attr("display", "none");
    ringFor = null;
  }
}

// ---- timeline view: stacked monthly bars + a brush (Pair 1 source) ----
function buildTimeline() {
  tlMonths = [...new Set(recipes.map(r => r.month))].sort().map(m => ({ month: m, date: parseMonth(m) }));
  const first = tlMonths[0].date;
  const last = d3.timeMonth.offset(tlMonths[tlMonths.length - 1].date, 1);
  const recent = parseMonth(RECENT_FROM);
  tlBounds = { all: [first, last], recent: [recent > first ? recent : first, last] };
  tlEnd = d3.timeParse("%Y-%m-%d")(d3.max(recipes, r => r.date_published));
  // Fixed y-axis: the busiest month in the full data, so filtered bars visibly shrink.
  tlYMax = d3.max(d3.rollup(recipes, v => v.length, r => r.month).values());

  tlSvg = d3.select("#timeline").append("svg").attr("viewBox", `0 0 ${TL.w} ${TL.h}`);
  tx = d3.scaleTime().domain(tlBounds.all).range([TL.m.left, TL.w - TL.m.right]);
  ty = d3.scaleLinear().domain([0, tlYMax]).nice().range([TL.h - TL.m.bottom, TL.m.top]);

  tlSvg.append("g").attr("class", "axis").attr("transform", `translate(${TL.m.left},0)`)
    .call(d3.axisLeft(ty).ticks(5).tickSize(-(TL.w - TL.m.left - TL.m.right)));
  gXAxis = tlSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${TL.h - TL.m.bottom})`);
  tlSvg.append("text").attr("class", "axis-title").attr("x", (TL.m.left + TL.w - TL.m.right) / 2)
    .attr("y", TL.h - 6).attr("text-anchor", "middle").text("Month published");
  tlSvg.append("text").attr("class", "axis-title").attr("transform", "rotate(-90)")
    .attr("x", -(TL.m.top + TL.h - TL.m.bottom) / 2).attr("y", 14).attr("text-anchor", "middle").text("Recipes per month");

  tlSvg.append("clipPath").attr("id", "tl-clip").append("rect")
    .attr("x", TL.m.left).attr("y", TL.m.top)
    .attr("width", TL.w - TL.m.left - TL.m.right).attr("height", TL.h - TL.m.top - TL.m.bottom);
  const clipped = tlSvg.append("g").attr("class", "bars").attr("clip-path", "url(#tl-clip)");
  gBars = clipped.append("g");   // every recipe within the slider limits
  gHi = clipped.append("g");     // the selected cuisines only, drawn solid on top

  gNote = tlSvg.append("g").attr("class", "tl-note");
  gNote.append("line").attr("y1", TL.m.top).attr("y2", TL.h - TL.m.bottom);
  gNote.append("text").attr("y", TL.m.top + 12).attr("text-anchor", "end")
    .text(`Data ends ${d3.timeFormat("%-d %b %Y")(tlEnd)}`);

  // The brush sits on top, so it receives the pointer. The tooltip listens on the same layers.
  brush = d3.brushX()
    .extent([[TL.m.left, TL.m.top], [TL.w - TL.m.right, TL.h - TL.m.bottom]])
    .on("brush end", brushed);
  gBrush = tlSvg.append("g").attr("class", "brush").call(brush);
  gBrush.selectAll(".overlay, .selection").on("mousemove.tip", tlTip).on("mouseleave.tip", hideTip);

  document.getElementById("tl-all").addEventListener("click", () => setView("all"));
  document.getElementById("tl-recent").addEventListener("click", () => setView("recent"));
  document.getElementById("tl-brush").addEventListener("click", () => setView("brush"));
  redrawTimeline();
}

function setView(name) {
  if (name === "brush" && !datesActive()) return;
  tlView = name;
  tx.domain(name === "brush"
    ? [parseMonth(state.dateFrom), d3.timeMonth.offset(parseMonth(state.dateTo), 1)]
    : tlBounds[name]);
  redrawTimeline();
}

// Re-draws everything that depends on the time scale (after a zoom change).
function redrawTimeline() {
  const span = d3.timeMonth.count(tx.domain()[0], tx.domain()[1]);
  const axis = d3.axisBottom(tx).tickSizeOuter(0);
  if (span > 48) axis.ticks(d3.timeYear.every(span > 120 ? 2 : 1)).tickFormat(d3.timeFormat("%Y"));
  else if (span > 18) axis.ticks(d3.timeMonth.every(3)).tickFormat(d3.timeFormat("%b %Y"));
  else axis.ticks(d3.timeMonth.every(1)).tickFormat(d3.timeFormat("%b %Y"));
  gXAxis.transition().duration(300).call(axis);

  const ex = tx(tlEnd);
  const inView = ex >= TL.m.left && ex <= TL.w - TL.m.right;
  gNote.attr("display", inView ? null : "none");
  gNote.select("line").attr("x1", ex).attr("x2", ex);
  gNote.select("text").attr("x", ex - 6);

  renderTimeline();
  syncBrush();
  updateTimelineControls();
}

function tlRows(filter) {
  const counts = d3.rollup(recipes.filter(filter), v => v.length, r => r.month, r => r.region);
  return tlMonths.map(({ month, date }) => {
    const row = { month, date };
    const m = counts.get(month);
    for (const k of REGIONS) row[k] = (m && m.get(k)) || 0;
    return row;
  });
}

function drawStack(g, rows, opacity) {
  const series = d3.stack().keys(REGIONS)(rows);
  const bw = d => Math.max(1, tx(d3.timeMonth.offset(d.data.date, 1)) - tx(d.data.date) - 1);
  g.selectAll("g.series").data(series, s => s.key).join("g")
    .attr("class", "series").attr("fill", s => REGION_COLORS[s.key])
    .selectAll("rect").data(s => s, d => d.data.month)
    .join(enter => enter.append("rect")
      .attr("x", d => tx(d.data.date) + 0.5).attr("width", bw).attr("y", ty(0)).attr("height", 0))
    .transition().duration(300)
    .attr("x", d => tx(d.data.date) + 0.5).attr("width", bw)
    .attr("y", d => ty(d[1])).attr("height", d => Math.max(0, ty(d[0]) - ty(d[1])));
  g.transition().duration(300).style("opacity", opacity);
}

// Bars count recipes within the slider limits. They ignore the date range, because the range is chosen on this view.
// Pair 2 (highlight): with cuisines selected, the whole stack fades and the selected cuisines are drawn solid.
function renderTimeline() {
  const any = state.selected.size > 0;
  const base = tlRows(passesLimits);
  const hi = tlRows(r => passesLimits(r) && state.selected.has(r.cuisine));
  tlBaseMap = new Map(base.map(r => [r.month, r]));
  tlHiMap = new Map(hi.map(r => [r.month, r]));
  drawStack(gBars, base, any ? 0.3 : 1);
  drawStack(gHi, hi, 1);
  renderTimelineCaption();
}

function renderTimelineCaption() {
  const since = recipes.filter(r => r.year >= 2022).length;
  const share = Math.round((100 * since) / recipes.length);
  const outsideView = datesActive() &&
    (tx(d3.timeMonth.offset(parseMonth(state.dateTo), 1)) <= TL.m.left || tx(parseMonth(state.dateFrom)) >= TL.w - TL.m.right);
  let text = `Each bar stacks the recipes published in one month, coloured by region (legend at the top). ` +
    `${share}% of the ${recipes.length} recipes were published from 2022 on, so earlier years are thin; use the View buttons to zoom. ` +
    `The data ends on ${d3.timeFormat("%-d %b %Y")(tlEnd)}, so the last bar covers only part of its month. ` +
    `Drag across the bars to choose a date range, or click once to clear it. The y-axis stays fixed when you filter.`;
  if (state.selected.size > 0) text += " Faded bars show every recipe; solid bars are the selected cuisines.";
  if (limitsActive()) text += " The sliders limit which recipes are counted.";
  if (outsideView) text += " Your date range lies outside this view, so zoom out to see it.";
  document.getElementById("timeline-caption").textContent = text;
}

// Pixel extent -> data: whole months, the right edge exactly on a boundary belongs to the earlier month.
function brushed(event) {
  if (!event.sourceEvent) return;              // programmatic moves (snapping, clearing, zooming) are ignored
  const sel = event.selection;
  if (!sel) { setDateRange(null, null); return; }
  const [d0, d1] = sel.map(v => tx.invert(v));
  setDateRange(fmtMonth(d3.timeMonth.floor(d0)), fmtMonth(d3.timeMonth.floor(new Date(+d1 - 1))));
  if (event.type === "end") syncBrush();       // snap the drawn brush to whole months
}

// Draw the brush from the shared state (the state is the source of truth, not the brush).
function syncBrush() {
  if (!gBrush) return;
  if (!datesActive()) { gBrush.call(brush.move, null); return; }
  const lo = TL.m.left, hi = TL.w - TL.m.right;
  const x0 = Math.max(tx(parseMonth(state.dateFrom)), lo);
  const x1 = Math.min(tx(d3.timeMonth.offset(parseMonth(state.dateTo), 1)), hi);
  gBrush.call(brush.move, x1 > x0 ? [x0, x1] : null);
}

function tlTip(event) {
  const [px] = d3.pointer(event, tlSvg.node());
  const month = d3.timeMonth.floor(tx.invert(px));
  const key = fmtMonth(month);
  const row = tlBaseMap.get(key);
  const total = row ? REGIONS.reduce((s, k) => s + row[k], 0) : 0;
  let html = `<strong>${fmtLabel(month)}</strong><br>${total} ${total === 1 ? "recipe" : "recipes"}`;
  if (row) {
    html += REGIONS.filter(k => row[k] > 0)
      .map(k => `<br><span class="swatch" style="background:${REGION_COLORS[k]}"></span>${esc(k)}: ${row[k]}`).join("");
  }
  if (state.selected.size > 0) {
    const h = tlHiMap.get(key);
    html += `<br><em>${h ? REGIONS.reduce((s, k) => s + h[k], 0) : 0} from the selected cuisines</em>`;
  }
  placeTip(event, html);
}

function updateTimelineControls() {
  for (const v of ["all", "recent", "brush"]) {
    document.getElementById(`tl-${v}`).classList.toggle("active", tlView === v);
  }
  document.getElementById("tl-brush").disabled = !datesActive();
  document.getElementById("tl-range").textContent = datesActive()
    ? `Selected: ${dateText()} · ${recipes.filter(inDates).length} recipes (click the chart once to clear)`
    : "No date range selected. Drag across the bars to pick one.";
}

// ---- selection bar ----
function renderSelectionBar() {
  const list = [...state.selected].sort();
  const match = recipes.filter(passes);
  const inSel = match.filter(r => state.selected.has(r.cuisine));
  const what = [datesActive() && "the date range", limitsActive() && "the limits"].filter(Boolean).join(" and ");
  let text;
  if (list.length === 0) {
    text = what
      ? `${match.length} of ${recipes.length} recipes are within ${what}. Click a cuisine or a region to compare.`
      : `Showing all ${recipes.length} recipes. Click a cuisine or a region to compare, or drag across the timeline to pick dates.`;
  } else {
    text = `${inSel.length} recipes${what ? ` within ${what}` : ""} from ${list.length} ${list.length === 1 ? "cuisine" : "cuisines"} selected:`;
  }
  document.getElementById("selection-text").textContent = text;

  const chipData = [];
  if (datesActive()) chipData.push({ key: "__dates", label: dateText(), color: null });
  list.slice(0, 8).forEach(c => chipData.push({ key: c, label: c, color: REGION_COLORS[cuisineRegion[c]] }));
  d3.select("#chips").selectAll("button").data(chipData, d => d.key).join("button")
    .attr("class", "chip")
    .style("border-color", d => d.color)
    .text(d => `${d.label} ×`)
    .on("click", (e, d) => (d.key === "__dates" ? clearDates() : toggleCuisine(d.key)));
  document.getElementById("chips-more").textContent = list.length > 8 ? `+${list.length - 8} more` : "";
  document.getElementById("clear-btn").hidden = list.length === 0 && !datesActive();
}

// ---- cookbook: every recipe card you open is saved here ----
function loadBook() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOOK_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(id => byId.has(id)).slice(0, BOOK_MAX) : [];
  } catch (e) {
    return [];
  }
}
function persistBook() {
  try { localStorage.setItem(BOOK_KEY, JSON.stringify(state.book)); }
  catch (e) { /* storage unavailable: the cookbook still works for this visit */ }
}

// Returns true if the recipe was newly saved, false if it was already in the book.
function saveToBook(id) {
  if (state.book.includes(id)) return false;
  state.book.unshift(id);
  if (state.book.length > BOOK_MAX) state.book.length = BOOK_MAX;
  persistBook();
  renderBook();
  bumpBookButton();
  return true;
}
function removeFromBook(id) {
  state.book = state.book.filter(x => x !== id);
  persistBook();
  renderBook();
}
function clearBook() {
  state.book = [];
  persistBook();
  renderBook();
}

function renderBook() {
  document.getElementById("book-count").textContent = state.book.length;
  const items = state.book.map(id => byId.get(id)).filter(Boolean);
  const sub = items.length === 0
    ? "Open a recipe card and it will be saved here."
    : `${items.length} saved ${items.length === 1 ? "recipe" : "recipes"}, newest first. Click one to reopen it.`;
  const list = items.length === 0 ? "" :
    `<ul class="book-list">` +
    items.map(r =>
      `<li class="book-item" data-id="${esc(r.id)}">` +
        `<button class="book-open"><strong>${esc(r.name)}</strong>` +
        `<span class="book-meta"><span class="swatch" style="background:${REGION_COLORS[r.region]}"></span>` +
        `${esc(r.cuisine)}${r.total_time === null ? "" : " · " + esc(fmtTime(r.total_time))}</span></button>` +
        `<button class="book-remove" aria-label="Remove ${esc(r.name)} from the cookbook" title="Remove">×</button>` +
      `</li>`).join("") +
    `</ul><button class="btn-ghost book-clear" id="book-clear">Clear cookbook</button>`;
  document.getElementById("book-panel").innerHTML = `<h3 class="book-head">My Cookbook</h3><p class="book-sub">${sub}</p>${list}`;
}

function onBookClick(e) {
  if (e.target.closest("#book-clear")) { clearBook(); return; }
  const li = e.target.closest(".book-item");
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest(".book-remove")) removeFromBook(id);
  else { closeBook(); openCard(id); }
}

function toggleBook() { document.getElementById("book-panel").hidden ? openBook() : closeBook(); }
function openBook() {
  renderBook();
  document.getElementById("book-panel").hidden = false;
  document.getElementById("book-btn").setAttribute("aria-expanded", "true");
}
function closeBook() {
  document.getElementById("book-panel").hidden = true;
  document.getElementById("book-btn").setAttribute("aria-expanded", "false");
}
function bumpBookButton() {
  const b = document.getElementById("book-btn");
  b.classList.remove("bump");
  void b.offsetWidth; // restart the animation
  b.classList.add("bump");
}

// ---- recipe card: a side ticket ----
async function openCard(id) {
  hideTip();
  state.openId = id;
  state.lastId = id;
  const base = byId.get(id);
  const added = saveToBook(id);

  document.getElementById("card-backdrop").hidden = false;
  drawCard(base, added);
  updateRing();

  if (ingCache.has(id)) { fillIngredients(ingCache.get(id)); return; }
  fillIngredients(null);
  try {
    const res = await fetch(`${API_BASE}/api/recipes/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const full = await res.json();
    ingCache.set(id, full.ingredients);
    if (state.openId !== id) return;
    fillIngredients(full.ingredients);
  } catch (err) {
    console.error(err);
    if (state.openId === id) fillIngredients(undefined, true);
  }
}

function closeCard() {
  if (state.openId === null) return;
  state.openId = null;
  document.getElementById("card-backdrop").hidden = true;
  updateRing();
}

function drawCard(r, added) {
  const card = document.getElementById("card");
  const na = "not recorded";
  const rows = [
    ["Total time", r.total_time === null ? na : fmtTime(r.total_time)],
    ["Prep", r.prep_time === null ? na : fmtTime(r.prep_time)],
    ["Cook", r.cook_time === null ? na : fmtTime(r.cook_time)],
    ["Servings", r.servings === null ? na : r.servings],
    ["Calories", r.calories === null ? na : `${r.calories} kcal`],
    ["Rating", r.avg_rating === null ? "no ratings yet" : `${r.avg_rating} of 5 (${r.total_ratings} ratings)`],
    ["Published", r.date_published]
  ];
  const safeUrl = typeof r.url === "string" && r.url.startsWith("https://www.allrecipes.com/");
  card.innerHTML =
    `<button id="card-close" aria-label="Close recipe card">×</button>` +
    `<div class="ticket-head">Order up · ${esc(r.id)}</div>` +
    `<div class="saved-note">${added ? "Saved to your cookbook ✓" : "Already in your cookbook ✓"}</div>` +
    `<h3>${esc(r.name)}</h3>` +
    `<div class="tag"><span class="swatch" style="background:${REGION_COLORS[r.region]}"></span>${esc(r.cuisine)} · ${esc(r.region)}</div>` +
    `<dl style="margin:0">` +
    rows.map(([k, v]) => `<div class="kv"><dt>${esc(k)}</dt><span class="leader"></span><dd>${esc(v)}</dd></div>`).join("") +
    `</dl>` +
    `<h4>Ingredients</h4><div id="card-ing"></div>` +
    (safeUrl ? `<p class="directions"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">View on Allrecipes ↗</a></p>` : "");
  card.querySelector("#card-close").addEventListener("click", closeCard);
}

function fillIngredients(ingredients, failed = false) {
  const box = document.getElementById("card-ing");
  if (!box) return;
  box.innerHTML = "";
  if (failed) {
    box.innerHTML = `<p class="card-note">Could not load the ingredients. Is the server running?</p>`;
  } else if (ingredients === null) {
    box.innerHTML = `<p class="card-note">Loading ingredients...</p>`;
  } else if (!ingredients) {
    box.innerHTML = `<p class="card-note">No ingredient list is available for this recipe.</p>`;
  } else {
    // The source is one comma-joined string, so split only where a new quantity starts.
    const items = ingredients.split(/,\s+(?=[\d¼½¾⅓⅔⅛⅜⅝⅞])/).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    d3.select(box).append("ul").selectAll("li").data(items).join("li").text(d => d);
  }
}

function surprise() {
  const msg = document.getElementById("surprise-msg");
  const pool = matching();
  if (pool.length === 0) {
    msg.textContent = "Nothing matches those limits. Loosen a slider, widen the dates, or clear the selection.";
    return;
  }
  msg.textContent = `Picked from ${pool.length} matching recipes.`;
  openCard(pool[Math.floor(Math.random() * pool.length)].id);
}

// ---- tooltip: positioned at the pointer, flipped near the window edges ----
function placeTip(event, html) {
  tip.style("display", "block").html(html);
  const r = tip.node().getBoundingClientRect(), pad = 14;
  let left = event.clientX + pad, top = event.clientY + pad;
  if (left + r.width > window.innerWidth - 8) left = event.clientX - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = event.clientY - r.height - pad;
  tip.style("left", left + "px").style("top", top + "px");
}
function hideTip() { tip.style("display", "none"); }

init();