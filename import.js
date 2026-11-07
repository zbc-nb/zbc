// import.js: reads chat-history exports from ChatGPT, Claude and Gemini
// (Google Takeout), turns each prompt into { site, promptText, responseChars,
// timestamp, importKey }, and hands them to background.js, which categorizes
// them, estimates energy and CO₂, and keeps only the category (not the text).
//
// These export formats aren't officially documented and can change. If an
// import finds 0 prompts, open the file's conversations.json and adjust the
// parser below.

const $ = (id) => document.getElementById(id);

// ---------- Reading ZIP files (no library needed) ----------

async function openZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The "end of central directory" record sits near the end of every ZIP.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This doesn't look like a ZIP file.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const nameLen = dv.getUint16(p + 28, true);
    entries.push({
      method: dv.getUint16(p + 10, true),
      size: dv.getUint32(p + 20, true),
      offset: dv.getUint32(p + 42, true),
      name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }

  async function readText(entry) {
    const lp = entry.offset;
    const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
    const data = buf.subarray(start, start + entry.size);
    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    }
    throw new Error(`Unsupported compression in ${entry.name}`);
  }

  return { entries, readText };
}

// ---------- Parsers for each AI's export format ----------

const textParts = (parts) => (parts ?? []).filter((x) => typeof x === "string").join("\n");

// Turn an ordered list of { role, text, time, id } into prompts paired with
// the length of the reply that followed each one.
function pairUp(site, messages) {
  const items = [];
  let current = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (!m.text.trim()) continue;
      current = { site, promptText: m.text, responseChars: 0, timestamp: m.time, importKey: `${site}:${m.id}` };
      items.push(current);
    } else if (m.role === "assistant" && current) {
      current.responseChars += m.text.length;
    }
  }
  return items;
}

// ChatGPT: conversations.json, an array of conversations; each has a "mapping"
// of message nodes with author.role, content.parts and create_time (seconds).
function parseChatGPT(conversations) {
  const items = [];
  for (const conv of conversations) {
    const messages = Object.values(conv.mapping ?? {})
      .map((node) => node.message)
      .filter((m) => m && ["user", "assistant"].includes(m.author?.role))
      .filter((m) => !m.metadata?.is_visually_hidden_from_conversation)
      .filter((m) => m.author.role !== "user" || ["text", "multimodal_text"].includes(m.content?.content_type))
      .map((m) => ({
        id: m.id,
        role: m.author.role,
        text: textParts(m.content?.parts) || m.content?.text || "",
        time: Math.round((m.create_time ?? conv.create_time ?? 0) * 1000),
      }))
      .sort((a, b) => a.time - b.time);
    items.push(...pairUp("chatgpt", messages));
  }
  return items;
}

// Claude: conversations.json, an array of conversations; each has
// chat_messages with sender ("human" / "assistant"), text and created_at.
function parseClaude(conversations) {
  const items = [];
  for (const conv of conversations) {
    const messages = (conv.chat_messages ?? [])
      .map((m) => ({
        id: m.uuid,
        role: m.sender === "human" ? "user" : m.sender,
        text: m.text || (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"),
        time: Date.parse(m.created_at),
      }))
      .sort((a, b) => a.time - b.time);
    items.push(...pairUp("claude", messages));
  }
  return items;
}

// Gemini (Google Takeout → My Activity → Gemini Apps, JSON format): an array
// of activity records whose title is "Prompted <your prompt>".
function parseGemini(records) {
  const stripHtml = (html) => new DOMParser().parseFromString(html ?? "", "text/html").body.textContent ?? "";
  return records
    .filter((r) => typeof r.title === "string" && r.title.startsWith("Prompted ") && r.time)
    .map((r) => ({
      site: "gemini",
      promptText: r.title.slice("Prompted ".length),
      responseChars: (r.safeHtmlItem ?? []).reduce((n, h) => n + stripHtml(h.html).length, 0),
      timestamp: Date.parse(r.time),
      importKey: `gemini:${r.time}:${r.title.length}`,
    }));
}

// Claude's newer export first gives a small "manifest" file that lists several
// ZIPs to download; the chats are in the "conversations" one(s).
class ManifestError extends Error {
  constructor(links) {
    super("This is Claude's list of download links, not your chats.");
    this.links = links;
  }
}

function detectAndParse(json) {
  if (json && !Array.isArray(json)) {
    if (Array.isArray(json.data_files)) {
      throw new ManifestError(json.data_files.filter((f) => /conversation/i.test(f.category ?? f.filename ?? "")));
    }
    // A single conversation per file, or { conversations: [...] }.
    json = Array.isArray(json.conversations) ? json.conversations : [json];
  }
  if (!Array.isArray(json) || json.length === 0) return { site: null, items: [] };
  const sample = json.find((x) => x && typeof x === "object") ?? {};
  if ("mapping" in sample) return { site: "ChatGPT", items: parseChatGPT(json) };
  if ("chat_messages" in sample) return { site: "Claude", items: parseClaude(json) };
  if ("title" in sample && "time" in sample) return { site: "Gemini", items: parseGemini(json) };
  return { site: null, items: [] };
}

// ---------- Handling dropped / chosen files ----------

// Files inside an export ZIP that hold chats: conversations.json, or any
// .json / .jsonl file in or named after "conversations", or Google's MyActivity.json.
const WANTED = /(conversation[^/]*\/.*\.jsonl?$|(^|\/)conversations[^/]*\.jsonl?$|(^|\/)my ?activity\.json$)/i;

async function jsonTextsFrom(file) {
  if (/\.jsonl?$/i.test(file.name)) return [await file.text()];
  const zip = await openZip(file);
  const matches = zip.entries.filter((e) => WANTED.test(e.name));
  if (!matches.length) {
    const names = zip.entries.map((e) => e.name).slice(0, 6).join(", ");
    throw new Error(`No chats found inside this ZIP (it contains: ${names || "nothing"}). For Claude, use conversations-000.zip.`);
  }
  return Promise.all(matches.map((e) => zip.readText(e)));
}

// Normal JSON, or "JSON Lines" (one JSON object per line).
function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) return lines.map((l) => JSON.parse(l));
    throw e;
  }
}

async function sendToBackground(items) {
  const totals = { added: 0, duplicates: 0, afterInstall: 0 };
  for (let i = 0; i < items.length; i += 1000) {
    const res = await chrome.runtime.sendMessage({ type: "import-events", items: items.slice(i, i + 1000) });
    if (!res?.ok) throw new Error(res?.error ?? "Saving failed.");
    totals.added += res.added;
    totals.duplicates += res.duplicates;
    totals.afterInstall += res.afterInstall;
  }
  return totals;
}

const fmt = (n) => n.toLocaleString();
let grandTotal = 0;

function addResult(...children) {
  const li = document.createElement("li");
  li.append(...children);
  $("result-list").append(li);
  $("results").hidden = false;
  return li;
}

function span(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

async function handleFile(file) {
  const li = addResult(span("", `${file.name}: reading…`));
  try {
    const texts = await jsonTextsFrom(file);
    let site = null;
    const items = [];
    for (const text of texts) {
      const parsed = detectAndParse(parseJsonText(text));
      site ??= parsed.site;
      items.push(...parsed.items);
    }
    if (!site) throw new Error("Couldn't recognize this file as a ChatGPT, Claude or Gemini export.");

    const valid = items.filter((x) => Number.isFinite(x.timestamp) && x.timestamp > 0);
    const res = await sendToBackground(valid);
    grandTotal += res.added;

    const notes = [];
    if (res.duplicates) notes.push(`${fmt(res.duplicates)} already imported`);
    if (res.afterInstall) notes.push(`${fmt(res.afterInstall)} skipped because PromptPrint already tracked them`);
    li.replaceChildren(
      span("ok", `✓ ${site}: `),
      `${fmt(valid.length)} prompt${valid.length === 1 ? "" : "s"} found, ${fmt(res.added)} added.`,
      ...(notes.length ? [document.createElement("br"), span("note", notes.join(" · "))] : [])
    );
  } catch (e) {
    li.replaceChildren(span("err", `✗ ${file.name}: `), e.message);
    if (e instanceof ManifestError) {
      const help = document.createElement("div");
      help.className = "help";
      help.append(
        e.links.length
          ? "Download your conversations file below (link expires 24 hours after the export was made), then drop that ZIP here:"
          : "Open the email from Anthropic again and download the file named conversations-000.zip, then drop it here."
      );
      for (const f of e.links) {
        const a = document.createElement("a");
        a.href = f.export_url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = `⬇ ${f.filename ?? "conversations.zip"}`;
        help.append(document.createElement("br"), a);
      }
      li.append(help);
    }
  }
  $("summary").textContent = grandTotal
    ? `${fmt(grandTotal)} past prompts added. Click the PromptPrint leaf icon and choose "All time" to see them.`
    : "";
}

async function handleFiles(files) {
  for (const f of files) await handleFile(f);
}

$("file").addEventListener("change", (e) => {
  handleFiles([...e.target.files]);
  e.target.value = "";
});

const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  handleFiles([...e.dataTransfer.files]);
});

// Exposed for testing in the console.
globalThis.PromptPrintImport = { detectAndParse, openZip };
