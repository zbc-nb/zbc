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

function updateEvents(change) {
  const result = writeQueue.then(async () => {
    const { events = [] } = await chrome.storage.local.get("events");
    const { next, value } = await change(events);
    await chrome.storage.local.set({ events: next });
    return value;
  });
  writeQueue = result.catch(() => {});
  return result;
}

function buildEvent({ site, promptText = "", responseChars = 0, timestamp, importKey, source = "live" }) {
  return {
    id: crypto.randomUUID(),
    ...(importKey ? { importKey } : {}),
    source, // "live", "manual", "import" or "scan"
    site,
    category: categorize(promptText),
    ...estimateEmissions(site, promptText.length, responseChars),
    timestamp: timestamp ?? Date.now(),
  };
}

// Adds events, skipping any whose importKey is already saved, so the same
// prompt is never counted twice. Optionally keeps only pre-install items.
function addUniqueEvents(items, { source, beforeInstallOnly = false }) {
  return updateEvents(async (events) => {
    const { installedAt = Date.now() } = await chrome.storage.local.get("installedAt");
    const seen = new Set(events.map((e) => e.importKey).filter(Boolean));
    const fresh = [];
    let duplicates = 0;
    let afterInstall = 0;
    for (const item of items) {
      if (!SITES[item.site]) continue;
      if (item.importKey && seen.has(item.importKey)) { duplicates++; continue; }
      if (beforeInstallOnly && item.timestamp >= installedAt) { afterInstall++; continue; }
      if (item.importKey) seen.add(item.importKey);
      fresh.push(buildEvent({ ...item, source }));
    }
    return { next: [...events, ...fresh], value: { ok: true, added: fresh.length, duplicates, afterInstall } };
  });
}

// ---------- Connected platforms (permissions) ----------
// AI sites are optional permissions: PromptPrint only reads a site after the
// person allows it (welcome page or the popup's switches), and stops the
// moment they switch it off. The tracker is registered for allowed sites only.
const AI_ORIGINS = chrome.runtime.getManifest().optional_host_permissions;

async function grantedOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  return AI_ORIGINS.filter((o) => origins.includes(o));
}

async function syncTracker() {
  const origins = await grantedOrigins();
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ["tracker"] });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: ["tracker"] });
  if (origins.length) {
    await chrome.scripting.registerContentScripts([
      { id: "tracker", matches: origins, js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true },
    ]);
  }
  return origins;
}

// Start tracking in tabs that were already open when access was granted.
async function startInOpenTabs(origins) {
  if (!origins?.length) return;
  for (const tab of await chrome.tabs.query({ url: origins })) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "ping" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
    }
  }
}

let syncQueue = Promise.resolve();
const serialSync = (task) => (syncQueue = syncQueue.then(task).catch((e) => console.warn("[PromptPrint]", e)));

chrome.permissions.onAdded.addListener(({ origins }) =>
  serialSync(async () => {
    await syncTracker();
    await startInOpenTabs((origins ?? []).filter((o) => AI_ORIGINS.includes(o)));
  })
);
chrome.permissions.onRemoved.addListener(() => serialSync(syncTracker));
chrome.runtime.onStartup.addListener(() => serialSync(syncTracker));

// ---------- "Load data": check open AI tabs for prompts not yet counted ----------
async function scanTab(tab) {
  const ask = () => chrome.tabs.sendMessage(tab.id, { type: "scan-page" });
  try {
    return await ask();
  } catch {
    // Tab was opened before the extension was installed or reloaded:
    // add the tracker to it now, then ask again.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await ask();
  }
}

async function loadRecentData() {
  const origins = await grantedOrigins();
  if (!origins.length) return { ok: true, connected: 0, tabs: 0, tabsRead: 0, found: 0, added: 0 };
  const tabs = await chrome.tabs.query({ url: origins });
  const items = [];
  let tabsRead = 0;
  for (const tab of tabs) {
    try {
      const res = await scanTab(tab);
      if (res?.items) {
        items.push(...res.items);
        tabsRead++;
      }
    } catch (e) {
      console.warn("[PromptPrint] could not read tab", tab.url, e);
    }
  }
  const saved = await addUniqueEvents(items, { source: "scan" });
  return { ...saved, connected: origins.length, tabs: tabs.length, tabsRead, found: items.length };
}

// ---------- Install / update ----------
// Older versions could add made-up sample data; delete it so only real usage remains.
function removeSampleData() {
  return updateEvents((events) => {
    const next = events.filter((e) => !e.demo);
    return { next, value: events.length - next.length };
  });
}

const openWelcome = () => chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { installedAt } = await chrome.storage.local.get("installedAt");
  if (reason === "install" || !installedAt) await chrome.storage.local.set({ installedAt: Date.now() });
  await removeSampleData();
  const origins = await serialSync(syncTracker);
  // Tabs open during install/update still run the old tracker (or none):
  // start the current one there so tracking continues without reloading.
  await startInOpenTabs(origins);
  // Ask for permission on first install, and after an update that left no
  // platform connected (e.g. upgrading from a version that didn't ask).
  if (reason === "install" || (reason === "update" && !origins?.length)) openWelcome();
});

// ---------- Messages from content.js, popup.js and import.js ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "ai-event":
        return addUniqueEvents([msg], { source: "live" });
      case "manual-log":
        return addUniqueEvents([msg], { source: "manual" });
      case "import-events":
        return addUniqueEvents(msg.items ?? [], { source: "import", beforeInstallOnly: true });
      case "load-recent":
        return loadRecentData();
      case "open-welcome":
        await openWelcome();
        return { ok: true };
      case "clear":
        await updateEvents(() => ({ next: [], value: null }));
        return { ok: true };
      default:
        return { ok: false, error: "unknown message type" };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // keep the channel open for the async reply
});
