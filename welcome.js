// welcome.js: the first-run page. Lists the AI platforms and asks Chrome for
// permission to read the ones the person ticks. Opened by background.js on
// install, and from the popup's "Connect platforms" button.

const $ = (id) => document.getElementById(id);
const DEFAULT_TICKED = ["chatgpt", "claude", "gemini"];

async function granted() {
  const { origins = [] } = await chrome.permissions.getAll();
  return new Set(origins);
}

const isLight = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
};

async function renderList() {
  const have = await granted();
  const list = $("site-list");
  list.replaceChildren();
  for (const [id, site] of Object.entries(PP.SITES)) {
    const origins = PP.originsFor(id);
    const isOn = origins.some((o) => have.has(o));
    const label = document.createElement("label");
    label.className = "site-option";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = id;
    box.checked = isOn || (!have.size && DEFAULT_TICKED.includes(id));

    const badge = document.createElement("span");
    badge.className = "site-badge";
    badge.setAttribute("aria-hidden", "true");
    const color = PP.siteColor(id);
    badge.style.background = color;
    badge.style.color = isLight(color) ? "#1d1d1b" : "#ffffff";
    badge.textContent = site.name[0];

    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = site.name;
    const host = document.createElement("small");
    host.textContent = site.hosts[0];
    if (isOn) {
      const ok = document.createElement("span");
      ok.className = "granted";
      ok.textContent = " · allowed";
      host.append(ok);
    }
    text.append(name, host);
    label.append(box, badge, text);
    list.append(label);
  }
}

$("select-all").addEventListener("click", () => {
  const boxes = [...document.querySelectorAll("#site-list input")];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => (b.checked = !all));
  $("select-all").textContent = all ? "Select all" : "Clear all";
});

$("allow").addEventListener("click", async () => {
  const result = $("result");
  const chosen = [...document.querySelectorAll("#site-list input:checked")].map((b) => b.value);
  const unchosen = [...document.querySelectorAll("#site-list input:not(:checked)")].map((b) => b.value);
  if (!chosen.length) {
    result.className = "result warn";
    result.textContent = "Tick at least one platform, or close this page to decide later.";
    return;
  }
  try {
    // One Chrome prompt for all selected sites (must run from this click).
    const ok = await chrome.permissions.request({ origins: chosen.flatMap(PP.originsFor) });
    // Sites that were unticked here stop being tracked.
    const remove = unchosen.flatMap(PP.originsFor);
    if (remove.length) await chrome.permissions.remove({ origins: remove }).catch(() => {});
    const names = chosen.map((id) => PP.SITES[id].name).join(", ");
    result.className = ok ? "result ok" : "result warn";
    result.textContent = ok
      ? `Tracking is on for ${names}. You can close this page.`
      : "Chrome didn't grant access. Nothing is being tracked. You can try again anytime.";
  } catch (e) {
    result.className = "result warn";
    result.textContent = `Couldn't ask for permission: ${e.message}`;
  }
  renderList();
});

renderList();
