// background.js — the extension's "brain". Receives events from content.js
// and the popup, sorts each prompt into a task category, estimates its
// energy and carbon, and saves the result. Raw prompt text is NEVER stored.

// ---------- Emission assumptions: see lib/constants.js and README "Methodology" ----------
importScripts("lib/constants.js");
const { SITES, REFERENCE_REPLY_TOKENS, CHARS_PER_TOKEN } = PP;
const GRID_G_PER_KWH = PP.DEFAULT_GRID_G_PER_KWH;

function estimateEmissions(site, promptChars, responseChars) {
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const responseTokens = Math.ceil(responseChars / CHARS_PER_TOKEN);
  const baseWh = SITES[site]?.baseWh ?? 0.3;
  // Longer replies take more computation. Unknown length (0) = typical.
  const lengthFactor =
    responseTokens > 0
      ? Math.min(Math.max(responseTokens / REFERENCE_REPLY_TOKENS, 0.25), 10)
      : 1;
  const wh = baseWh * lengthFactor;
  const gco2e = (wh / 1000) * GRID_G_PER_KWH;
  return { promptTokens, responseTokens, wh, gco2e };
}

// ---------- Task categories (simple keyword rules, no AI needed) ----------
const CATEGORIES = {
  Math: [
    /\b(solve|integral|derivative|equation|calculus|algebra|geometry|trig\w*|matrix|probability|statistics|proof|simplify|factor)\b/i,
    /\d+\s*[-+*/^=]\s*\d+/,
    /\b(math|homework problem)\b/i,
  ],
  Coding: [
    /\b(code|function|bug|error|debug|python|javascript|java|c\+\+|html|css|sql|api|compile|stack trace|regex)\b/i,
    /```/,
  ],
  Writing: [
    /\b(essay|rewrite|paraphrase|email|cover letter|grammar|proofread|edit my|thesis|paragraph|draft)\b/i,
  ],
  Research: [
    /\b(what is|what are|who is|who was|explain|history of|summari[sz]e|define|difference between|why do|how does)\b/i,
  ],
  Brainstorm: [
    /\b(ideas?|brainstorm|suggest\w*|names? for|come up with|recommend\w*)\b/i,
  ],
};

function categorize(text) {
  let best = "Other";
  let bestScore = 0;
  for (const [category, patterns] of Object.entries(CATEGORIES)) {
    const score = patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

// ---------- Storage (one write at a time so events never get lost) ----------
let writeQueue = Promise.resolve();

function saveEvents(newEvents) {
  writeQueue = writeQueue.then(async () => {
    const { events = [] } = await chrome.storage.local.get("events");
    events.push(...newEvents);
    await chrome.storage.local.set({ events });
  });
  return writeQueue;
}

function buildEvent({ site, promptText = "", responseChars = 0, timestamp, demo = false, importKey }) {
  return {
    id: crypto.randomUUID(),
    ...(importKey ? { importKey, imported: true } : {}),
    site,
    category: categorize(promptText),
    ...estimateEmissions(site, promptText.length, responseChars),
    timestamp: timestamp ?? Date.now(),
    demo,
  };
}

// ---------- Demo data: a realistic week for presentations ----------
const DEMO_PROMPTS = {
  Math: ["solve 3x + 7 = 22", "find the derivative of x^2 sin x", "explain this calculus integral step by step", "probability of two dice summing to 7"],
  Coding: ["fix this python error: list index out of range", "write a javascript function to sort an array", "why does my css not center the div"],
  Writing: ["proofread my essay intro paragraph", "rewrite this email to sound more professional", "help draft a cover letter"],
  Research: ["what is the greenhouse effect", "summarize the causes of world war 1", "explain how vaccines work"],
  Brainstorm: ["ideas for a club fundraiser", "names for a sustainability app"],
};

function generateDemoEvents() {
  // [site, category, prompts per week] — Claude is mostly used for math.
  const plan = [
    ["claude", "Math", 34], ["claude", "Coding", 6], ["claude", "Writing", 5],
    ["chatgpt", "Writing", 10], ["chatgpt", "Research", 8], ["chatgpt", "Math", 6],
    ["gemini", "Research", 7], ["gemini", "Brainstorm", 4], ["chatgpt", "Coding", 5],
  ];
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const events = [];
  // Last week was heavier, so the "vs last week" comparison shows progress.
  for (const [weekOffset, scale] of [[0, 1], [1, 1.25]]) {
    for (const [site, category, count] of plan) {
      const n = Math.round(count * scale);
      const prompts = DEMO_PROMPTS[category];
      for (let i = 0; i < n; i++) {
        const daysAgo = weekOffset * 7 + Math.random() * 7;
        events.push(
          buildEvent({
            site,
            promptText: prompts[i % prompts.length],
            responseChars: 600 + Math.floor(Math.random() * 3000),
            timestamp: Math.floor(now - daysAgo * DAY),
            demo: true,
          })
        );
      }
    }
  }
  return events;
}

// ---------- Importing past chat history (from import.js) ----------
// Saves only messages from BEFORE the extension started tracking, so nothing
// is counted twice, and skips messages that were already imported.
async function importEvents(items) {
  await writeQueue;
  const { events = [], installedAt = Date.now() } = await chrome.storage.local.get(["events", "installedAt"]);
  const seen = new Set(events.map((e) => e.importKey).filter(Boolean));
  const fresh = [];
  let duplicates = 0;
  let afterInstall = 0;
  for (const item of items) {
    if (!SITES[item.site] || !item.importKey) continue;
    if (seen.has(item.importKey)) { duplicates++; continue; }
    if (item.timestamp >= installedAt) { afterInstall++; continue; }
    seen.add(item.importKey);
    fresh.push(buildEvent(item));
  }
  await saveEvents(fresh);
  return { ok: true, added: fresh.length, duplicates, afterInstall };
}

// Remember when tracking started (used by the importer above).
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { installedAt } = await chrome.storage.local.get("installedAt");
  if (reason === "install" || !installedAt) await chrome.storage.local.set({ installedAt: Date.now() });
});

// ---------- Messages from content.js, popup.js and import.js ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "ai-event":
      case "manual-log":
        if (!SITES[msg.site]) throw new Error("unknown site " + msg.site);
        await saveEvents([buildEvent(msg)]);
        return { ok: true };
      case "import-events":
        return importEvents(msg.items ?? []);
      case "load-demo":
        await saveEvents(generateDemoEvents());
        return { ok: true };
      case "clear":
        await writeQueue;
        await chrome.storage.local.set({ events: [] });
        return { ok: true };
      default:
        return { ok: false, error: "unknown message type" };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // keep the channel open for the async reply
});
