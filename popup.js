// popup.js — draws the summary, charts and suggestions when you click the
// extension icon. Reads the events saved by background.js.

// Names, colors, comparisons and number formatting come from lib/constants.js
const SITE_INFO = Object.fromEntries(
  Object.entries(PP.SITES).map(([id, s]) => [id, { name: s.name, color: PP.siteColor(id) }])
);

// Lower-impact alternatives for each kind of task.
const ALTERNATIVES = {
  Math: ["your textbook's worked examples", "Khan Academy", "Desmos", "Wolfram Alpha", "Paul's Online Math Notes", "office hours or the tutoring center"],
  Coding: ["the official docs (MDN, Python docs)", "Stack Overflow search", "your editor's autocomplete", "rubber-duck debugging"],
  Writing: ["Purdue OWL", "your campus writing center", "a thesaurus", "your editor's built-in grammar check"],
  Research: ["a regular web search", "Wikipedia", "your library's databases"],
  Brainstorm: ["5 minutes of solo brainstorming first", "a mind map", "asking a classmate"],
};

const DAY = 24 * 60 * 60 * 1000;
const UNCERTAINTY = PP.UNCERTAINTY; // shown as a range in the UI

const $ = (id) => document.getElementById(id);
const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
const fmt = (g) => PP.fmtNum(g);

let weekTotals = { g: 0, wh: 0, count: 0 };

// Time periods for the dropdown in the header.
const PERIODS = {
  "7": { days: 7, name: "this week", prev: "the week before" },
  "30": { days: 30, name: "these 30 days", prev: "the 30 days before" },
  all: { days: null, name: "in total", prev: null },
};
const currentPeriod = () => PERIODS[$("period").value] ?? PERIODS["7"];

function groupBy(arr, key) {
  const out = {};
  for (const x of arr) (out[x[key]] ??= []).push(x);
  return out;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(node.style, v);
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

// ---------- Rendering ----------

function renderTotals(week, lastWeek) {
  const g = sum(week, (e) => e.gco2e);
  const wh = sum(week, (e) => e.wh);
  weekTotals = { g, wh, count: week.length };

  $("total-g").textContent = PP.fmtGrams(g);
  $("total-wh").textContent = PP.fmtWh(wh);
  $("total-range").textContent =
    `${PP.fmtGrams(g * UNCERTAINTY.low)}–${PP.fmtGrams(g * UNCERTAINTY.high)} CO₂e`;
  $("total-prompts").textContent = week.length;
  renderEquivalent();

  const prev = sum(lastWeek, (e) => e.gco2e);
  const change = $("change");
  change.className = "change";
  if (prev > 0 && week.length) {
    const pct = ((g - prev) / prev) * 100;
    change.textContent = `${pct <= 0 ? "▼" : "▲"} ${Math.abs(pct).toFixed(0)}% vs. ${currentPeriod().prev}`;
    change.classList.add(pct <= 0 ? "good" : "bad");
  } else {
    change.textContent = "";
  }
}

// The "That's about the same as…" dropdown.
function setupEquivalentSelect() {
  const select = $("equiv-select");
  select.replaceChildren(...PP.EQUIVALENTS.map((eq) => el("option", { value: eq.id }, eq.label)));
  chrome.storage.local.get("equivChoice").then(({ equivChoice }) => {
    if (equivChoice && PP.EQUIVALENTS.some((eq) => eq.id === equivChoice)) select.value = equivChoice;
    renderEquivalent();
  });
  select.addEventListener("change", () => {
    chrome.storage.local.set({ equivChoice: select.value }); // remember the choice
    renderEquivalent();
  });
}

function renderEquivalent() {
  const eq = PP.EQUIVALENTS.find((x) => x.id === $("equiv-select").value) ?? PP.EQUIVALENTS[0];
  if (!weekTotals.count) {
    $("equivalent").textContent = "";
    return;
  }
  const amount = eq.basis === "g" ? weekTotals.g : weekTotals.wh;
  const basisText = eq.basis === "g" ? "by CO₂" : "by electricity";
  $("equivalent").replaceChildren(
    `≈ ${eq.describe(amount)}`,
    el("span", { className: "muted basis" }, ` (${basisText})`)
  );
}

function renderPie(week) {
  const bySite = groupBy(week, "site");
  const total = week.length;
  let angle = 0;
  const stops = [];
  const legend = $("pie-legend");
  legend.replaceChildren();

  for (const [site, info] of Object.entries(SITE_INFO)) {
    const count = bySite[site]?.length ?? 0;
    if (!count) continue;
    const share = count / total;
    stops.push(`${info.color} ${angle}turn ${angle + share}turn`);
    angle += share;
    legend.append(
      el("li", {},
        el("span", { className: "swatch", style: { background: info.color } }),
        info.name,
        el("span", { className: "pct" }, `${Math.round(share * 100)}%`)
      )
    );
  }
  $("pie").style.background = stops.length ? `conic-gradient(${stops.join(", ")})` : "";
}

function renderCategories(week) {
  const byCat = Object.entries(groupBy(week, "category")).sort((a, b) => b[1].length - a[1].length);
  const max = byCat[0]?.[1].length ?? 1;
  const box = $("category-bars");
  box.replaceChildren();

  for (const [category, events] of byCat) {
    const bySite = groupBy(events, "site");
    const track = el("div", { className: "bar-track", style: { width: `${(events.length / max) * 100}%` } });
    for (const [site, info] of Object.entries(SITE_INFO)) {
      const n = bySite[site]?.length ?? 0;
      if (n) {
        track.append(el("span", {
          title: `${info.name}: ${n}`,
          style: { width: `${(n / events.length) * 100}%`, background: info.color },
        }));
      }
    }
    box.append(
      el("div", { className: "bar-row" },
        el("div", { className: "bar-label" },
          el("span", {}, category),
          el("span", {}, `${events.length} · ${fmt(sum(events, (e) => e.gco2e))} g`)
        ),
        track
      )
    );
  }
}

// Column chart: one bar per day (7 or 30 days) or per month (all time).
function renderTimeline(events) {
  const period = currentPeriod();
  const buckets = [];
  if (period.days) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = period.days - 1; i >= 0; i--) {
      const start = new Date(today);
      start.setDate(today.getDate() - i);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      const label = start.toLocaleDateString(undefined, period.days <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" });
      buckets.push({ start: +start, end: +end, label, tip: start.toLocaleDateString() });
    }
    $("timeline-title").textContent = "Daily emissions";
  } else {
    const first = new Date(Math.min(...events.map((e) => e.timestamp), Date.now()));
    let m = new Date(first.getFullYear(), first.getMonth(), 1);
    const now = new Date();
    const months = [];
    while (m <= now) {
      months.push(m);
      m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    }
    for (const start of months.slice(-24)) {
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      buckets.push({
        start: +start,
        end: +end,
        label: start.toLocaleDateString(undefined, { month: "short" }),
        tip: start.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      });
    }
    $("timeline-title").textContent = "Monthly emissions";
  }
  for (const b of buckets) b.g = sum(events.filter((e) => e.timestamp >= b.start && e.timestamp < b.end), (e) => e.gco2e);

  const max = Math.max(...buckets.map((b) => b.g), 0.0001);
  // Many thin bars: label only the first and last under the chart.
  const dense = buckets.length > 12;
  $("daily-bars").classList.toggle("dense", dense);
  $("daily-bars").replaceChildren(
    ...buckets.map((b) =>
      el("div", { className: "day", title: `${b.tip}: ${PP.fmtGrams(b.g)} CO₂e` },
        el("div", { className: "col", style: { height: `${(b.g / max) * 75}px` } }),
        ...(dense ? [] : [el("div", { className: "lbl" }, b.label)])
      )
    )
  );
  $("timeline-axis").hidden = !dense;
  $("timeline-axis").replaceChildren(
    el("span", {}, buckets[0].label),
    el("span", {}, buckets[buckets.length - 1].label)
  );
}

function buildSuggestions(week) {
  const tips = [];
  const total = week.length;
  const byCat = groupBy(week, "category");

  for (const [category, events] of Object.entries(byCat)) {
    const alts = ALTERNATIVES[category];
    if (!alts) continue;
    const share = events.length / total;
    if (share < 0.3 || events.length < 5) continue;

    const topSite = Object.entries(groupBy(events, "site")).sort((a, b) => b[1].length - a[1].length)[0];
    const siteName = SITE_INFO[topSite[0]].name;
    const siteShare = Math.round((topSite[1].length / events.length) * 100);
    const halfSaved = sum(events, (e) => e.gco2e) / 2;

    tips.push({
      title: `${Math.round(share * 100)}% of your prompts are ${category.toLowerCase()} (${siteShare}% of those on ${siteName}).`,
      alts: `Try: ${alts.join(", ")}.`,
      save: `Doing half of these another way would have saved ≈ ${PP.fmtGrams(halfSaved)} CO₂e ${currentPeriod().name}.`,
    });
  }

  if (total >= 10) {
    tips.push({
      title: "Ask once, in detail.",
      alts: "One complete prompt uses less energy than several follow-ups. Avoid regenerating replies, and use a smaller or faster model for simple questions.",
    });
  }
  return tips;
}

function renderSuggestions(week) {
  const list = $("suggestions");
  const tips = buildSuggestions(week);
  if (!tips.length) {
    list.replaceChildren(el("li", { className: "alts" }, "Use AI for a few more prompts to get personal suggestions."));
    return;
  }
  list.replaceChildren(
    ...tips.map((t) =>
      el("li", {},
        el("strong", {}, t.title),
        el("div", { className: "alts" }, t.alts),
        ...(t.save ? [el("div", { className: "save" }, t.save)] : [])
      )
    )
  );
}

// CO₂ depends on the power grid. Use the country picked on the map, or a
// guess from the browser's language, or a world-average grid.
async function gridSetting() {
  const { country } = await chrome.storage.local.get("country");
  const c = PP.gridById.get(country ?? PP.guessCountryId());
  return c ? { name: c.name, grid: c.grid } : { name: "an average country", grid: PP.DEFAULT_GRID_G_PER_KWH };
}

async function render() {
  const { events = [] } = await chrome.storage.local.get("events");
  const { name, grid } = await gridSetting();
  $("grid-name").textContent = name;
  for (const e of events) e.gco2e = (e.wh / 1000) * grid;
  const now = Date.now();
  const { days } = currentPeriod();
  const current = days ? events.filter((e) => e.timestamp > now - days * DAY) : events;
  const previous = days
    ? events.filter((e) => e.timestamp <= now - days * DAY && e.timestamp > now - 2 * days * DAY)
    : [];

  $("empty").hidden = current.length > 0;
  $("charts").hidden = current.length === 0;
  $("empty-older").hidden = !(events.length && !current.length);

  renderTotals(current, previous);
  renderPie(current);
  renderCategories(current);
  renderTimeline(current);
  renderSuggestions(current);
}

// Restore the last period picked. With no choice saved yet, show "All time"
// when there's no recent usage (e.g. right after importing old chats).
async function setupPeriodSelect() {
  const { period, events = [] } = await chrome.storage.local.get(["period", "events"]);
  if (period && PERIODS[period]) $("period").value = period;
  else if (events.length && !events.some((e) => e.timestamp > Date.now() - 7 * DAY)) $("period").value = "all";
  $("period").addEventListener("change", () => {
    chrome.storage.local.set({ period: $("period").value });
    render();
  });
}

// ---------- Buttons ----------

$("map-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("map.html") });
});

$("import-btn").addEventListener("click", () => {
  // Opens in a full tab: a file picker would close this small popup.
  chrome.tabs.create({ url: chrome.runtime.getURL("import.html") });
});

// "Load data": read open ChatGPT / Claude / Gemini tabs for prompts that
// weren't counted yet (e.g. sent before installing, or missed by tracking).
$("load-btn").addEventListener("click", async () => {
  const btn = $("load-btn");
  const status = $("load-status");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "load-recent" });
    if (!res?.ok) throw new Error(res?.error ?? "unknown error");
    status.textContent = !res.tabs
      ? "No ChatGPT, Claude or Gemini tabs are open. Open your chats in tabs, then press Load data."
      : `Checked ${res.tabsRead} of ${res.tabs} AI tab${res.tabs === 1 ? "" : "s"}: ` +
        `${res.found} prompt${res.found === 1 ? "" : "s"} on screen, ${res.added} new added.`;
  } catch (e) {
    status.textContent = `Couldn't load data: ${e.message}`;
  }
  status.hidden = false;
  btn.disabled = false;
  btn.textContent = "⟳ Load data";
  render();
});

$("clear-btn").addEventListener("click", async () => {
  if (!confirm("Delete all tracked usage?")) return;
  await chrome.runtime.sendMessage({ type: "clear" });
  render();
});

$("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({
    type: "manual-log",
    site: $("manual-site").value,
    promptText: $("manual-text").value,
  });
  $("manual-text").value = "";
  render();
});

// Update live if new usage is tracked while the popup is open.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.events || changes.country) render();
});

setupEquivalentSelect();
setupPeriodSelect().then(render);
