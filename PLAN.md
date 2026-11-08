# AI Carbon Footprint Tracker: Hackathon Plan (Environment Track)

**Working name:** *Evergreen*. Rename it to whatever the team likes.

**One-line pitch:** A browser extension that shows how you use AI chatbots, estimates the carbon each conversation costs, and suggests lower-impact alternatives for the tasks you lean on AI for most.

---

## 1. What we're building

| Feature | What the user sees | Priority |
|---|---|---|
| **Usage tracking** | "This week: 55% ChatGPT, 30% Claude, 15% Gemini" (by messages and by estimated tokens) | Must have |
| **Carbon estimate** | "≈ 42 g CO₂e this week, about the same as driving 0.1 miles", with a low–high range | Must have |
| **Task categories** | Each prompt is sorted into Math, Coding, Writing, Research, etc. and shown in a chart | Must have |
| **Analytics dashboard** | Pie chart (which AI), bar chart (task category), line chart (emissions over time) | Must have |
| **Suggestions** | "You use Claude for math homework 75% of the time. Try Desmos, Wolfram Alpha, Khan Academy, or your textbook's worked examples." | Must have |
| Weekly goal and streaks | "Cut AI emissions 20% this week" with a progress bar | Nice to have |
| Model right-sizing tips | "Simple questions don't need the biggest model. Use a smaller or faster mode." | Nice to have |
| Export / share card | A shareable image of your weekly footprint | Stretch |

**Scope rule:** get the four must-haves working end to end with demo data **before** touching anything else.

---

## 2. How it works

```
 ┌──────────────────────────────┐
 │  AI sites (chatgpt.com,      │
 │  claude.ai, gemini.google.com│
 │  copilot, perplexity)        │
 │   └─ content script watches  │
 │      for new user messages   │
 │      and AI replies          │
 └──────────────┬───────────────┘
                │ chrome.runtime.sendMessage({site, promptText, responseLength, time})
                ▼
 ┌──────────────────────────────┐
 │ Background service worker    │
 │  1. categorize(prompt)       │──► categories.js (keyword rules)
 │  2. estimateEmissions(...)   │──► emissions.js (energy × grid intensity)
 │  3. save event (no raw text) │──► chrome.storage.local
 └──────────────┬───────────────┘
                ▼
 ┌──────────────────────────────┐      ┌───────────────────────────┐
 │ Popup (toolbar icon)         │      │ Dashboard page (full tab) │
 │ today's grams, top AI, 1 tip │      │ charts + suggestions      │
 └──────────────────────────────┘      └───────────────────────────┘
```

### Tech stack (chosen for hackathon speed)
- **Chrome extension, Manifest V3.** It also works in Edge, Brave and Arc.
- **Plain HTML, CSS and JavaScript, with no build step.** Nobody loses an hour fixing bundler problems. You load the folder with "Load unpacked" and it runs.
- **Chart.js** for graphs. Put a copy of `chart.umd.min.js` in `lib/`, because MV3 extensions can't load scripts from a CDN.
- **chrome.storage.local** for data. Everything stays on the user's machine, which is a privacy point worth making in the pitch.

### Repository layout
```
zbc/
├── manifest.json
├── background.js            # service worker: receives events, categorizes, stores
├── content/
│   ├── common.js            # shared: observe DOM, send events
│   ├── chatgpt.js           # site-specific selectors
│   ├── claude.js
│   └── gemini.js
├── lib/
│   ├── categories.js        # prompt → category
│   ├── emissions.js         # event → Wh, g CO₂e
│   ├── suggestions.js       # category stats → alternatives
│   └── chart.umd.min.js
├── popup/   (popup.html, popup.js, popup.css)
├── dashboard/ (dashboard.html, dashboard.js, dashboard.css)
├── demo/seed-data.js        # realistic fake week of usage for the demo
└── README.md
```

---

## 3. Component details

### 3a. Usage tracking (content scripts)
- Use a **`MutationObserver`** on the chat container. When a new *user* message bubble appears, record it. When the *assistant* message stops changing for about 1.5 seconds, record its length.
- Watch the page, not the send button. Users press Enter, click Send, and edit messages, and the message bubble appears in every case.
- Each AI site needs its own selectors in its own file. Open DevTools on each site and find stable attributes. Prefer `data-*` attributes and ARIA roles over generated class names, which change often.
- Data sent per event: `{ site, model (if visible on page), promptChars, responseChars, timestamp, promptText }`. The worker categorizes `promptText` and then **throws it away**. Only the category is stored.
- **Fallbacks, because these sites change their HTML often:**
  1. A "+ Log manual entry" button in the popup.
  2. `demo/seed-data.js`, so the demo never depends on live scraping.

### 3b. Carbon estimate (`emissions.js`)
No provider publishes exact per-prompt numbers, so the honest approach is a **transparent estimate shown as a range**. Judges will respect clearly stated assumptions more than false precision.

```
tokens      ≈ characters / 4
energy_Wh   = baseWh[provider] × (1 + responseTokens / referenceTokens)
gCO2e       = energy_Wh / 1000 × gridIntensity (gCO2e/kWh)
```

Starting assumptions (double-check the sources and cite them in the app's "Methodology" section):

| Input | Starting value | Source to cite |
|---|---|---|
| Gemini median text prompt | ~0.24 Wh, ~0.03 g CO₂e | Google's 2025 report on Gemini's environmental footprint |
| ChatGPT average query | ~0.34 Wh | Sam Altman blog post, June 2025 |
| Claude | No official figure; use ~0.3 Wh as an assumption and label it that way | — |
| Grid intensity | ~400 g CO₂e/kWh (approximate US average) | EPA eGRID, or the Electricity Maps API as a stretch |
| Long or reasoning-heavy replies | Scale up with output length; reasoning modes can use many times more energy | Academic estimates, e.g. "How Hungry is AI?" (2025) |

**Make the numbers relatable**, because a few grams means nothing on its own. Convert them to equivalents such as miles driven (EPA: ~400 g CO₂ per mile for an average car), smartphone charges, or hours of an LED bulb. Look up the current EPA Greenhouse Gas Equivalencies figures before using them.

Also consider showing **water use** (Google reports ~0.26 mL per Gemini prompt). It fits the Environment track and makes a strong slide.

### 3c. Task categories (`categories.js`)
**Start with keyword rules.** They're fast, free, private, and use no extra AI (which matters for an app about reducing AI use).

```js
const CATEGORIES = {
  "Math":       [/\bsolve\b/, /integral|derivative|equation|calculus|algebra|\bx\s*=/i, /homework/i],
  "Coding":     [/\bcode\b|function|error|bug|python|javascript|```/i],
  "Writing":    [/essay|rewrite|paraphrase|email|cover letter|grammar/i],
  "Research":   [/what is|who is|explain|history of|summari[sz]e/i],
  "Brainstorm": [/ideas? for|brainstorm|suggest|names? for/i],
  "Other":      []
};
```
- Score each category by the number of matches and pick the highest. Ties and zero matches go to "Other".
- Write about 10 test prompts per category and check the accuracy. Present that number in the demo.
- **Stretch:** run a small on-device classifier, such as a zero-shot model through transformers.js, for better accuracy without sending data anywhere.

### 3d. Dashboard (`dashboard/`)
1. **Header:** total g CO₂e this week, the real-world equivalent, and the percent change from last week.
2. **Doughnut chart:** share of messages by AI provider.
3. **Bar chart:** messages per task category, with each bar split by provider.
4. **Line chart:** daily emissions over 7 or 30 days.
5. **Suggestions panel** (see below).
6. **Methodology link:** the assumptions table from 3b. This builds credibility with judges.

### 3e. Suggestions (`suggestions.js`)
Rule: **if a category is more than 30% of usage and has at least 5 prompts this week, show its alternatives.** Name the provider and percentage in the message so it feels personal.

| Category | Lower-impact alternatives |
|---|---|
| Math | Textbook worked examples, Khan Academy, Desmos, Wolfram Alpha, Paul's Online Math Notes, office hours or tutoring center |
| Coding | Official docs (MDN, Python docs), Stack Overflow search, your IDE's autocomplete, rubber-duck debugging |
| Writing | Purdue OWL, the campus writing center, a thesaurus, your editor's built-in grammar check |
| Research | Plain web search, Wikipedia, the university library databases |
| Brainstorm | Set a 5-minute timer and brainstorm alone first; mind map; ask a classmate |
| All | Use a smaller or faster model for simple questions; put everything in one detailed prompt instead of many follow-ups; avoid regenerating replies |

Include an estimated saving: "Switching half of your math prompts to Desmos would save about X g CO₂e per week."

---

## 4. Team roles (adjust for team size)

| Person | Owns |
|---|---|
| **A – Extension core** | `manifest.json`, `background.js`, storage, message passing, popup |
| **B – Site trackers** | Content scripts for ChatGPT, Claude and Gemini; testing selectors; manual-entry fallback |
| **C – Data & logic** | `emissions.js`, `categories.js`, `suggestions.js`, seed data, methodology and citations |
| **D – Dashboard & pitch** | Dashboard UI and charts, branding and logo, slides, Devpost write-up, demo video |

**Agree on the data contract first.** Everyone builds against this event shape:
```js
{ id, site: "claude"|"chatgpt"|"gemini", model, category, promptTokens, responseTokens, wh, gco2e, timestamp }
```

---

## 5. Timeline (assumes about 24 hours; scale it to the real schedule)

| Hours | Goal |
|---|---|
| 0–1 | Agree on the data contract, set up the repo, get a "Hello" popup loading in Chrome |
| 1–4 | Background worker and storage; first content script (pick the easiest site); seed data |
| 4–8 | Emissions and category logic; dashboard showing seed data in all 3 charts |
| 8–12 | Content scripts for the other two sites; suggestions panel; popup summary |
| **12 – checkpoint** | **Full flow works: chat on a site → appears on dashboard. If not, cut scope now.** |
| 12–16 | Polish the UI, add the methodology page, test category accuracy, handle edge cases |
| 16–20 | Nice-to-haves (goals, water use, model-size tips) only if the core is stable |
| 20–22 | Freeze features. Record the demo video, write the Devpost entry, make slides |
| 22–24 | Rehearse the pitch twice, fix only bugs that would break the demo |

---

## 6. Demo script (about 3 minutes)

1. **Hook (20 s):** "Every AI prompt uses electricity and water. Students send hundreds of prompts a week and have no idea what it costs."
2. **Live (60 s):** Ask Claude a math question. The popup count goes up. Open the dashboard.
3. **Insight (40 s):** Show the seeded week: "75% of my Claude use is math homework, about X g CO₂e, about the same as Y."
4. **Action (30 s):** Show the suggestions: Desmos, Khan Academy, textbook, and the estimated savings.
5. **Credibility (20 s):** Show the methodology: published figures, ranges shown, all data stays on the device.
6. **Close (10 s):** "Use AI when it's worth it. Evergreen shows you when it isn't."

---

## 7. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| AI site HTML changes and breaks tracking | Isolate selectors per site; manual-entry button; seed data for the demo |
| Emission numbers questioned by judges | Cite sources, show ranges, label assumptions, include a methodology page |
| Privacy concerns about reading prompts | Categorize locally, never store raw text, never send data anywhere |
| Running out of time | Hour-12 checkpoint; nice-to-haves only after the core works |
| "Isn't this ironic if it uses AI?" | Categorization uses keyword rules, not AI, which supports the message |

---

## 8. Day-one checklist

- [ ] Everyone has Chrome, VS Code and access to the `zbc-nb/zbc` repository
- [ ] Read the hackathon's Environment track description and judging criteria, and adjust the pitch to match them
- [ ] Check the hackathon rules about code written before the event
- [ ] Create the `manifest.json` skeleton and load it unpacked
- [ ] Assign roles from Section 4
- [ ] Agree on the event data shape
