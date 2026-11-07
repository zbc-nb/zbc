// map.js: the interactive world map. Draws countries with D3, colors them by
// the chosen measure, and shows details and charts when you click a country.

const $ = (id) => document.getElementById(id);
const dark = matchMedia("(prefers-color-scheme: dark)").matches;

// Sequential blue scale (one hue, light → dark) from the dataviz palette.
// In dark mode the order flips so "low" fades into the dark background.
const RAMP_LIGHT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const RAMP = dark ? [...RAMP_LIGHT].reverse() : RAMP_LIGHT;

const METRICS = {
  gco2e: { label: "CO₂ emissions per week", value: (c) => c.gco2e, fmt: PP.fmtGrams },
  wh: { label: "Electricity used per week", value: (c) => c.wh, fmt: PP.fmtWh },
  perUser: { label: "CO₂ per user per week", value: (c) => c.gco2e / c.users, fmt: PP.fmtGrams },
  prompts: { label: "Prompts per week", value: (c) => c.prompts, fmt: (n) => PP.fmtNum(n) },
  grid: { label: "Grid carbon intensity (g CO₂e per kWh)", value: (c) => c.grid, fmt: (n) => `${PP.fmtNum(n)} g/kWh` },
};

let state = { metric: "gco2e", selected: null, data: null, byId: new Map(), myWeek: null };
let paths, svg, g, zoom, color;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("aria-") || k === "role") node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

const topEntry = (shares) => Object.entries(shares).sort((a, b) => b[1] - a[1])[0];
const pct = (x) => `${Math.round(x * 100)}%`;

// ---------- Map ----------

async function drawMap() {
  const topo = await (await fetch(chrome.runtime.getURL("data/countries-110m.json"))).json();
  const countries = topojson.feature(topo, topo.objects.countries).features
    .filter((f) => f.properties.name !== "Antarctica");

  const width = 960, height = 500;
  svg = d3.select("#map").attr("viewBox", `0 0 ${width} ${height}`);
  const projection = d3.geoNaturalEarth1().fitSize([width, height], { type: "FeatureCollection", features: countries });
  const path = d3.geoPath(projection);

  g = svg.append("g");
  paths = g.selectAll("path")
    .data(countries)
    .join("path")
    .attr("class", (d) => "country" + (state.byId.has(d.id) ? " has-data" : ""))
    .attr("d", path)
    .on("mousemove", showTooltip)
    .on("mouseleave", hideTooltip)
    .on("click", (event, d) => {
      if (state.byId.has(d.id)) selectCountry(d.id);
    });

  zoom = d3.zoom()
    .scaleExtent([1, 8])
    .translateExtent([[0, 0], [width, height]])
    .on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoom);

  $("zoom-in").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1.6);
  $("zoom-out").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.6);
  $("zoom-reset").onclick = () => svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);

  // Remember the path generator so we can zoom to a country later.
  state.path = path;
  state.size = { width, height };
}

function recolor() {
  const m = METRICS[state.metric];
  const values = state.data.countries.map(m.value);
  // Quantile bins spread colors evenly even when a few countries are huge.
  color = d3.scaleQuantile().domain(values).range(RAMP);

  paths
    .attr("fill", (d) => {
      const c = state.byId.get(d.id);
      return c ? color(m.value(c)) : "var(--nodata)";
    })
    .classed("selected", (d) => d.id === state.selected);

  drawLegend();
  drawTable();
}

function drawLegend() {
  const m = METRICS[state.metric];
  const thresholds = color.quantiles();
  const [min, max] = d3.extent(state.data.countries, m.value);
  const bounds = [min, ...thresholds, max];

  $("legend").replaceChildren(
    el("div", { className: "title" }, m.label),
    ...RAMP.map((c, i) =>
      el("div", { className: "step", title: `${m.fmt(bounds[i])} – ${m.fmt(bounds[i + 1])}` },
        el("div", { className: "chip", style: { background: c } }),
        el("span", {}, i === 0 ? `< ${m.fmt(bounds[1])}` : i === RAMP.length - 1 ? `${m.fmt(bounds[i])}+` : m.fmt(bounds[i]))
      )
    ),
    el("div", { className: "step nodata" },
      el("div", { className: "chip", style: { background: "var(--nodata)" } }),
      el("span", {}, "No data")
    )
  );
}

function showTooltip(event, d) {
  const tip = $("tooltip");
  const c = state.byId.get(d.id);
  const m = METRICS[state.metric];
  tip.replaceChildren(
    el("strong", {}, c?.name ?? d.properties.name),
    c ? `${m.label}: ${m.fmt(m.value(c))}` : "No data yet"
  );
  tip.hidden = false;
  const box = $("map-wrap").getBoundingClientRect();
  let x = event.clientX - box.left + 14;
  const y = event.clientY - box.top + 14;
  if (x + tip.offsetWidth > box.width) x = event.clientX - box.left - tip.offsetWidth - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTooltip() {
  $("tooltip").hidden = true;
}

function zoomToCountry(id) {
  const feature = paths.data().find((f) => f.id === id);
  if (!feature) return;
  const [[x0, y0], [x1, y1]] = state.path.bounds(feature);
  const { width, height } = state.size;
  const scale = Math.min(6, 0.8 / Math.max((x1 - x0) / width, (y1 - y0) / height));
  const t = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(Math.max(1, scale))
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  svg.transition().duration(600).call(zoom.transform, t);
}

// ---------- Side panel ----------

function tile(value, label) {
  return el("div", { className: "tile" }, el("div", { className: "v" }, value), el("div", { className: "l" }, label));
}

function worldTotals() {
  const cs = state.data.countries;
  const sum = (f) => cs.reduce((n, c) => n + f(c), 0);
  return { users: sum((c) => c.users), prompts: sum((c) => c.prompts), wh: sum((c) => c.wh), gco2e: sum((c) => c.gco2e) };
}

function drawWorldPanel() {
  const w = worldTotals();
  const driving = PP.EQUIVALENTS.find((e) => e.id === "driving");
  $("world-tiles").replaceChildren(
    tile(PP.fmtNum(w.users), "users"),
    tile(PP.fmtNum(w.prompts), "prompts / week"),
    tile(PP.fmtWh(w.wh), "electricity / week"),
    tile(PP.fmtGrams(w.gco2e), "CO₂e / week")
  );
  $("world-tiles").after(
    el("p", { className: "headline" }, "Every week, that's about the same as ", el("strong", {}, driving.describe(w.gco2e)), ".")
  );
}

function shareStack(shares) {
  const sites = Object.keys(PP.SITES).filter((s) => shares[s] > 0);
  return [
    el("div", { className: "stack", role: "img", "aria-label": sites.map((s) => `${PP.SITES[s].name} ${pct(shares[s])}`).join(", ") },
      ...sites.map((s) => el("span", { title: `${PP.SITES[s].name}: ${pct(shares[s])}`, style: { width: pct(shares[s]), background: PP.siteColor(s) } }))
    ),
    el("ul", { className: "stack-legend" },
      ...sites.map((s) => el("li", {}, el("span", { className: "swatch", style: { background: PP.siteColor(s) } }), `${PP.SITES[s].name} ${pct(shares[s])}`))
    ),
  ];
}

function categoryBars(shares) {
  const sorted = Object.entries(shares).sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];
  return sorted.map(([cat, share], i) =>
    el("div", { className: "hbar" + (i === 0 ? " top" : ""), title: `${cat}: ${pct(share)} of prompts` },
      el("span", {}, cat),
      el("div", { className: "track" }, el("div", { className: "fill", style: { width: `${(share / max) * 100}%` } })),
      el("span", { className: "pct" }, pct(share))
    )
  );
}

function drawCountryPanel(c) {
  const w = worldTotals();
  const perUser = c.gco2e / c.users;
  const worldPerUser = w.gco2e / w.users;
  const diff = (perUser - worldPerUser) / worldPerUser;
  const [topCat, topShare] = topEntry(c.categoryShare);
  const [topSite, topSiteShare] = topEntry(c.siteShare);
  const driving = PP.EQUIVALENTS.find((e) => e.id === "driving");

  const youRow = state.myWeek
    ? el("p", { className: "compare-row" },
        "You: ", el("strong", {}, `${PP.fmtGrams(state.myWeek.g)} CO₂e`), ` this week vs. ${PP.fmtGrams(perUser)} for an average user here.`)
    : el("p", { className: "compare-row muted" }, "Use PromptPrint for a while to compare yourself with this country.");

  $("panel-country").replaceChildren(
    el("button", { className: "back", onclick: () => selectCountry(null) }, "← World overview"),
    el("h2", {}, c.name),
    el("div", { className: "tiles" },
      tile(PP.fmtNum(c.users), "users"),
      tile(PP.fmtNum(c.prompts), "prompts / week"),
      tile(PP.fmtWh(c.wh), "electricity / week"),
      tile(PP.fmtGrams(c.gco2e), "CO₂e / week"),
      tile(PP.fmtGrams(perUser), "CO₂e per user / week"),
      tile(`${PP.fmtNum(c.grid)} g`, "CO₂e per kWh on the grid")
    ),
    el("p", { className: "headline" },
      "Mostly used for ", el("strong", {}, `${topCat} (${pct(topShare)})`),
      `, most often on ${PP.SITES[topSite].name} (${pct(topSiteShare)}).`
    ),
    el("p", { className: "muted" },
      `Per user, that's ${pct(Math.abs(diff))} ${diff >= 0 ? "above" : "below"} the world average. `,
      `The whole country's weekly AI use ≈ ${driving.describe(c.gco2e)}.`
    ),
    el("h3", {}, "Which AI people use"),
    ...shareStack(c.siteShare),
    el("h3", {}, "What they use it for"),
    ...categoryBars(c.categoryShare),
    youRow
  );
}

function selectCountry(id) {
  state.selected = id;
  paths.classed("selected", (d) => d.id === id);
  document.querySelectorAll("#ranking tbody tr").forEach((tr) => tr.classList.toggle("selected", tr.dataset.id === id));
  $("panel-empty").hidden = !!id;
  $("panel-country").hidden = !id;
  if (id) {
    drawCountryPanel(state.byId.get(id));
    zoomToCountry(id);
  } else {
    svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
  }
}

// ---------- Ranking table (also an accessible, non-visual view of the map) ----------

function drawTable() {
  const m = METRICS[state.metric];
  $("table-metric-label").textContent = `Sorted by ${m.label}`;
  const rows = [...state.data.countries].sort((a, b) => m.value(b) - m.value(a));
  document.querySelector("#ranking tbody").replaceChildren(
    ...rows.map((c, i) => {
      const tr = el("tr", { className: c.id === state.selected ? "selected" : "" },
        el("td", {}, String(i + 1)),
        el("td", {}, c.name),
        el("td", { className: "num" }, PP.fmtNum(c.users)),
        el("td", { className: "num" }, PP.fmtNum(c.prompts)),
        el("td", { className: "num" }, PP.fmtWh(c.wh)),
        el("td", { className: "num" }, PP.fmtGrams(c.gco2e)),
        el("td", { className: "num" }, PP.fmtGrams(c.gco2e / c.users)),
        el("td", {}, topEntry(c.categoryShare)[0])
      );
      tr.dataset.id = c.id;
      tr.onclick = () => {
        selectCountry(c.id);
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
      return tr;
    })
  );
}

// ---------- Your own week, for the "You vs. this country" comparison ----------

async function loadMyWeek() {
  try {
    const { events = [] } = await chrome.storage.local.get("events");
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const week = events.filter((e) => e.timestamp > since);
    if (week.length) state.myWeek = { g: week.reduce((n, e) => n + e.gco2e, 0) };
  } catch {
    state.myWeek = null;
  }
}

// ---------- Start ----------

(async function init() {
  state.data = await getCommunityData();
  state.byId = new Map(state.data.countries.map((c) => [c.id, c]));
  $("sample-badge").hidden = !state.data.sample;

  await Promise.all([drawMap(), loadMyWeek()]);
  drawWorldPanel();
  recolor();

  $("metric").addEventListener("change", (e) => {
    state.metric = e.target.value;
    recolor();
  });
})();
