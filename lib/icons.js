// lib/icons.js: icons for each AI platform.
//
// Shows the site's real icon from Chrome's own favicon cache (the "favicon"
// permission: no network request is made by PromptPrint). If Chrome has no
// icon for a site yet (you've never visited it), Chrome returns a generic
// globe; we detect that and keep a colored letter badge instead.
// Load after lib/constants.js.

(function () {
  const faviconUrl = (pageUrl, size) => {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", String(size));
    return url.toString();
  };

  const isLight = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
  };

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Pixels of an icon at 16×16, to compare with Chrome's generic globe.
  function pixels(img) {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 16, 16);
    return ctx.getImageData(0, 0, 16, 16).data.join(",");
  }

  let genericIcon = null; // Chrome's "no icon known" globe, as pixels
  function generic() {
    // Same size as the site icons below, so the pixels can be compared.
    genericIcon ??= loadImage(faviconUrl("https://no-icon.invalid/", 64)).then(pixels).catch(() => "");
    return genericIcon;
  }

  // A span with the site's letter badge; its real icon replaces the letter
  // once (and if) Chrome has one.
  function siteIcon(site, size = 30) {
    const info = PP.SITES[site];
    const color = PP.siteColor(site);
    const badge = document.createElement("span");
    badge.className = "site-badge";
    badge.setAttribute("aria-hidden", "true");
    Object.assign(badge.style, {
      width: `${size}px`,
      height: `${size}px`,
      fontSize: `${Math.round(size * 0.43)}px`,
      background: color,
      color: isLight(color) ? "#1d1d1b" : "#ffffff",
    });
    badge.textContent = info?.name?.[0] ?? "?";
    if (!info) return badge;

    const iconPx = Math.round(size * 0.66);
    const src = faviconUrl(`https://${info.hosts[0]}/`, 64);
    const showIcon = () => {
      const img = new Image(iconPx, iconPx);
      img.alt = "";
      img.src = src;
      badge.replaceChildren(img);
      badge.classList.add("has-icon");
      badge.style.background = "";
      badge.style.color = "";
    };

    // Remembered per site, so redraws show the icon straight away (no flicker).
    if (known[site] === true) showIcon();
    else if (known[site] === undefined) {
      checks[site] ??= loadImage(src)
        .then(async (img) => (known[site] = pixels(img) !== (await generic())))
        .catch(() => (known[site] = false));
      checks[site].then((has) => has && showIcon());
    }
    return badge;
  }

  const known = {}; // site → true (real icon) / false (letter badge)
  const checks = {};

  PP.siteIcon = siteIcon;
})();
