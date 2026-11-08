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

const state = { events: [], mine: null, homeId: null, selected: null, community: null, metric: "grid" };
let paths, svg, zoom, color;

// ---------- Community data (anonymous totals shared by Evergreen users) ----------
// community: Map of 2-letter country code → { users, prompts, wh, gco2e, ai_prompts, categories }
const comm = (c) => state.community?.get(c.code);

const METRICS = {
  grid: { label: "How much CO₂ the power grid emits (g CO₂e per kWh). Darker = dirtier electricity", value: (c) => c.grid, fmt: (v) => PP.fmtNum(Math.round(v)) },
  users: { label: "Evergreen users sharing data (last 30 days). Darker = more users", value: (c) => comm(c)?.users, fmt: (v) => PP.fmtNum(Math.round(v)), community: true },
  co2: { label: "CO₂ from Evergreen users' AI use (last 30 days). Darker = more", value: (c) => comm(c)?.gco2e, fmt: (v) => PP.fmtGrams(v), community: true },
  perUser: { label: "CO₂ per Evergreen user (last 30 days). Darker = more", value: (c) => (comm(c) ? comm(c).gco2e / comm(c).users : undefined), fmt: (v) => PP.fmtGrams(v), community: true },
  prompts: { label: "Prompts per user per day (last 30 days). Darker = more", value: (c) => (comm(c) ? comm(c).prompts / comm(c).users / PP.CLOUD.days : undefined), fmt: (v) => PP.fmtNum(v), community: true },
};

async function loadCommunity() {
  const status = $("community-status");
  if (!PP.cloudConfigured()) {
    status.textContent = "Community data isn't set up yet";
    return;
  }
  status.textContent = "Loading community data…";
  try {
    const rows = await PP.rpc("community_stats", { p_days: PP.CLOUD.days, p_min_users: PP.CLOUD.minUsersPerCountry });
    state.community = new Map(rows.map((r) => [r.country, { ...r, prompts: Number(r.prompts) }]));
    const users = rows.reduce((n, r) => n + r.users, 0);
    status.textContent = rows.length
      ? `${PP.fmtNum(users)} sharing user${users === 1 ? "" : "s"} in ${rows.length} countr${rows.length === 1 ? "y" : "ies"}`
      : "No countries have enough sharing users yet";
  } catch (e) {
    status.textContent = "Couldn't load community data";
    status.title = e.message;
  }
}

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

const pct = (x) => PP.fmtPct(x); // text: keeps small shares visible (0.3%, not 0%)
const width = (x) => `${x * 100}%`; // exact bar width
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
  const m = METRICS[state.metric];
  const values = PP.GRID.map(m.value).filter((v) => Number.isFinite(v));
  // Quantile bins spread the colors evenly across countries.
  // As many color steps as there are distinct values (up to 7), spread across
  // the ramp, so a map with few countries doesn't repeat legend labels.
  const n = Math.min(RAMP.length, new Set(values).size);
  const steps = n <= 1 ? [RAMP[4]] : Array.from({ length: n }, (_, i) => RAMP[Math.round((i * (RAMP.length - 1)) / (n - 1))]);
  color = values.length ? d3.scaleQuantile().domain(values).range(steps) : null;
  const fillFor = (d) => {
    const c = PP.gridById.get(d.id);
    const v = c && m.value(c);
    return Number.isFinite(v) && color ? color(v) : "var(--nodata)";
  };
  paths
    .attr("fill", fillFor)
    .classed("has-data", (d) => PP.gridById.has(d.id))
    .classed("home", (d) => d.id === state.homeId)
    .classed("selected", (d) => d.id === state.selected);
  // Draw the home country's outline on top of its neighbors.
  paths.filter((d) => d.id === state.homeId).raise();
  drawLegend(values);
}

function drawLegend(values) {
  const m = METRICS[state.metric];
  if (!color) {
    $("legend").replaceChildren(
      el("div", { className: "title" }, m.label),
      el("p", { className: "muted" }, "No community data to show yet. Turn on sharing in the popup to help fill the map.")
    );
    return;
  }
  const range = color.range();
  const thresholds = color.quantiles();
  const [min, max] = d3.extent(values);
  const bounds = [min, ...thresholds, max];
  const label = (v) => m.fmt(v);
  $("legend").replaceChildren(
    el("div", { className: "title" }, m.label),
    ...range.map((c, i) =>
      el("div", { className: "step", title: `${label(bounds[i])}–${label(bounds[i + 1])}` },
        el("div", { className: "chip", style: { background: c } }),
        el("span", {}, range.length === 1 ? label(min) : i === 0 ? `< ${label(bounds[1])}` : i === range.length - 1 ? `${label(bounds[i])}+` : label(bounds[i]))
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
      ? [
          ...(comm(c) ? [`${PP.fmtNum(comm(c).users)} Evergreen users · ${PP.fmtGrams(comm(c).gco2e)} CO₂e (30 days)`, el("br")] : []),
          `Grid: ${c.grid} g CO₂e per kWh`, el("br"),
          state.mine.prompts ? `Your AI use here: ${PP.fmtGrams(co2On(c.grid))} CO₂e` : "No usage tracked yet",
        ]
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
      ...sites.map((s) => el("span", { title: `${PP.SITES[s].name}: ${state.mine.sites[s]} prompts`, style: { width: width(state.mine.sites[s] / total), background: PP.siteColor(s) } }))
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

// The Evergreen community: everyone's shared totals, worldwide.
function communityBlock() {
  if (!state.community?.size) {
    return [
      el("h2", {}, "The Evergreen community"),
      el("p", { className: "muted" }, PP.cloudConfigured()
        ? "No countries have enough sharing users yet. Turn on \"Help build the world map\" in the popup to add your anonymous totals."
        : "Community data isn't set up in this version yet. Once it is, this shows how Evergreen users around the world use AI."),
    ];
  }
  const rows = [...state.community.values()];
  const users = rows.reduce((n, r) => n + r.users, 0);
  const prompts = rows.reduce((n, r) => n + r.prompts, 0);
  const g = rows.reduce((n, r) => n + r.gco2e, 0);
  const ai = aiTotals(rows.map((r) => r.ai_prompts));
  return [
    el("h2", {}, "The Evergreen community"),
    el("p", { className: "muted small-top" }, `Last ${PP.CLOUD.days} days, from users who chose to share.`),
    el("div", { className: "tiles" },
      tile(PP.fmtNum(users), "sharing users"),
      tile(PP.fmtNum(prompts / users / PP.CLOUD.days), "prompts per user per day"),
      tile(PP.fmtGrams(g), "CO₂e in total"),
      tile(PP.fmtGrams(g / users), "CO₂e per user")
    ),
    ...shareStack(ai, "Which AI the community uses"),
  ];
}

function aiTotals(list) {
  const out = {};
  for (const obj of list) for (const [k, v] of Object.entries(obj ?? {})) out[k] = (out[k] ?? 0) + Number(v);
  return out;
}

// A stacked bar + legend from { ai: prompts }.
function shareStack(counts, title) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sites = Object.keys(PP.SITES).filter((s) => counts[s]).sort((a, b) => counts[b] - counts[a]);
  if (!total) return [];
  return [
    el("h3", {}, title),
    el("div", { className: "stack", role: "img", "aria-label": sites.map((s) => `${PP.SITES[s].name} ${pct(counts[s] / total)}`).join(", ") },
      ...sites.map((s) => el("span", { title: `${PP.SITES[s].name}: ${PP.fmtNum(counts[s])} prompts`, style: { width: width(counts[s] / total), background: PP.siteColor(s) } }))
    ),
    el("ul", { className: "stack-legend" },
      ...sites.map((s) => el("li", {}, el("span", { className: "swatch", style: { background: PP.siteColor(s) } }), `${PP.SITES[s].name} ${pct(counts[s] / total)}`))
    ),
  ];
}

function drawOverview() {
  const m = state.mine;
  const panel = $("panel-overview");
  if (!m.prompts) {
    panel.replaceChildren(
      ...communityBlock(),
      el("h2", { className: "section-gap" }, "Your AI use"),
      el("p", { className: "muted" }, "No usage in this period yet. Use an AI chat site with Evergreen installed, press Load data in the popup, or import your past chats."),
      el("p", { className: "muted" }, "The map already shows how clean or dirty each country's electricity is.")
    );
    return;
  }
  const h = home();
  const cleanest = PP.GRID.reduce((a, b) => (b.grid < a.grid ? b : a));
  const dirtiest = PP.GRID.reduce((a, b) => (b.grid > a.grid ? b : a));
  const driving = PP.EQUIVALENTS.find((e) => e.id === "driving");

  panel.replaceChildren(
    ...communityBlock(),
    el("h2", { className: "section-gap" }, "Your AI use"),
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
    ...(comm(c)
      ? [
          el("h3", {}, `Evergreen users in ${c.name} (last ${PP.CLOUD.days} days)`),
          el("div", { className: "tiles" },
            tile(PP.fmtNum(comm(c).users), "sharing users"),
            tile(PP.fmtNum(comm(c).prompts / comm(c).users / PP.CLOUD.days), "prompts per user per day"),
            tile(PP.fmtGrams(comm(c).gco2e), "CO₂e in total"),
            tile(PP.fmtGrams(comm(c).gco2e / comm(c).users), "CO₂e per user")
          ),
          ...shareStack(Object.fromEntries(Object.entries(comm(c).ai_prompts ?? {}).map(([k, v]) => [k, Number(v)])), "Which AI they use"),
          el("h3", {}, "Your footprint on this grid"),
        ]
      : [el("p", { className: "muted" }, state.community ? `Not enough Evergreen users in ${c.name} share data yet to show community figures.` : "")]),
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
  // Sorted by whatever the map is colored by; countries without a value go last.
  const m = METRICS[state.metric];
  const val = (c) => (Number.isFinite(m.value(c)) ? m.value(c) : -Infinity);
  const rows = [...PP.GRID].sort((a, b) => val(b) - val(a) || b.grid - a.grid);
  document.querySelector("#ranking tbody").replaceChildren(
    ...rows.map((c, i) => {
      const cm = comm(c);
      const tr = el("tr", { className: [c.id === state.selected ? "selected" : "", c.id === state.homeId ? "home-row" : ""].join(" ") },
        el("td", {}, String(i + 1)),
        el("td", {}, c.name + (c.id === state.homeId ? " (you)" : "")),
        el("td", { className: "num" }, cm ? PP.fmtNum(cm.users) : "—"),
        el("td", { className: "num" }, cm ? PP.fmtGrams(cm.gco2e) : "—"),
        el("td", { className: "num" }, PP.fmtNum(c.grid)),
        el("td", { className: "num" }, state.mine.prompts ? PP.fmtGrams(co2On(c.grid)) : "—")
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
  await loadCommunity();

  // Color-by choice: community measures need community data.
  const { mapMetric } = await chrome.storage.local.get("mapMetric");
  const usable = (v) => METRICS[v] && !(METRICS[v].community && !state.community?.size);
  const updateMetricOptions = () => {
    for (const opt of $("metric").options) opt.disabled = !!METRICS[opt.value].community && !state.community?.size;
  };
  updateMetricOptions();
  state.metric = usable(mapMetric) ? mapMetric : state.community?.size ? "users" : "grid";
  $("metric").value = state.metric;
  $("metric").addEventListener("change", () => {
    state.metric = $("metric").value;
    chrome.storage.local.set({ mapMetric: state.metric });
    refresh();
  });

  refresh();

  // Keep the community data fresh while the map is open: every minute, and
  // when you come back to this tab.
  let hadData = !!state.community?.size;
  let lastLoad = Date.now();
  async function reloadCommunity() {
    if (!PP.cloudConfigured() || document.hidden) return;
    lastLoad = Date.now();
    await loadCommunity();
    updateMetricOptions();
    // First community data arrived: switch from the grid view to users.
    if (!hadData && state.community?.size && state.metric === "grid" && !mapMetric) {
      state.metric = "users";
      $("metric").value = "users";
    }
    if (!usable(state.metric)) {
      state.metric = "grid";
      $("metric").value = "grid";
    }
    hadData = !!state.community?.size;
    refresh();
  }
  setInterval(reloadCommunity, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastLoad > 15000) reloadCommunity();
  });

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
