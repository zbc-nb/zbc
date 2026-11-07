// map.js: the interactive world map. Colors countries by how much CO₂ their
// electricity grid emits, and shows what YOUR real AI usage would emit on each
// grid. All usage numbers come from this browser's tracked data.

const $ = (id) => document.getElementById(id);
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const DAY = 24 * 60 * 60 * 1000;

// Sequential blue scale (one hue, light → dark) from the dataviz palette.
// In dark mode the order flips so "low" fades into the dark background.
const RAMP_LIGHT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const RAMP = dark ? [...RAMP_LIGHT].reverse() : RAMP_LIGHT;
const AVERAGE = { id: null, name: "an average country", grid: PP.DEFAULT_GRID_G_PER_KWH };

const state = { events: [], mine: null, homeId: null, selected: null };
let paths, svg, zoom, color;

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

const pct = (x) => `${Math.round(x * 100)}%`;
const home = () => PP.gridById.get(state.homeId) ?? AVERAGE;
const co2On = (grid) => ((state.mine?.wh ?? 0) / 1000) * grid;

function ratioText(a, b) {
  if (!b) return "";
  const r = a / b;
  if (Math.abs(r - 1) < 0.05) return "about the same";
  return r > 1 ? `${PP.fmtNum(r)}× more` : `${PP.fmtNum(1 / r)}× less`;
}

// ---------- Your usage ----------

function summarize() {
  const period = $("period").value;
  const since = period === "all" ? 0 : Date.now() - Number(period) * DAY;
  const events = state.events.filter((e) => e.timestamp > since);
  const count = (key) => {
    const out = {};
    for (const e of events) out[e[key]] = (out[e[key]] ?? 0) + 1;
    return out;
  };
  state.mine = {
    prompts: events.length,
    wh: events.reduce((n, e) => n + e.wh, 0),
    sites: count("site"),
    categories: count("category"),
  };
}

// ---------- Map ----------

async function drawMap() {
  const topo = await (await fetch(chrome.runtime.getURL("data/countries-110m.json"))).json();
  const countries = topojson.feature(topo, topo.objects.countries).features
    .filter((f) => f.properties.name !== "Antarctica");

  const width = 960, height = 500;
  svg = d3.select("#map").attr("viewBox", `0 0 ${width} ${height}`);
  const projection = d3.geoNaturalEarth1().fitSize([width, height], { type: "FeatureCollection", features: countries });
  const path = d3.geoPath(projection);

  const g = svg.append("g");
  paths = g.selectAll("path")
    .data(countries)
    .join("path")
    .attr("class", (d) => "country" + (PP.gridById.has(d.id) ? " has-data" : ""))
    .attr("d", path)
    .on("mousemove", showTooltip)
    .on("mouseleave", () => ($("tooltip").hidden = true))
    .on("click", (event, d) => {
      if (PP.gridById.has(d.id)) selectCountry(d.id);
    });

  zoom = d3.zoom()
    .scaleExtent([1, 8])
    .translateExtent([[0, 0], [width, height]])
    .on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoom);

  $("zoom-in").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1.6);
  $("zoom-out").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.6);
  $("zoom-reset").onclick = () => svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);

  state.path = path;
  state.size = { width, height };
}

function recolor() {
  // Quantile bins spread the colors evenly across countries.
  color = d3.scaleQuantile().domain(PP.GRID.map((c) => c.grid)).range(RAMP);
  paths
    .attr("fill", (d) => (PP.gridById.has(d.id) ? color(PP.gridById.get(d.id).grid) : "var(--nodata)"))
    .classed("home", (d) => d.id === state.homeId)
    .classed("selected", (d) => d.id === state.selected);
  // Draw the home country's outline on top of its neighbors.
  paths.filter((d) => d.id === state.homeId).raise();
  drawLegend();
}

function drawLegend() {
  const thresholds = color.quantiles();
  const [min, max] = d3.extent(PP.GRID, (c) => c.grid);
  const bounds = [min, ...thresholds, max];
  const label = (g) => PP.fmtNum(Math.round(g));
  $("legend").replaceChildren(
    el("div", { className: "title" }, "How much CO₂ the power grid emits (g CO₂e per kWh). Darker = dirtier electricity"),
    ...RAMP.map((c, i) =>
      el("div", { className: "step", title: `${label(bounds[i])}–${label(bounds[i + 1])} g/kWh` },
        el("div", { className: "chip", style: { background: c } }),
        el("span", {}, i === 0 ? `< ${label(bounds[1])}` : i === RAMP.length - 1 ? `${label(bounds[i])}+` : label(bounds[i]))
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
  const c = PP.gridById.get(d.id);
  tip.replaceChildren(
    el("strong", {}, (c?.name ?? d.properties.name) + (d.id === state.homeId ? " (you)" : "")),
    ...(c
      ? [`Grid: ${c.grid} g CO₂e per kWh`, el("br"), state.mine.prompts ? `Your AI use here: ${PP.fmtGrams(co2On(c.grid))} CO₂e` : "No usage tracked yet"]
      : ["No grid data"])
  );
  tip.hidden = false;
  const box = $("map-wrap").getBoundingClientRect();
  let x = event.clientX - box.left + 14;
  if (x + tip.offsetWidth > box.width) x = event.clientX - box.left - tip.offsetWidth - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${event.clientY - box.top + 14}px`;
}

function zoomTo(id) {
  const feature = paths.data().find((f) => f.id === id);
  if (!feature) return;
  const [[x0, y0], [x1, y1]] = state.path.bounds(feature);
  const { width, height } = state.size;
  const scale = Math.max(1, Math.min(6, 0.8 / Math.max((x1 - x0) / width, (y1 - y0) / height)));
  const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  svg.transition().duration(600).call(zoom.transform, t);
}

// ---------- Side panel ----------

const tile = (value, label) =>
  el("div", { className: "tile" }, el("div", { className: "v" }, value), el("div", { className: "l" }, label));

function siteStack() {
  const total = state.mine.prompts;
  const sites = Object.keys(PP.SITES).filter((s) => state.mine.sites[s]);
  return [
    el("div", { className: "stack", role: "img", "aria-label": sites.map((s) => `${PP.SITES[s].name} ${pct(state.mine.sites[s] / total)}`).join(", ") },
      ...sites.map((s) => el("span", { title: `${PP.SITES[s].name}: ${state.mine.sites[s]} prompts`, style: { width: pct(state.mine.sites[s] / total), background: PP.siteColor(s) } }))
    ),
    el("ul", { className: "stack-legend" },
      ...sites.map((s) => el("li", {}, el("span", { className: "swatch", style: { background: PP.siteColor(s) } }), `${PP.SITES[s].name} ${pct(state.mine.sites[s] / total)}`))
    ),
  ];
}

function categoryBars() {
  const total = state.mine.prompts;
  const sorted = Object.entries(state.mine.categories).sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];
  return sorted.map(([cat, n], i) =>
    el("div", { className: "hbar" + (i === 0 ? " top" : ""), title: `${cat}: ${n} prompts` },
      el("span", {}, cat),
      el("div", { className: "track" }, el("div", { className: "fill", style: { width: `${(n / max) * 100}%` } })),
      el("span", { className: "pct" }, pct(n / total))
    )
  );
}

function drawOverview() {
  const m = state.mine;
  const panel = $("panel-overview");
  if (!m.prompts) {
    panel.replaceChildren(
      el("h2", {}, "No usage in this period yet"),
      el("p", { className: "muted" }, "Use ChatGPT, Claude or Gemini with PromptPrint installed, press Load data in the popup, or import your past chats. Then come back here."),
      el("p", { className: "muted" }, "The map already shows how clean or dirty each country's electricity is.")
    );
    return;
  }
  const h = home();
  const cleanest = PP.GRID.reduce((a, b) => (b.grid < a.grid ? b : a));
  const dirtiest = PP.GRID.reduce((a, b) => (b.grid > a.grid ? b : a));
  const driving = PP.EQUIVALENTS.find((e) => e.id === "driving");

  panel.replaceChildren(
    el("h2", {}, "Your AI use"),
    el("div", { className: "tiles" },
      tile(PP.fmtNum(m.prompts), "prompts"),
      tile(PP.fmtWh(m.wh), "electricity"),
      tile(PP.fmtGrams(co2On(h.grid)), h.id ? `CO₂e on the grid in ${h.name}` : "CO₂e on an average grid"),
      tile(`${h.grid} g`, "CO₂e per kWh there")
    ),
    el("p", { className: "headline" },
      "The same prompts would emit ", el("strong", {}, PP.fmtGrams(co2On(cleanest.grid))), ` in ${cleanest.name} but `,
      el("strong", {}, PP.fmtGrams(co2On(dirtiest.grid))), ` in ${dirtiest.name}: ${PP.fmtNum(dirtiest.grid / cleanest.grid)}× more.`
    ),
    el("p", { className: "muted" }, `On ${h.id ? "your" : "an average"} grid, that's about ${driving.describe(co2On(h.grid))}.`),
    el("h3", {}, "Which AI you use"),
    ...siteStack(),
    el("h3", {}, "What you use it for"),
    ...categoryBars(),
    el("p", { className: "muted small" }, "Click a country on the map to see your footprint there.")
  );
}

function drawCountry(c) {
  const h = home();
  const mine = co2On(c.grid);
  const isHome = c.id === state.homeId;
  const driving = PP.EQUIVALENTS.find((e) => e.id === "driving");
  $("panel-country").replaceChildren(
    el("button", { className: "back", onclick: () => selectCountry(null) }, "← Back to your overview"),
    el("h2", {}, c.name, ...(isHome ? [el("span", { className: "tag" }, "your country")] : [])),
    el("div", { className: "tiles" },
      tile(`${c.grid} g`, "CO₂e per kWh on the grid"),
      tile(state.mine.prompts ? PP.fmtGrams(mine) : "—", "your AI use here"),
      tile(PP.fmtWh(state.mine.wh), "electricity (same everywhere)"),
      tile(isHome ? "—" : ratioText(c.grid, h.grid), isHome ? "this is your country" : `than ${h.id ? h.name : "average"}`)
    ),
    el("p", { className: "headline" },
      ...(state.mine.prompts
        ? [`If your ${PP.fmtNum(state.mine.prompts)} prompts ran on the grid in ${c.name}, they'd emit `, el("strong", {}, `${PP.fmtGrams(mine)} CO₂e`), `, about ${driving.describe(mine)}.`]
        : [`Electricity in ${c.name} emits `, el("strong", {}, `${c.grid} g CO₂e per kWh`), "."])
    ),
    el("p", { className: "muted" },
      c.grid < 150 ? "Clean grid: mostly hydro, nuclear, wind or solar." :
      c.grid < 400 ? "Mixed grid: a blend of clean sources and fossil fuels." :
      "Carbon-heavy grid: relies mostly on coal, oil or gas."
    ),
    ...(isHome ? [] : [el("button", { className: "set-home", onclick: () => setHome(c.id) }, `Set ${c.name} as my country`)])
  );
}

function selectCountry(id) {
  state.selected = id;
  paths.classed("selected", (d) => d.id === id);
  document.querySelectorAll("#ranking tbody tr").forEach((tr) => tr.classList.toggle("selected", tr.dataset.id === id));
  $("panel-overview").hidden = !!id;
  $("panel-country").hidden = !id;
  if (id) {
    drawCountry(PP.gridById.get(id));
    zoomTo(id);
  } else {
    svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
  }
}

// ---------- Ranking table (also an accessible, non-visual view of the map) ----------

function drawTable() {
  const h = home();
  const rows = [...PP.GRID].sort((a, b) => b.grid - a.grid);
  document.querySelector("#ranking tbody").replaceChildren(
    ...rows.map((c, i) => {
      const tr = el("tr", { className: [c.id === state.selected ? "selected" : "", c.id === state.homeId ? "home-row" : ""].join(" ") },
        el("td", {}, String(i + 1)),
        el("td", {}, c.name + (c.id === state.homeId ? " (you)" : "")),
        el("td", { className: "num" }, PP.fmtNum(c.grid)),
        el("td", { className: "num" }, state.mine.prompts ? PP.fmtGrams(co2On(c.grid)) : "—"),
        el("td", { className: "num" }, c.id === state.homeId ? "—" : ratioText(c.grid, h.grid))
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

// ---------- Settings ----------

function setHome(id) {
  state.homeId = id || null;
  $("home").value = id ?? "";
  chrome.storage.local.set({ country: state.homeId });
  refresh();
}

function refresh() {
  summarize();
  recolor();
  drawOverview();
  drawTable();
  if (state.selected) drawCountry(PP.gridById.get(state.selected));
}

// ---------- Start ----------

(async function init() {
  const { events = [], country, period } = await chrome.storage.local.get(["events", "country", "period"]);
  state.events = events;
  state.homeId = country ?? PP.guessCountryId();
  if (period && $("period").querySelector(`option[value="${period}"]`)) $("period").value = period;

  $("home").replaceChildren(
    el("option", { value: "" }, "Not set (use average)"),
    ...[...PP.GRID].sort((a, b) => a.name.localeCompare(b.name)).map((c) => el("option", { value: c.id }, c.name))
  );
  $("home").value = state.homeId ?? "";

  await drawMap();
  refresh();

  $("period").addEventListener("change", () => {
    chrome.storage.local.set({ period: $("period").value });
    refresh();
  });
  $("home").addEventListener("change", (e) => setHome(e.target.value));

  // Update live when new prompts are tracked.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.events) {
      state.events = changes.events.newValue ?? [];
      refresh();
    }
  });
})();
