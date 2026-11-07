# PromptPrint: AI Carbon Footprint Tracker

A Chrome extension that tracks how you use AI chatbots (ChatGPT, Claude, Gemini), estimates the carbon footprint of your prompts, and suggests lower-impact alternatives for the tasks you rely on AI for most.

Built for the Binghamton hackathon **Environment track**. See [PLAN.md](PLAN.md) for the full project plan.

## Features
- **Usage tracking:** counts the prompts you send on chatgpt.com, claude.ai and gemini.google.com
- **Load data:** re-reads your open AI tabs and adds any prompts that weren't counted yet (never double-counts)
- **Import past history:** reads the chat exports from ChatGPT, Claude and Google Takeout (Gemini) to show your footprint from before you installed it
- **Time periods:** last 7 days, last 30 days, or all time
- **Carbon estimate:** grams of CO₂e per prompt, shown as a range and compared to phone charges and miles driven
- **Task categories:** sorts each prompt into Math, Coding, Writing, Research, Brainstorm or Other
- **Charts:** which AI you use, what you use it for, and daily emissions
- **Suggestions:** alternatives for your most common AI tasks, with estimated savings
- **Private:** everything stays in your browser. The text of your prompts is never saved; only the category is.

## Supported AI sites
| Site | Live tracking | Reply length measured | Load data | History import |
|---|---|---|---|---|
| ChatGPT (chatgpt.com) | ✅ | ✅ | ✅ | ✅ |
| Claude (claude.ai) | ✅ | ✅ | ✅ | ✅ |
| Gemini (gemini.google.com) | ✅ | ✅ | ✅ | ✅ |
| Perplexity, Copilot, DeepSeek, Grok, Mistral Le Chat | ✅ (counted when you press send) | ❌ typical length assumed | ❌ | ❌ |

**Not trackable live:** the phone and desktop apps, and any browser without the extension. Their chats *are* included in each AI's data export, so **Import past chat history** covers them for ChatGPT, Claude and Gemini.

Energy per prompt is published only for Gemini and ChatGPT; every other AI uses an assumed 0.3 Wh (see `lib/constants.js`).

## Install (developer mode)
1. Download this repository: **Code → Download ZIP** on GitHub, then unzip it. Or clone it with Git.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the project folder (the one containing `manifest.json`).
5. Pin the extension: click the puzzle-piece icon, then the pin next to **PromptPrint**.
6. Use any supported AI site as usual. Click the icon and press **⟳ Load data** to also pick up chats already open in your tabs, or **Import past chat history** for older chats.

After changing code, click the reload button on the extension's card in `chrome://extensions`, then refresh any open AI tabs.

## Project structure
| File | What it does |
|---|---|
| `manifest.json` | Chrome's configuration: permissions, which sites the extension runs on, icons |
| `content.js` | Runs on the AI sites. Spots each prompt you send and measures the reply length |
| `background.js` | Categorizes prompts, estimates energy and carbon, saves events without duplicates, runs **Load data** |
| `popup.html` / `popup.css` / `popup.js` | The window that opens when you click the icon: totals, "That's about the same as…" dropdown, charts, suggestions |
| `import.html` / `import.css` / `import.js` | The history importer: reads ChatGPT / Claude / Gemini export files in the browser (nothing is uploaded) |
| `map.html` / `map.css` / `map.js` | The interactive world map: your real usage and what it would emit on each country's power grid |
| `lib/grid-data.js` | Carbon intensity of each country's electricity grid (approximate, Ember / Our World in Data 2023) |
| `lib/constants.js` | Shared assumptions: energy per prompt, colors, everyday comparisons, number formatting |
| `lib/d3.min.js`, `lib/topojson-client.min.js` | Map-drawing libraries (D3 v7.9.0, topojson-client v3.1.0, ISC license) |
| `data/countries-110m.json` | Country shapes (world-atlas v2.0.2, ISC license; Natural Earth, public domain) |
| `assets/` | Icons |

## Collecting data from many users (for a real world map)
Right now each person's data stays in their own browser, so the map shows only **your own** usage. To compare many users by country:

1. **Ask first.** Add a clear opt-in switch ("Share anonymous weekly totals to improve the world map"), off by default, plus a privacy policy. The Chrome Web Store requires this for any data that leaves the browser.
2. **Send only summaries, never prompts.** For example, once a week: `{ country, week, prompts, wh, gco2e, siteCounts, categoryCounts }`. Get the country from a dropdown the user picks, not from tracking their location.
3. **Store them in a small backend,** such as Firebase or Supabase (both have free tiers). One table of weekly summaries is enough.
4. **Add them up per country** on the server, and hide countries with fewer than ~20 users, so no one can be singled out.
5. **Add the shared numbers to the map:** fetch the per-country totals in `map.js` and show them next to the user's own usage.

## Past history (before installing)
Live tracking only sees prompts sent after installing. For older chats, use **Import my real chat history** in the popup. It reads the export ZIPs from ChatGPT (Settings → Data controls → Export data), Claude (Settings → Privacy → Export data) and Google Takeout (My Activity → Gemini Apps, JSON format). Only chats from before the install date are imported, and re-importing never double-counts.

These export formats aren't officially documented. The Gemini importer has been confirmed with a real Google Takeout export; the ChatGPT and Claude parsers follow the commonly seen structure and were tested with sample files. If an import finds 0 prompts, compare the real file to the parser in `import.js` and adjust it.

## Methodology
No AI company publishes exact per-prompt figures for every model, so these are **transparent estimates**:

```
tokens    ≈ characters ÷ 4
energy_Wh = base Wh per prompt × (reply tokens ÷ 500), clamped to 0.25×–10×
g CO₂e    = energy_Wh ÷ 1000 × grid intensity (g CO₂e per kWh)
```

| Assumption | Value | Source |
|---|---|---|
| Gemini, per median text prompt | 0.24 Wh | Google, *Measuring the environmental impact of AI inference* (Aug 2025) |
| ChatGPT, per average query | 0.34 Wh | Sam Altman, *The Gentle Singularity* (June 2025) |
| Claude, per prompt | 0.30 Wh | No official figure; our assumption |
| Grid carbon intensity | 400 g CO₂e/kWh | Approximate US average (EPA eGRID) |
| Displayed range | 0.5× to 2× the estimate | Reflects uncertainty in all of the above |
| Phone charge / mile driven | 12.4 g / 400 g CO₂ | EPA Greenhouse Gas Equivalencies Calculator |

All values can be changed at the top of `background.js` and `popup.js`. Verify each source before presenting.

## Troubleshooting
- **Prompts aren't being counted:** the AI sites change their HTML often. Open the site, press F12, inspect one of your messages, and update `SELECTORS` at the top of `content.js`. The Console shows `[PromptPrint] tracking <site>` when the script is running.
- **"Extension context invalidated" in the console:** you reloaded the extension; refresh the AI tab.

## Team
_Add your names here._

## License
MIT. See [LICENSE](LICENSE).
