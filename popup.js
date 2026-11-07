// popup.js: fills in the popup from the usage saved by background.js.
// Sections: totals, everyday comparison, "How does your usage compare?" with
// the plant, Which AI you use, tasks, suggestions, connected platforms,
// manual log, and the Load / Import / Clear actions.

// Names, colors, comparisons and number formatting come from lib/constants.js
const SITE_INFO = Object.fromEntries(
  Object.entries(PP.SITES).map(([id, s]) => [id, { name: s.name, color: PP.siteColor(id) }])
);
SITE_INFO.other = { name: "Other AIs", color: PP.siteColor("other") };

// Lower-impact alternatives for each kind of task.
const ALTERNATIVES = {
  Math: ["your textbook's worked examples", "Khan Academy", "Desmos", "Wolfram Alpha", "Paul's Online Math Notes", "office hours or the tutoring center"],
  Coding: ["the official docs (MDN, Python docs)", "Stack Overflow search", "your editor's autocomplete", "rubber-duck debugging"],
  Writing: ["Purdue OWL", "your campus writing center", "a thesaurus", "your editor's built-in grammar check"],
  Research: ["a regular web search", "Wikipedia", "your library's databases"],
  Brainstorm: ["5 minutes of solo brainstorming first", "a mind map", "asking a classmate"],
};

const DAY = 24 * 60 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);

const state = { events: [], current: [], grid: null, waterRate: PP.DEFAULT_WATER_L_PER_KWH, granted: new Set() };

function groupBy(arr, key) {
  const out = {};
  for (const x of arr) (out[x[key]] ??= []).push(x);
  return out;
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

// Charts stay readable with at most 5 AIs: smaller ones are grouped as "Other AIs".
const MAX_SITES_SHOWN = 5;
function foldSites(events) {
  const counts = {};
  for (const e of events) counts[e.site] = (counts[e.site] ?? 0) + 1;
  const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (ranked.length <= MAX_SITES_SHOWN) return events;
  const keep = new Set(ranked.slice(0, MAX_SITES_SHOWN - 1));
  return events.map((e) => (keep.has(e.site) ? e : { ...e, site: "other" }));
}

// ---------- Date range ----------
const RANGES = {
  today: "today",
  week: "this week",
  month: "this month",
  all: "in total",
};
const currentRange = () => document.querySelector('input[name="range"]:checked')?.value ?? "week";

function dayStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return +d;
}

function rangeStart(range, events) {
  const today = new Date(dayStart(Date.now()));
  if (range === "today") return +today;
  if (range === "week") return +new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  if (range === "month") return +new Date(today.getFullYear(), today.getMonth(), 1);
  return events.length ? dayStart(Math.min(...events.map((e) => e.timestamp))) : +today;
}

// ---------- Unit helpers (number and unit shown separately) ----------
const splitGrams = (g) => (g >= 1000 ? [PP.fmtNum(g / 1000), "kg CO₂e"] : [PP.fmtNum(g), "g CO₂e"]);
const splitWh = (wh) => (wh >= 1000 ? [PP.fmtNum(wh / 1000), "kWh"] : [PP.fmtNum(wh), "Wh"]);
const splitLiters = (l) => (l >= 1 ? [PP.fmtNum(l), "liters"] : [PP.fmtNum(l * 1000), "mL"]);
const waterLiters = (wh) => (wh / 1000) * state.waterRate;

// ---------- Totals ----------
function renderTotals(events, start) {
  const g = sum(events, (e) => e.gco2e);
  const wh = sum(events, (e) => e.wh);
  const tokens = sum(events, (e) => (e.promptTokens ?? 0) + (e.responseTokens ?? 0));
  const [gv, gu] = splitGrams(g);
  const [wv, wu] = splitWh(wh);
  const [lv, lu] = splitLiters(waterLiters(wh));
  $("m-co2").textContent = gv;
  $("m-co2-unit").textContent = gu;
  $("m-co2-foot").textContent = events.length ? `Likely ${PP.fmtGrams(g * PP.UNCERTAINTY.low)}–${PP.fmtGrams(g * PP.UNCERTAINTY.high)}` : "Nothing recorded yet";
  $("m-prompts").textContent = events.length.toLocaleString();
  $("m-tokens").textContent = tokens.toLocaleString();
  $("m-wh").textContent = wv;
  $("m-wh-unit").textContent = wu;
  $("m-water").textContent = lv;
  $("m-water-unit").textContent = lu;
  $("water-rate-label").textContent = state.waterRate;
  $("about-range").textContent = `${PP.fmtGrams(g * PP.UNCERTAINTY.low)}–${PP.fmtGrams(g * PP.UNCERTAINTY.high)} CO₂e`;

  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("date-range").textContent = `${fmtDate(start)} — ${fmtDate(Date.now())}, ${new Date().getFullYear()} · ${events.length.toLocaleString()} prompt${events.length === 1 ? "" : "s"}`;
}

// ---------- Everyday comparison ----------
function setupEquivalentSelect() {
  const select = $("equiv-select");
  select.replaceChildren(...PP.EQUIVALENTS.map((eq) => el("option", { value: eq.id }, eq.label)));
  select.addEventListener("change", () => {
    chrome.storage.local.set({ equivChoice: select.value });
    renderEquivalent();
  });
}

function renderEquivalent() {
  const eq = PP.EQUIVALENTS.find((x) => x.id === $("equiv-select").value) ?? PP.EQUIVALENTS[0];
  const g = sum(state.current, (e) => e.gco2e);
  const wh = sum(state.current, (e) => e.wh);
  if (!state.current.length) {
    $("equiv-value").textContent = "Nothing yet";
    $("equiv-desc").textContent = "Use AI or import your history to see a comparison.";
    return;
  }
  const amount = eq.basis === "g" ? g : eq.basis === "water" ? waterLiters(wh) : wh;
  const text = eq.describe(amount);
  // Split "3.2 hours of a 10 W LED bulb" into a big value and a description.
  const m = text.match(/^(boiling\s)?([\d.,<>]+\s?\S*)\s(.*)$/);
  if (m && !m[1]) {
    $("equiv-value").textContent = m[2];
    $("equiv-desc").textContent = m[3];
  } else {
    $("equiv-value").textContent = text;
    $("equiv-desc").textContent = "";
  }
  const basis = { g: "by CO₂", wh: "by electricity", water: `by cooling water at ${state.waterRate} L/kWh` }[eq.basis];
  $("equiv-desc").textContent += ` (${basis})`;
}

// ---------- How does your usage compare? (with the plant) ----------
// Your daily prompts are compared with the average user's, and the plant
// reacts to the difference.

function plantSvg(stage) {
  const pot = `<ellipse cx="75" cy="141" rx="44" ry="5" style="fill:var(--track)"/>
    <path d="M50 106 h50 l-7 32 h-36 z" style="fill:var(--pot)"/>
    <rect x="46" y="98" width="58" height="11" rx="3" style="fill:var(--pot-rim)"/>`;
  const shapes = {
    seed: `<path d="M75 98 V80" style="stroke:var(--stem)" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M75 84 C 66 84, 60 78, 58 70 C 68 70, 74 75, 75 84 Z" style="fill:var(--leaf-2)"/>
      <path d="M75 82 C 84 82, 90 76, 92 68 C 82 68, 76 73, 75 82 Z" style="fill:var(--leaf-2)"/>`,
    thriving: `<path d="M75 98 V46" style="stroke:var(--stem)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M75 80 C 52 80, 40 66, 38 48 C 58 48, 72 58, 75 80 Z" style="fill:var(--leaf)"/>
      <path d="M75 72 C 96 72, 110 58, 112 40 C 92 40, 78 50, 75 72 Z" style="fill:var(--leaf)"/>
      <path d="M75 58 C 60 54, 54 40, 56 26 C 70 30, 78 42, 75 58 Z" style="fill:var(--leaf-2)"/>
      <path d="M75 54 C 88 48, 94 36, 92 22 C 80 28, 74 40, 75 54 Z" style="fill:var(--leaf-2)"/>
      <circle cx="75" cy="40" r="5" style="fill:#f2c94c"/>`,
    okay: `<path d="M75 98 C 75 80, 73 66, 76 54" style="stroke:var(--stem)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M75 82 C 54 84, 42 74, 38 60 C 56 58, 70 66, 75 82 Z" style="fill:var(--leaf)"/>
      <path d="M75 74 C 94 76, 106 66, 110 52 C 92 50, 79 58, 75 74 Z" style="fill:var(--leaf)"/>
      <path d="M76 60 C 66 54, 62 44, 64 34 C 74 38, 78 48, 76 60 Z" style="fill:var(--leaf-2)"/>`,
    pale: `<path d="M75 98 C 75 84, 74 72, 78 62" style="stroke:var(--stem-pale)" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M75 84 C 58 88, 46 82, 40 72 C 56 68, 70 74, 75 84 Z" style="fill:var(--leaf-pale)"/>
      <path d="M76 78 C 92 82, 104 76, 108 66 C 92 62, 80 68, 76 78 Z" style="fill:var(--leaf-pale)"/>
      <path d="M78 64 C 72 58, 70 50, 72 44 C 80 48, 82 56, 78 64 Z" style="fill:var(--leaf-pale-2)"/>`,
    wilting: `<path d="M75 98 C 75 84, 72 72, 84 64" style="stroke:var(--stem-pale)" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M75 84 C 60 86, 48 98, 42 112 C 58 108, 71 98, 75 84 Z" style="fill:var(--wilt)"/>
      <path d="M76 78 C 90 82, 102 94, 108 108 C 92 104, 80 94, 76 78 Z" style="fill:var(--wilt)"/>
      <path d="M84 64 C 92 66, 98 74, 100 84 C 92 82, 86 74, 84 64 Z" style="fill:var(--wilt-2)"/>`,
  };
  const label = {
    seed: "A small sprout",
    thriving: "A thriving plant with four green leaves and a flower",
    okay: "A healthy plant with three leaves",
    pale: "A pale plant with small, washed-out leaves",
    wilting: "A wilting plant with drooping brown leaves",
  }[stage];
  return `<svg viewBox="0 0 150 150" width="84" height="84" role="img" aria-label="${label}">${pot}${shapes[stage]}</svg>`;
}

const PLANT_TEXT = {
  seed: ["Plant a seed", "No usage recorded in this period yet."],
  thriving: ["Your plant is thriving", "You use AI well below the average user. Keep it up."],
  okay: ["Your plant is doing fine", "You use AI about as much as the average user."],
  pale: ["Your plant looks pale", "You use AI more than the average user. A habit below can help it recover."],
  wilting: ["Your plant is struggling", "You use AI more than twice as much as the average user. Try a habit below."],
};

// Your prompts per day, compared with the average ChatGPT user's (from
// OpenAI's research; see PP.AVERAGE_USER in lib/constants.js).
async function renderBenchmark(events, start) {
  const days = Math.max(1, Math.round((dayStart(Date.now()) - start) / DAY) + 1);
  const avg = PP.AVERAGE_USER.promptsPerDay;
  const daily = events.length / days;
  const ratio = daily / avg;

  $("bench-avg").textContent = PP.fmtNum(avg);
  $("bench-status").textContent = !events.length ? "No usage recorded" : ratio < 0.9 ? "Below average" : ratio > 1.1 ? "Above average" : "About average";
  $("bench-daily").textContent = PP.fmtNum(daily);
  const diff = Math.abs(ratio - 1) * 100;
  const over = `over ${days} day${days === 1 ? "" : "s"}`;
  $("bench-diff").textContent = !events.length
    ? "No recorded use in this period. Start tracking or import history."
    : diff < 5
      ? `About the same as the average user (${PP.fmtNum(avg)} prompts a day).`
      : ratio >= 2
        ? `${PP.fmtNum(ratio)}× the average user (${PP.fmtNum(avg)} prompts a day), ${over}.`
        : `${PP.fmtNum(diff)}% ${ratio < 1 ? "less" : "more"} than the average user (${PP.fmtNum(avg)} prompts a day), ${over}.`;
  $("bench-marker").style.left = `${Math.min(100, ratio * 50)}%`;
  $("bench-track").setAttribute("aria-label", `${PP.fmtPct(Math.min(ratio, 9.99))} of the average user's daily prompts. The scale ends at twice the average.`);

  const stage = !events.length ? "seed" : ratio < 0.6 ? "thriving" : ratio <= 1.1 ? "okay" : ratio <= 2 ? "pale" : "wilting";
  $("plant").innerHTML = plantSvg(stage);
  $("plant-title").textContent = PLANT_TEXT[stage][0];
  $("plant-text").textContent = PLANT_TEXT[stage][1];

  renderDamage(events, days);

  const { habits = {} } = await chrome.storage.local.get("habits");
  let done = 0;
  for (const box of document.querySelectorAll("[data-habit]")) {
    box.checked = !!habits[box.dataset.habit];
    if (box.checked) done++;
  }
  $("habit-count").textContent = done;
}

// "What does this mean for the environment?": the period's impact, what it
// adds up to over a year at this pace, and the climate damage it causes.
function renderDamage(events, days) {
  const list = $("damage");
  if (!events.length) {
    list.replaceChildren(el("li", {}, "Once you've used AI in this period, this shows how much it adds to climate change, water use and electricity demand."));
    return;
  }
  const g = sum(events, (e) => e.gco2e);
  const wh = sum(events, (e) => e.wh);
  const perYear = 365 / days;
  const yearG = g * perYear;
  const yearWh = wh * perYear;
  const damageUsd = (yearG / 1e6) * PP.SOCIAL_COST_USD_PER_TONNE;
  const usd = (v) => (v < 0.01 ? "less than 1¢" : v < 1 ? `${Math.round(v * 100)}¢` : `$${v.toFixed(2)}`);

  // The average user, at your energy per prompt and grid, so the difference
  // is only how much AI is used.
  const gPerPrompt = g / events.length;
  const avgYearG = PP.AVERAGE_USER.promptsPerDay * 365 * gPerPrompt;
  // Rounded to 2 significant figures: it's a rough, scale-up estimate.
  const globalT = Number(((PP.AVERAGE_USER.messagesPerWeek * 52 * gPerPrompt) / 1e6).toPrecision(2));
  const driving = PP.EQUIVALENTS.find((e) => e.id === "driving");
  const vsAvg = yearG >= avgYearG ? `${PP.fmtNum(yearG / avgYearG)}× the` : `${PP.fmtPct(yearG / avgYearG)} of the`;

  const item = (title, detail) => el("li", {}, el("strong", {}, title), el("span", { className: "muted" }, detail));
  list.replaceChildren(
    item(`Climate: ≈ ${PP.fmtGrams(g)} CO₂e ${RANGES[currentRange()]}.`,
      `At this pace, ≈ ${PP.fmtGrams(yearG)} a year, like ${driving.describe(yearG)}. That causes about ${usd(damageUsd)} of future climate damage each year.`),
    item(`Compared with others: ${vsAvg} average user's CO₂.`,
      `An average user (${PP.fmtNum(PP.AVERAGE_USER.promptsPerDay)} prompts a day) adds ≈ ${PP.fmtGrams(avgYearG)} a year at the same energy per prompt.`),
    item(`Water: ≈ ${PP.fmtNum(waterLiters(yearWh))} L of cooling water a year at this pace.`,
      "Data centers draw this from local supplies, which matters most where water is already scarce."),
    item(`Electricity: ≈ ${PP.fmtWh(yearWh)} a year.`,
      "Growing data-center demand keeps more fossil-fuel power plants running, especially on carbon-heavy grids."),
    item(`All ChatGPT users together: ≈ ${PP.fmtNum(globalT)} tonnes of CO₂e a year.`,
      "That's ~18 billion messages a week at your energy per prompt. One person's share is small; the damage comes from everyone's use added up.")
  );
}

// ---------- Which AI you use: a transparent breakdown ----------
let siteMeasure = "prompts";
let lastSiteEvents = [];
const MEASURES = {
  prompts: { label: "Prompts", value: (evs) => evs.length, fmt: (n) => n.toLocaleString() },
  gco2e: { label: "CO₂e", value: (evs) => sum(evs, (e) => e.gco2e), fmt: (g) => PP.fmtGrams(g) },
  wh: { label: "Electricity", value: (evs) => sum(evs, (e) => e.wh), fmt: (wh) => PP.fmtWh(wh) },
};

function renderSites(events) {
  lastSiteEvents = events;
  const m = MEASURES[siteMeasure];
  const rows = Object.entries(groupBy(events, "site"))
    .map(([site, evs]) => ({ site, evs, value: m.value(evs) }))
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((n, r) => n + r.value, 0) || 1;

  $("site-stack").replaceChildren(
    ...rows.map((r) =>
      el("span", {
        title: `${SITE_INFO[r.site].name}: ${PP.fmtPct(r.value / total)}`,
        style: { flexGrow: String(r.value), flexBasis: "0", minWidth: "4px", background: SITE_INFO[r.site].color },
      })
    )
  );
  $("site-stack").setAttribute("aria-label",
    rows.length ? `Share by ${m.label.toLowerCase()}: ` + rows.map((r) => `${SITE_INFO[r.site].name} ${PP.fmtPct(r.value / total)}`).join(", ") : "No usage yet");

  $("site-col").textContent = m.label;
  $("site-rows").replaceChildren(
    ...(rows.length ? rows : []).map((r) => {
      const info = PP.SITES[r.site];
      const whPerPrompt = sum(r.evs, (e) => e.wh) / r.evs.length;
      const detail = r.site === "other"
        ? `${r.evs.length.toLocaleString()} prompts across several smaller AIs`
        : `${r.evs.length.toLocaleString()} prompt${r.evs.length === 1 ? "" : "s"} · ${PP.fmtWh(whPerPrompt)} each on average`;
      return el("tr", {},
        el("td", {},
          el("div", { className: "site-name" },
            el("span", { className: "swatch", style: { background: SITE_INFO[r.site].color } }),
            ...(PP.SITES[r.site] ? [PP.siteIcon(r.site, 18)] : []),
            SITE_INFO[r.site].name,
            ...(info ? [el("span", { className: info.published ? "tag published" : "tag", title: info.source }, info.published ? "published" : "estimate")] : [])
          ),
          el("div", { className: "site-detail" }, detail)
        ),
        el("td", { className: "num" }, m.fmt(r.value)),
        el("td", { className: "num strong" }, PP.fmtPct(r.value / total))
      );
    })
  );
  if (!rows.length) $("site-rows").append(el("tr", {}, el("td", { colSpan: 3, className: "site-detail" }, "No usage in this period yet.")));

  $("site-note").textContent = siteMeasure === "prompts"
    ? "Very small shares are drawn a little wider so you can see them. The table has the exact numbers."
    : `Shares by ${m.label.toLowerCase()} differ from shares by prompts because each AI uses a different amount of energy per prompt, and longer replies use more.`;
}

for (const radio of document.querySelectorAll('input[name="site-measure"]')) {
  radio.addEventListener("change", () => {
    siteMeasure = radio.value;
    renderSites(lastSiteEvents);
  });
}

// ---------- What you use it for ----------
function renderCategories(events) {
  const byCat = Object.entries(groupBy(events, "category")).sort((a, b) => b[1].length - a[1].length);
  const max = byCat[0]?.[1].length ?? 1;
  const box = $("category-bars");
  box.replaceChildren();
  $("category-note").hidden = (groupBy(events, "category").Other?.length ?? 0) / (events.length || 1) < 0.5;
  if (!byCat.length) {
    box.append(el("p", { className: "note" }, "No usage in this period yet."));
    return;
  }
  for (const [category, evs] of byCat) {
    const bySite = groupBy(evs, "site");
    const track = el("div", { className: "bar-track", style: { width: `${(evs.length / max) * 100}%` } });
    for (const [site, info] of Object.entries(SITE_INFO)) {
      const n = bySite[site]?.length ?? 0;
      if (n) track.append(el("span", { title: `${info.name}: ${n}`, style: { width: `${(n / evs.length) * 100}%`, background: info.color } }));
    }
    box.append(
      el("div", { className: "bar-row" },
        el("div", { className: "bar-label" },
          el("span", {}, category),
          el("span", {}, `${evs.length.toLocaleString()} · ${PP.fmtPct(evs.length / events.length)} · ${PP.fmtGrams(sum(evs, (e) => e.gco2e))}`)
        ),
        track
      )
    );
  }
}

// ---------- Suggestions ----------
function renderSuggestions(events) {
  const tips = [];
  const total = events.length;
  for (const [category, evs] of Object.entries(groupBy(events, "category"))) {
    const alts = ALTERNATIVES[category];
    const share = evs.length / total;
    if (!alts || share < 0.3 || evs.length < 5) continue;
    const topSite = Object.entries(groupBy(evs, "site")).sort((a, b) => b[1].length - a[1].length)[0];
    tips.push({
      title: `${PP.fmtPct(share)} of your prompts are ${category.toLowerCase()} (${PP.fmtPct(topSite[1].length / evs.length)} of those on ${SITE_INFO[topSite[0]].name}).`,
      alts: `Try: ${alts.join(", ")}.`,
      save: `Doing half of these another way would have saved ≈ ${PP.fmtGrams(sum(evs, (e) => e.gco2e) / 2)} CO₂e ${RANGES[currentRange()]}.`,
    });
  }
  if (total >= 10) {
    tips.push({
      title: "Ask once, in detail.",
      alts: "One complete prompt uses less energy than several follow-ups. Avoid regenerating replies, and use a smaller or faster model for simple questions.",
    });
  }
  $("suggestions").replaceChildren(
    ...(tips.length
      ? tips.map((t) => el("li", {}, el("strong", {}, t.title), el("div", { className: "alts" }, t.alts), ...(t.save ? [el("div", { className: "save" }, t.save)] : [])))
      : [el("li", { className: "alts" }, "Use AI for a few more prompts to get personal suggestions.")])
  );
}

// ---------- Connected platforms ----------
// The section can be collapsed; collapsed, it shows the connected AIs' icons.
let platformsOpen = true;

function applyPlatformsOpen() {
  $("plat-toggle").setAttribute("aria-expanded", String(platformsOpen));
  $("plat-body").hidden = !platformsOpen;
  $("plat-mini").hidden = platformsOpen;
}

$("plat-toggle").addEventListener("click", () => {
  platformsOpen = !platformsOpen;
  chrome.storage.local.set({ platformsOpen });
  applyPlatformsOpen();
});

async function loadGranted() {
  const { origins = [] } = await chrome.permissions.getAll();
  state.granted = new Set(origins);
}
const siteConnected = (site) => PP.originsFor(site).some((o) => state.granted.has(o));

function renderPlatforms(events) {
  const sites = Object.keys(PP.SITES);
  const connected = sites.filter(siteConnected);
  $("connected-count").textContent = `${connected.length} of ${sites.length} connected`;
  $("connect-banner").hidden = connected.length > 0;
  $("plat-mini").replaceChildren(
    ...(connected.length
      ? connected.map((site) => {
          const icon = PP.siteIcon(site, 24);
          icon.title = `${PP.SITES[site].name}: tracking on`;
          return icon;
        })
      : [el("span", {}, "No platforms connected. Open to switch one on.")])
  );

  const bySite = groupBy(events, "site");
  $("platform-rows").replaceChildren(
    ...sites.map((site) => {
      const info = PP.SITES[site];
      const evs = bySite[site] ?? [];
      const on = siteConnected(site);
      const toggle = el("button", {
        className: "switch",
        role: "switch",
        "aria-checked": String(on),
        "aria-label": `Track ${info.name}`,
        title: on ? `Stop tracking ${info.name}` : `Allow PromptPrint to track ${info.name}`,
      });
      toggle.addEventListener("click", () => toggleSite(site, toggle));
      return el("div", { className: "platform-row" },
        PP.siteIcon(site, 30),
        el("div", { className: "platform-info" },
          el("strong", {}, info.name),
          el("small", {}, on ? `${info.hosts[0]} · ${evs.length.toLocaleString()} prompt${evs.length === 1 ? "" : "s"} · ${PP.fmtGrams(sum(evs, (e) => e.gco2e))}` : `${info.hosts[0]} · not tracked`)
        ),
        toggle
      );
    })
  );
}

async function toggleSite(site, button) {
  const origins = PP.originsFor(site);
  button.disabled = true;
  try {
    if (siteConnected(site)) {
      await chrome.permissions.remove({ origins });
    } else {
      // Chrome shows its own permission prompt for this website.
      await chrome.permissions.request({ origins });
    }
  } catch (e) {
    $("load-status").hidden = false;
    $("load-status").textContent = `Couldn't change tracking: ${e.message}`;
  } finally {
    button.disabled = false;
    await loadGranted();
    renderPlatforms(state.current);
  }
}

// ---------- Main render ----------
// CO₂ depends on the power grid: the country picked on the map, a guess from
// the browser language, or a world-average grid.
async function gridSetting() {
  const { country } = await chrome.storage.local.get("country");
  const c = PP.gridById.get(country ?? PP.guessCountryId());
  return c ? { name: c.name, grid: c.grid } : { name: "an average country", grid: PP.DEFAULT_GRID_G_PER_KWH };
}

async function render() {
  const { events = [], waterRate } = await chrome.storage.local.get(["events", "waterRate"]);
  if (Number.isFinite(waterRate)) state.waterRate = waterRate;
  const { name, grid } = await gridSetting();
  $("about-grid").textContent = name;
  for (const e of events) e.gco2e = (e.wh / 1000) * grid;
  state.events = events;

  const range = currentRange();
  const start = rangeStart(range, events);
  const current = events.filter((e) => e.timestamp >= start);
  state.current = current;
  const shown = foldSites(current);

  renderTotals(current, start);
  renderEquivalent();
  await renderBenchmark(current, start);
  renderSites(shown);
  renderCategories(shown);
  renderSuggestions(shown);
  renderPlatforms(current);
}

// ---------- Controls ----------
for (const r of document.querySelectorAll('input[name="range"]')) {
  r.addEventListener("change", () => {
    chrome.storage.local.set({ range: r.value });
    render();
  });
}


for (const box of document.querySelectorAll("[data-habit]")) {
  box.addEventListener("change", async () => {
    const { habits = {} } = await chrome.storage.local.get("habits");
    habits[box.dataset.habit] = box.checked;
    await chrome.storage.local.set({ habits });
    render();
  });
}

$("map-btn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("map.html") }));
$("connect-btn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }));
$("import-btn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("import.html") }));

// "Load data": read open AI tabs (on connected platforms) for prompts that
// weren't counted yet.
$("load-btn").addEventListener("click", async () => {
  const btn = $("load-btn");
  const status = $("load-status");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "load-recent" });
    if (!res?.ok) throw new Error(res?.error ?? "unknown error");
    status.textContent = !res.connected
      ? "No platforms are connected yet. Switch one on under Your connected platforms."
      : !res.tabs
        ? "No chats from connected platforms are open. Open your chats in tabs, then press Load data."
        : `Checked ${res.tabsRead} of ${res.tabs} AI tab${res.tabs === 1 ? "" : "s"}: ${res.found} prompt${res.found === 1 ? "" : "s"} on screen, ${res.added} new added.`;
  } catch (e) {
    status.textContent = `Couldn't load data: ${e.message}`;
  }
  status.hidden = false;
  btn.disabled = false;
  btn.textContent = "⟳ Load data";
  render();
});

$("clear-btn").addEventListener("click", async () => {
  if (!confirm("Delete all tracked usage on this device?")) return;
  await chrome.runtime.sendMessage({ type: "clear" });
  render();
});

$("manual-site").replaceChildren(...Object.entries(PP.SITES).map(([id, s]) => el("option", { value: id }, s.name)));
$("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ type: "manual-log", site: $("manual-site").value, promptText: $("manual-text").value });
  $("manual-text").value = "";
  render();
});

$("about-btn").addEventListener("click", () => $("about").showModal());
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
$("water-rate").addEventListener("change", async () => {
  const field = $("water-rate");
  const v = Number(field.value);
  if (field.value === "" || !(v >= 0 && v <= 100)) {
    $("water-status").textContent = "Enter a number between 0 and 100 L/kWh.";
    return;
  }
  await chrome.storage.local.set({ waterRate: v });
  $("water-status").textContent = "Saved. All water estimates have been recalculated.";
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.events || changes.country || changes.waterRate) render();
});
chrome.permissions.onAdded.addListener(async () => { await loadGranted(); renderPlatforms(state.current); });
chrome.permissions.onRemoved.addListener(async () => { await loadGranted(); renderPlatforms(state.current); });

// ---------- Start ----------
(async function init() {
  setupEquivalentSelect();
  const { range, equivChoice, waterRate, platformsOpen: open } = await chrome.storage.local.get(["range", "equivChoice", "waterRate", "platformsOpen"]);
  if (typeof open === "boolean") platformsOpen = open;
  applyPlatformsOpen();
  if (range) for (const r of document.querySelectorAll('input[name="range"]')) r.checked = r.value === range;
  if (equivChoice && PP.EQUIVALENTS.some((eq) => eq.id === equivChoice)) $("equiv-select").value = equivChoice;
  if (Number.isFinite(waterRate)) $("water-rate").value = waterRate;
  await loadGranted();
  await render();
})();
