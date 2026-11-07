// lib/constants.js: numbers and helpers shared by background.js, the popup
// and the world map. Change an assumption here and it updates everywhere.
// Every value is an approximation. Check the sources in README.md before presenting.

(function () {
  // Energy per typical prompt + reply (watt-hours) and chart colors.
  // Only Google (Gemini) and OpenAI (ChatGPT) have published per-prompt figures;
  // the others use 0.3 Wh as a stated assumption. Colors were checked for
  // color-blind separation in this order, so keep it when adding sites.
  const SITES = {
    chatgpt: { hosts: ["chatgpt.com", "chat.openai.com"], name: "ChatGPT", baseWh: 0.34, source: "Published by OpenAI (June 2025)", published: true, color: "#10a37f", colorDark: "#10a37f" },
    claude: { hosts: ["claude.ai"], name: "Claude", baseWh: 0.3, source: "Our estimate: no published figure", published: false, color: "#d97757", colorDark: "#cc6a4a" },
    gemini: { hosts: ["gemini.google.com"], name: "Gemini", baseWh: 0.24, source: "Published by Google (Aug 2025)", published: true, color: "#4285f4", colorDark: "#4285f4" },
    perplexity: { hosts: ["www.perplexity.ai"], name: "Perplexity", baseWh: 0.3, source: "Our estimate: no published figure", published: false, color: "#e87ba4", colorDark: "#d55181" },
    copilot: { hosts: ["copilot.microsoft.com"], name: "Copilot", baseWh: 0.3, source: "Our estimate: no published figure", published: false, color: "#eda100", colorDark: "#c98500" },
    deepseek: { hosts: ["chat.deepseek.com"], name: "DeepSeek", baseWh: 0.3, source: "Our estimate: no published figure", published: false, color: "#6250d6", colorDark: "#9085e9" },
    grok: { hosts: ["grok.com"], name: "Grok", baseWh: 0.3, source: "Our estimate: no published figure", published: false, color: "#e34948", colorDark: "#e66767" },
    mistral: { hosts: ["chat.mistral.ai"], name: "Mistral", baseWh: 0.3, source: "Our estimate: no published figure", published: false, color: "#008300", colorDark: "#008300" },
  };
  const OTHER_COLOR = { light: "#9aa59f", dark: "#6b7670" };

  const CATEGORY_ORDER = ["Math", "Coding", "Writing", "Research", "Brainstorm", "Other"];

  // Everyday comparisons for the popup's dropdown.
  //   basis "g"  → compared using grams of CO₂e
  //   basis "wh" → compared using watt-hours of electricity
  const EQUIVALENTS = [
    {
      id: "driving",
      label: "Driving a gas car",
      basis: "g",
      // ~400 g CO₂ per mile (EPA) at ~30 mph average ≈ 200 g per minute
      describe: (g) =>
        `${fmtDuration(g / 200)} of driving a gas car` +
        (g / 400 >= 0.01 ? ` (≈ ${fmtNum(g / 400)} miles)` : ` (≈ ${fmtNum((g / 400) * 5280)} feet)`),
    },
    {
      id: "phone",
      label: "Charging a phone",
      basis: "wh",
      // ~15 Wh to fully charge a typical smartphone, including charger losses
      describe: (wh) => `${fmtNum(wh / 15)} full smartphone charges`,
    },
    {
      id: "led",
      label: "Lighting an LED bulb",
      basis: "wh",
      describe: (wh) => `${fmtDuration((wh / 10) * 60)} of a 10 W LED bulb`,
    },
    {
      id: "laptop",
      label: "Using a laptop",
      basis: "wh",
      describe: (wh) => `${fmtDuration((wh / 50) * 60)} of using a 50 W laptop`,
    },
    {
      id: "streaming",
      label: "Streaming video",
      basis: "wh",
      // IEA (2020): ~0.077 kWh per hour of streaming, incl. network and device
      describe: (wh) => `${fmtDuration((wh / 77) * 60)} of streaming video`,
    },
    {
      id: "microwave",
      label: "Running a microwave",
      basis: "wh",
      describe: (wh) => `${fmtDuration((wh / 1000) * 60)} of running a 1,000 W microwave`,
    },
    {
      id: "kettle",
      label: "Boiling a kettle",
      basis: "wh",
      // ~0.1 kWh to boil 1 liter of water
      describe: (wh) =>
        wh < 100
          ? `boiling ${Math.max(1, Math.round(wh))}% of a 1-liter kettle`
          : `boiling a 1-liter kettle ${fmtNum(wh / 100)} times`,
    },
    {
      id: "search",
      label: "Google searches",
      basis: "wh",
      // Google (2009): ~0.3 Wh per search
      describe: (wh) => `${fmtNum(wh / 0.3)} Google searches`,
    },
    {
      id: "bottles",
      label: "500 mL water bottles",
      basis: "water",
      // cooling water (liters) at the chosen L/kWh rate, divided into 0.5 L bottles
      describe: (liters) => `${fmtNum(liters / 0.5)} bottles of cooling water (500 mL each)`,
    },
    {
      id: "tree",
      label: "A tree absorbing CO₂",
      basis: "g",
      // A mature tree absorbs roughly 22 kg CO₂ a year ≈ 60 g a day
      describe: (g) => `${fmtDuration((g / 60) * 24 * 60)} of CO₂ absorbed by one tree`,
    },
  ];

  // Human-friendly number: 0.042 → "0.04", 3.456 → "3.5", 1234 → "1,234"
  function fmtNum(n) {
    if (!isFinite(n)) return "0";
    const abs = Math.abs(n);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 1 : 2;
    return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  }

  // Minutes → "45 seconds", "12 minutes", "3.5 hours", "2.1 days"
  function fmtDuration(minutes) {
    const plural = (v, unit) => `${fmtNum(v)} ${unit}${fmtNum(v) === "1" ? "" : "s"}`;
    if (minutes < 1) return plural(minutes * 60, "second");
    if (minutes < 60) return plural(minutes, "minute");
    if (minutes < 60 * 48) return plural(minutes / 60, "hour");
    return plural(minutes / (60 * 24), "day");
  }

  // Share (0–1) → percent text that never hides small amounts:
  // 0.003 → "0.3%", 0.0004 → "<0.1%", 0.994 → "99.4%", 0.42 → "42%".
  function fmtPct(share) {
    if (!share || share <= 0) return "0%";
    if (share >= 1) return "100%";
    const p = share * 100;
    if (p < 0.1) return "<0.1%";
    if (p > 99.9) return ">99.9%";
    if (p < 10 || p > 90) return `${parseFloat(p.toFixed(1))}%`;
    return `${Math.round(p)}%`;
  }

  // Grams → "850 g" or "12.4 kg" or "3.1 t"
  function fmtGrams(g) {
    if (g >= 1e6) return `${fmtNum(g / 1e6)} t`;
    if (g >= 1000) return `${fmtNum(g / 1000)} kg`;
    return `${fmtNum(g)} g`;
  }

  // Watt-hours → "35 Wh" or "4.2 kWh" or "1.3 MWh"
  function fmtWh(wh) {
    if (wh >= 1e6) return `${fmtNum(wh / 1e6)} MWh`;
    if (wh >= 1000) return `${fmtNum(wh / 1000)} kWh`;
    return `${fmtNum(wh)} Wh`;
  }

  const isDark = () =>
    typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  const siteColor = (site) =>
    SITES[site] ? (isDark() ? SITES[site].colorDark : SITES[site].color) : isDark() ? OTHER_COLOR.dark : OTHER_COLOR.light;

  globalThis.PP = {
    SITES,
    CATEGORY_ORDER,
    EQUIVALENTS,
    REFERENCE_REPLY_TOKENS: 500, // a "typical" reply length for baseWh
    DEFAULT_GRID_G_PER_KWH: 400, // approx. US average grid carbon intensity
    CHARS_PER_TOKEN: 4,
    UNCERTAINTY: { low: 0.5, high: 2 },
    DEFAULT_WATER_L_PER_KWH: 1.8, // illustrative on-site cooling scenario, adjustable
    // Average use: OpenAI / NBER, "How People Use ChatGPT" (Chatterji et al., Sept 2025):
    // ~18 billion messages a week from ~700 million weekly users (July 2025).
    AVERAGE_USER: { messagesPerWeek: 18e9, weeklyUsers: 700e6, promptsPerDay: 18e9 / 700e6 / 7 },
    // US EPA social cost of carbon (2023 update, 2% discount rate): ~$190 per tonne CO₂.
    SOCIAL_COST_USD_PER_TONNE: 190,
    originsFor: (site) => (SITES[site]?.hosts ?? []).map((h) => `https://${h}/*`),
    fmtNum,
    fmtDuration,
    fmtPct,
    fmtGrams,
    fmtWh,
    siteColor,
  };
})();
