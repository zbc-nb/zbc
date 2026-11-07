// lib/grid-data.js: how much CO₂ each country's electricity grid emits per kWh.
// Approximate 2023 figures based on Ember / Our World in Data. Verify the ones you
// present at ourworldindata.org (search "carbon intensity of electricity").
//
// Columns: [ISO numeric code (matches the map file), ISO 2-letter code, country, g CO₂e per kWh]

(function () {
  const GRID = [
    ["840", "US", "United States", 370], ["356", "IN", "India", 710], ["076", "BR", "Brazil", 100],
    ["826", "GB", "United Kingdom", 220], ["276", "DE", "Germany", 380], ["360", "ID", "Indonesia", 680],
    ["392", "JP", "Japan", 480], ["250", "FR", "France", 55], ["484", "MX", "Mexico", 410],
    ["156", "CN", "China", 560], ["724", "ES", "Spain", 170], ["124", "CA", "Canada", 130],
    ["380", "IT", "Italy", 330], ["608", "PH", "Philippines", 610], ["410", "KR", "South Korea", 430],
    ["586", "PK", "Pakistan", 400], ["566", "NG", "Nigeria", 400], ["792", "TR", "Turkey", 420],
    ["036", "AU", "Australia", 500], ["704", "VN", "Vietnam", 470], ["818", "EG", "Egypt", 470],
    ["616", "PL", "Poland", 650], ["032", "AR", "Argentina", 340], ["050", "BD", "Bangladesh", 570],
    ["764", "TH", "Thailand", 500], ["158", "TW", "Taiwan", 560], ["710", "ZA", "South Africa", 700],
    ["528", "NL", "Netherlands", 330], ["170", "CO", "Colombia", 200], ["643", "RU", "Russia", 360],
    ["682", "SA", "Saudi Arabia", 560], ["458", "MY", "Malaysia", 600], ["804", "UA", "Ukraine", 260],
    ["404", "KE", "Kenya", 100], ["152", "CL", "Chile", 290], ["376", "IL", "Israel", 520],
    ["784", "AE", "United Arab Emirates", 440], ["604", "PE", "Peru", 250], ["364", "IR", "Iran", 500],
    ["752", "SE", "Sweden", 40], ["056", "BE", "Belgium", 150], ["642", "RO", "Romania", 260],
    ["756", "CH", "Switzerland", 40], ["620", "PT", "Portugal", 160], ["504", "MA", "Morocco", 610],
    ["203", "CZ", "Czechia", 450], ["040", "AT", "Austria", 160], ["300", "GR", "Greece", 340],
    ["288", "GH", "Ghana", 480], ["578", "NO", "Norway", 30], ["372", "IE", "Ireland", 290],
    ["208", "DK", "Denmark", 150], ["348", "HU", "Hungary", 220], ["246", "FI", "Finland", 80],
    ["554", "NZ", "New Zealand", 110], ["398", "KZ", "Kazakhstan", 640], ["231", "ET", "Ethiopia", 25],
    ["352", "IS", "Iceland", 30],
  ].map(([id, code, name, grid]) => ({ id, code, name, grid }));

  const byId = new Map(GRID.map((c) => [c.id, c]));

  // Guess the user's country from the browser language, e.g. "en-US" → United States.
  function guessCountryId() {
    for (const lang of navigator.languages ?? [navigator.language]) {
      const region = lang.split("-")[1]?.toUpperCase();
      const match = GRID.find((c) => c.code === region);
      if (match) return match.id;
    }
    return null;
  }

  Object.assign(globalThis.PP, { GRID, gridById: byId, guessCountryId });
})();
