// popup.js — draws the summary, charts and suggestions when you click the
// extension icon. Reads the events saved by background.js.

// Names, colors, comparisons and number formatting come from lib/constants.js
const SITE_INFO = Object.fromEntries(
  Object.entries(PP.SITES).map(([id, s]) => [id, { name: s.name, color: PP.siteColor(id) }])
);
SITE_INFO.other = { name: "Other AIs", color: PP.siteColor("other") };

// Charts stay readable with at most 5 AIs: smaller ones are grouped as "Other AIs".
// Each AI keeps its own color whatever its rank.
const MAX_SITES_SHOWN = 5;
function foldSites(events) {
  const counts = {};
  for (const e of events) counts[e.site] = (counts[e.site] ?? 0) + 1;
  const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (ranked.length <= MAX_SITES_SHOWN) return events;
  const keep = new Set(ranked.slice(0, MAX_SITES_SHOWN - 1));
  return events.map((e) => (keep.has(e.site) ? e : { ...e, site: "other" }));
}

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
  $("total-prompts").textContent = week.length.toLocaleString();
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
        el("span", { className: "pct" }, `${count.toLocaleString()} · ${PP.fmtPct(share)}`)
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
    const siteShare = PP.fmtPct(topSite[1].length / events.length);
    const halfSaved = sum(events, (e) => e.gco2e) / 2;

    tips.push({
      title: `${PP.fmtPct(share)} of your prompts are ${category.toLowerCase()} (${siteShare} of those on ${siteName}).`,
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
  const shown = foldSites(current);
  renderPie(shown);
  renderCategories(shown);
  renderTimeline(current);
  renderSuggestions(shown);
  renderGarden(events);
}

// ---------- Plant & weekly budget ----------
// The plant reflects the last 7 days against a weekly CO₂ budget: thriving
// under 80%, needs care up to 100%, wilting over budget.

const DEFAULT_BUDGET_G = 20;

// Suggest your recent weekly average (rounded up), so a normal week keeps the
// plant healthy and using less makes it thrive. Used until you set your own.
function suggestBudget(events) {
  const now = Date.now();
  const recent = events.filter((e) => e.timestamp > now - 28 * DAY);
  if (!recent.length) return DEFAULT_BUDGET_G;
  const spanDays = Math.max(7, Math.min(28, (now - Math.min(...recent.map((e) => e.timestamp))) / DAY));
  const weekly = (sum(recent, (e) => e.gco2e) / spanDays) * 7;
  if (weekly < 1) return Math.max(0.5, Math.ceil(weekly * 10) / 10);
  return weekly < 20 ? Math.ceil(weekly) : Math.ceil(weekly / 5) * 5;
}

function plantSvg(state) {
  const pot = `<ellipse cx="75" cy="141" rx="44" ry="5" style="fill:var(--track)"/>
    <path d="M50 106 h50 l-7 32 h-36 z" style="fill:var(--pot)"/>
    <rect x="46" y="98" width="58" height="11" rx="3" style="fill:var(--pot-rim)"/>`;
  const shapes = {
    seed: `<path d="M75 98 V80" style="stroke:var(--stem)" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M75 84 C 66 84, 60 78, 58 70 C 68 70, 74 75, 75 84 Z" style="fill:var(--leaf-2)"/>
      <path d="M75 82 C 84 82, 90 76, 92 68 C 82 68, 76 73, 75 82 Z" style="fill:var(--leaf-2)"/>`,
    thriving: `<path d="M75 98 V50" style="stroke:var(--stem)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M75 80 C 52 80, 40 66, 38 48 C 58 48, 72 58, 75 80 Z" style="fill:var(--leaf)"/>
      <path d="M75 72 C 96 72, 110 58, 112 40 C 92 40, 78 50, 75 72 Z" style="fill:var(--leaf)"/>
      <path d="M75 58 C 60 54, 54 40, 56 26 C 70 30, 78 42, 75 58 Z" style="fill:var(--leaf-2)"/>
      <path d="M75 54 C 88 48, 94 36, 92 22 C 80 28, 74 40, 75 54 Z" style="fill:var(--leaf-2)"/>`,
    okay: `<path d="M75 98 C 75 80, 73 66, 76 54" style="stroke:var(--stem)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M75 82 C 54 84, 42 74, 38 60 C 56 58, 70 66, 75 82 Z" style="fill:var(--leaf)"/>
      <path d="M75 74 C 94 76, 106 66, 110 52 C 92 50, 79 58, 75 74 Z" style="fill:var(--leaf)"/>
      <path d="M76 60 C 66 54, 62 44, 64 34 C 74 38, 78 48, 76 60 Z" style="fill:var(--leaf-2)"/>`,
    wilting: `<path d="M75 98 C 75 84, 72 72, 84 64" style="stroke:var(--stem)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M75 84 C 60 86, 48 98, 42 112 C 58 108, 71 98, 75 84 Z" style="fill:var(--wilt)"/>
      <path d="M76 78 C 90 82, 102 94, 108 108 C 92 104, 80 94, 76 78 Z" style="fill:var(--wilt)"/>
      <path d="M84 64 C 92 66, 98 74, 100 84 C 92 82, 86 74, 84 64 Z" style="fill:var(--wilt-2)"/>`,
  };
  const label = { seed: "A small sprout", thriving: "A healthy plant with four leaves", okay: "A plant with three leaves, starting to droop", wilting: "A wilting plant with drooping brown leaves" }[state];
  return `<svg viewBox="0 0 150 150" width="92" height="92" role="img" aria-label="${label}">${pot}${shapes[state]}</svg>`;
}

function dayStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return +d;
}

// Full days in a row (ending yesterday) with CO₂ at or under a day's share of
// the weekly budget. Today isn't over, so it doesn't count yet. Days before
// you installed PromptPrint don't count.
function streakDays(events, budget, installedAt) {
  const limit = budget / 7;
  const first = dayStart(installedAt ?? Date.now());
  const perDay = new Map();
  for (const e of events) {
    const d = dayStart(e.timestamp);
    perDay.set(d, (perDay.get(d) ?? 0) + e.gco2e);
  }
  let streak = 0;
  for (let d = dayStart(dayStart(Date.now()) - DAY / 2); d >= first; d = dayStart(d - DAY / 2)) {
    if ((perDay.get(d) ?? 0) > limit) break;
    streak++;
  }
  return streak;
}

async function renderGarden(events) {
  const { budget: saved, installedAt, habits = {} } = await chrome.storage.local.get(["budget", "installedAt", "habits"]);
  const budget = saved ?? suggestBudget(events);
  const week = events.filter((e) => e.timestamp > Date.now() - 7 * DAY);
  const used = sum(week, (e) => e.gco2e);
  const ratio = used / budget;
  const state = !events.length ? "seed" : ratio < 0.8 ? "thriving" : ratio <= 1 ? "okay" : "wilting";

  $("plant").innerHTML = plantSvg(state);
  $("plant-title").textContent = {
    seed: "Plant a seed",
    thriving: "Your plant is thriving",
    okay: "Your plant needs a little care",
    wilting: "Your plant is wilting",
  }[state];
  $("plant-text").textContent = events.length
    ? `${PP.fmtGrams(used)} of your ${PP.fmtGrams(budget)} weekly budget${saved ? "" : " (suggested)"} · last 7 days`
    : `Use AI and your plant grows while you stay under ${PP.fmtGrams(budget)} a week.`;

  $("budget-fill").style.width = `${Math.min(ratio, 1) * 100}%`;
  $("budget-fill").classList.toggle("over", ratio > 1);
  $("budget-bar").setAttribute("aria-label", `${PP.fmtPct(Math.min(ratio, 9.99))} of weekly budget used`);

  const streak = events.length ? streakDays(events, budget, installedAt) : 0;
  $("streak").replaceChildren();
  $("streak").insertAdjacentHTML("afterbegin",
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/></svg>');
  $("streak").append(streak ? `${streak}-day streak` : `Start a streak: stay under ${PP.fmtGrams(budget / 7)} today`);
  $("streak").title = `Days in a row at or under ${PP.fmtGrams(budget / 7)} (your daily share of the budget)`;

  if (document.activeElement !== $("budget-input")) $("budget-input").value = Math.round(budget * 10) / 10;

  let done = 0;
  for (const box of document.querySelectorAll("[data-habit]")) {
    box.checked = !!habits[box.dataset.habit];
    if (box.checked) done++;
  }
  $("habit-count").textContent = done;
}

$("budget-edit").addEventListener("click", () => {
  const form = $("budget-form");
  form.hidden = !form.hidden;
  $("budget-edit").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) $("budget-input").focus();
});

$("budget-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = Number($("budget-input").value);
  if (!(value > 0)) return;
  await chrome.storage.local.set({ budget: value });
  $("budget-form").hidden = true;
  $("budget-edit").setAttribute("aria-expanded", "false");
  render();
});

for (const box of document.querySelectorAll("[data-habit]")) {
  box.addEventListener("change", async () => {
    const { habits = {} } = await chrome.storage.local.get("habits");
    habits[box.dataset.habit] = box.checked;
    await chrome.storage.local.set({ habits });
    render();
  });
}

// ---------- Theme menu ----------
function setupThemeMenu() {
  const nameOf = (id) => PPTheme.THEMES.find((t) => t.id === id)?.name ?? "Default";
  const showCurrent = () => {
    const name = nameOf(PPTheme.current());
    $("theme-name").textContent = name;
    $("theme-btn").setAttribute("aria-label", `Theme: ${name}. Change theme`);
    $("theme-btn").title = `Theme: ${name}`;
  };

  $("theme-grid").replaceChildren(
    ...PPTheme.THEMES.map((t) => {
      const input = el("input", { type: "radio", name: "theme", value: t.id, checked: t.id === PPTheme.current() });
      input.addEventListener("change", () => {
        PPTheme.set(t.id);
        showCurrent();
      });
      return el("label", { className: "theme-option" },
        input,
        el("span", { className: "theme-dots" }, ...t.dots.map((c) => el("i", { style: { background: c } }))),
        t.name
      );
    })
  );

  $("theme-btn").addEventListener("click", () => {
    const menu = $("theme-menu");
    menu.hidden = !menu.hidden;
    $("theme-btn").setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("input:checked")?.focus();
  });

  // The saved theme may arrive a moment after opening; keep the label in sync.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.theme) {
      for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === PPTheme.current();
      showCurrent();
    }
  });
  showCurrent();
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
      ? "No AI chat tabs are open. Open your chats in tabs, then press Load data."
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
  if (changes.events || changes.country || changes.budget) render();
});

$("manual-site").replaceChildren(
  ...Object.entries(PP.SITES).map(([id, s]) => el("option", { value: id }, s.name))
);

setupEquivalentSelect();
setupThemeMenu();
setupPeriodSelect().then(render);
