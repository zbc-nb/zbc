// lib/theme.js: applies the chosen theme (see lib/themes.css) as early as
// possible and loads its font. Load this in <head>, before the page's body.
//
// The choice is saved in chrome.storage (so it syncs between pages) and also
// mirrored in localStorage, which can be read instantly to avoid a flash of
// the default theme when the popup opens.

(function () {
  // id, name, two preview colors, and an optional Google Font to load.
  // Fonts are optional: each theme lists fallbacks, so it works offline too.
  const THEMES = [
    { id: "material", name: "Material", dots: ["#386a20", "#d8e8cc"], font: "Roboto:wght@400;500;700" },
    { id: "default", name: "Classic", dots: ["#16804f", "#e3f3ea"] },
    { id: "skeuo", name: "Skeuomorphic", dots: ["#2f6b3a", "#e2d9b6"] },
    { id: "flat", name: "Flat", dots: ["#117a65", "#e67e22"] },
    { id: "neumorph", name: "Neumorphism", dots: ["#e0e5ec", "#a3b1c6"], font: "Poppins:wght@400;500;600" },
    { id: "glass", name: "Glass", dots: ["#8e2de2", "#2ec5ff"], font: "Inter:wght@400;600;700" },
    { id: "clay", name: "Clay", dots: ["#7b45e6", "#ffe7a6"], font: "Nunito:wght@500;700;800" },
    { id: "liquid", name: "Liquid glass", dots: ["#a1c4fd", "#fbc2eb"], font: "Inter:wght@400;600;700" },
    { id: "neobrutal", name: "Neo-brutalism", dots: ["#ffde59", "#5ce1e6"], font: "Space+Grotesk:wght@500;700" },
    { id: "minimal", name: "Minimal", dots: ["#111111", "#ffffff"], font: "Inter:wght@300;400;500;700" },
    { id: "bauhaus", name: "Bauhaus", dots: ["#d7261e", "#1f4e9c"], font: "Jost:wght@400;600;700" },
    { id: "retro", name: "Retrofuturism", dots: ["#f72585", "#00f0ff"], font: "Orbitron:wght@500;700&family=Share+Tech+Mono" },
    { id: "brutal", name: "Brutalism", dots: ["#000000", "#0000ee"] },
    { id: "anti", name: "Anti-design", dots: ["#ffe600", "#0000ff"], font: "Bungee" },
    { id: "acid", name: "Acid", dots: ["#c6ff00", "#ff00e5"], font: "Syne:wght@700;800&family=Space+Grotesk:wght@400;500;700" },
  ];
  const byId = new Map(THEMES.map((t) => [t.id, t]));
  const DEFAULT_THEME = "material"; // used until the person picks one

  function apply(id) {
    const theme = byId.get(id) ?? byId.get(DEFAULT_THEME);
    const root = document.documentElement;
    if (theme.id === "default") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme.id);

    let link = document.getElementById("pp-theme-font");
    if (theme.font) {
      const href = `https://fonts.googleapis.com/css2?family=${theme.font}&display=swap`;
      if (!link) {
        link = document.createElement("link");
        link.id = "pp-theme-font";
        link.rel = "stylesheet";
        document.head.append(link);
      }
      if (link.href !== href) link.href = href;
    } else if (link) {
      link.remove();
    }
    try { localStorage.setItem("pp-theme", theme.id); } catch { /* storage blocked: fine */ }
    return theme.id;
  }

  let initial = DEFAULT_THEME;
  try { initial = localStorage.getItem("pp-theme") || DEFAULT_THEME; } catch { /* use default */ }
  apply(initial);

  // chrome.storage is the source of truth (localStorage can be cleared).
  chrome.storage?.local.get("theme").then(({ theme }) => {
    const wanted = theme || DEFAULT_THEME;
    if (wanted !== initial) apply(wanted);
  });

  globalThis.PPTheme = {
    THEMES,
    current: () => document.documentElement.getAttribute("data-theme") || "default",
    DEFAULT_THEME,
    set(id) {
      const applied = apply(id);
      chrome.storage.local.set({ theme: applied });
      return applied;
    },
  };
})();
