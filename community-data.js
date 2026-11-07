// community-data.js: SAMPLE data for the world map.
//
// A real version needs a server that collects anonymous, opt-in summaries from
// many users (see README "Collecting data from many users"). Until then this
// file makes realistic-looking numbers in the SAME format a server would send,
// so switching to real data only means replacing getCommunityData().
//
// The user counts are invented. Grid carbon intensity (g CO₂e per kWh) is approximate,
// based on 2023 figures from Ember / Our World in Data. Verify before presenting.

(function () {
  // [ISO numeric code (matches the map file), country, sample users (thousands), grid g/kWh]
  const COUNTRIES = [
    ["840", "United States", 420, 370], ["356", "India", 310, 710], ["076", "Brazil", 120, 100],
    ["826", "United Kingdom", 90, 220], ["276", "Germany", 95, 380], ["360", "Indonesia", 90, 680],
    ["392", "Japan", 85, 480], ["250", "France", 70, 55], ["484", "Mexico", 70, 410],
    ["156", "China", 60, 560], ["724", "Spain", 60, 170], ["124", "Canada", 55, 130],
    ["380", "Italy", 55, 330], ["608", "Philippines", 55, 610], ["410", "South Korea", 50, 430],
    ["586", "Pakistan", 50, 400], ["566", "Nigeria", 45, 400], ["792", "Turkey", 45, 420],
    ["036", "Australia", 40, 500], ["704", "Vietnam", 40, 470], ["818", "Egypt", 30, 470],
    ["616", "Poland", 30, 650], ["032", "Argentina", 30, 340], ["050", "Bangladesh", 30, 570],
    ["764", "Thailand", 30, 500], ["158", "Taiwan", 30, 560], ["710", "South Africa", 25, 700],
    ["528", "Netherlands", 25, 330], ["170", "Colombia", 25, 200], ["643", "Russia", 20, 360],
    ["682", "Saudi Arabia", 20, 560], ["458", "Malaysia", 20, 600], ["804", "Ukraine", 20, 260],
    ["404", "Kenya", 15, 100], ["152", "Chile", 15, 290], ["376", "Israel", 15, 520],
    ["784", "United Arab Emirates", 15, 440], ["604", "Peru", 15, 250], ["364", "Iran", 15, 500],
    ["752", "Sweden", 14, 40], ["056", "Belgium", 14, 150], ["642", "Romania", 14, 260],
    ["756", "Switzerland", 12, 40], ["620", "Portugal", 12, 160], ["504", "Morocco", 12, 610],
    ["203", "Czechia", 12, 450], ["040", "Austria", 10, 160], ["300", "Greece", 10, 340],
    ["288", "Ghana", 10, 480], ["578", "Norway", 9, 30], ["372", "Ireland", 9, 290],
    ["208", "Denmark", 9, 150], ["348", "Hungary", 9, 220], ["246", "Finland", 8, 80],
    ["554", "New Zealand", 8, 110], ["398", "Kazakhstan", 8, 640], ["231", "Ethiopia", 6, 25],
    ["352", "Iceland", 1, 30],
  ];

  // Same random numbers every time for a given country, so the demo is stable.
  function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Shuffle a base mix a little, then make it add up to 1.
  function jitterShares(base, rand, amount) {
    const out = {};
    let total = 0;
    for (const [k, v] of Object.entries(base)) {
      out[k] = Math.max(0.02, v * (1 - amount + rand() * amount * 2));
      total += out[k];
    }
    for (const k in out) out[k] /= total;
    return out;
  }

  function buildCountry([id, name, usersK, grid]) {
    const rand = seededRandom(Number(id) * 7919);
    const siteShare = jitterShares({ chatgpt: 0.58, claude: 0.2, gemini: 0.22 }, rand, 0.45);
    const categoryShare = jitterShares(
      { Math: 0.2, Coding: 0.2, Writing: 0.19, Research: 0.21, Brainstorm: 0.1, Other: 0.1 },
      rand,
      0.6
    );
    const users = usersK * 1000;
    const promptsPerUserWeek = Math.round(25 + rand() * 45);
    const prompts = users * promptsPerUserWeek;

    // Weighted average energy per prompt across the AIs used in this country.
    const whPerPrompt = Object.entries(siteShare).reduce(
      (n, [site, share]) => n + share * PP.SITES[site].baseWh,
      0
    );
    const wh = prompts * whPerPrompt;
    const gco2e = (wh / 1000) * grid;

    return { id, name, users, promptsPerUserWeek, prompts, wh, gco2e, grid, siteShare, categoryShare };
  }

  // Swap this for a fetch() to your server when you have real data, e.g.
  //   return (await fetch("https://your-api.example/stats/weekly")).json();
  async function getCommunityData() {
    const countries = COUNTRIES.map(buildCountry);
    return { sample: true, period: "week", countries };
  }

  globalThis.getCommunityData = getCommunityData;
})();
