// content.js: runs inside AI chat websites (see SITES below).
// Notices each message YOU send, waits for the AI's reply to finish, then
// sends one event to background.js. Nothing leaves your computer.

(() => {
  // Note: "Load data" re-adds this script only to tabs where it isn't responding
  // (e.g. after the extension was reloaded), so it doesn't need a run-once guard.

  // Website → AI name used in the data. Keep in sync with lib/constants.js and manifest.json.
  const SITES = {
    "chatgpt.com": "chatgpt",
    "chat.openai.com": "chatgpt",
    "claude.ai": "claude",
    "gemini.google.com": "gemini",
    "www.perplexity.ai": "perplexity",
    "copilot.microsoft.com": "copilot",
    "chat.deepseek.com": "deepseek",
    "grok.com": "grok",
    "chat.mistral.ai": "mistral",
  };
  const SITE = SITES[location.hostname];
  if (!SITE) return;

  // Where some sites put user messages and AI replies, which lets us measure
  // reply length and power "Load data". These sites change their HTML often.
  // If tracking stops working, open DevTools (F12), inspect a message, and
  // update these selectors. Sites not listed here are still tracked: each
  // prompt is counted when you press send, with a typical reply length.
  const SELECTORS = {
    chatgpt: {
      user: '[data-message-author-role="user"]',
      assistant: '[data-message-author-role="assistant"]',
    },
    claude: {
      user: '[data-testid="user-message"]',
      assistant: ".font-claude-response, .font-claude-message, [data-is-streaming]",
    },
    gemini: {
      user: "user-query",
      assistant: "model-response",
    },
  };
  const sel = SELECTORS[SITE] ?? null;

  const SEND_WINDOW_MS = 15000; // a sent message must appear within 15 s of pressing send
  const STABLE_MS = 2500; // reply counts as finished after this long unchanged
  const TIMEOUT_MS = 120000; // give up waiting for a reply after 2 minutes

  const seen = new WeakSet();
  let pending = null; // the prompt we're waiting on a reply for

  // ---------- Noticing when you send a message ----------
  // Only messages YOU send count. Messages that appear because you opened an
  // old conversation aren't preceded by a send, so they're ignored. (Watching
  // for a send works even when a new chat changes the page address.)
  let sendsWaiting = 0;
  let lastSendAt = 0;
  let lastSendText = "";

  // The chat box: a multi-line text area or rich-text editor, not a small
  // search or rename field.
  const isTextBox = (t) =>
    t instanceof Element &&
    (t.matches("textarea") || t.isContentEditable) &&
    (t.closest("textarea, [contenteditable=true]") ?? t).getBoundingClientRect().width > 200;

  function composerNear(el) {
    if (isTextBox(document.activeElement)) return document.activeElement;
    for (let node = el; node; node = node.parentElement) {
      const box = [...node.querySelectorAll("textarea, [contenteditable=true]")].find(isTextBox);
      if (box) return box;
    }
    return null;
  }

  const boxText = (box) => ((box?.value ?? box?.innerText ?? "") || "").trim();

  function noteSend(text) {
    if (!text) return; // nothing typed: not a real send
    // Enter, the send button and the form's submit can all fire for one send.
    if (Date.now() - lastSendAt < 1000 && text === lastSendText) return;
    lastSendAt = Date.now();
    lastSendText = text;
    if (!sel) {
      // A site without known selectors: count it now with a typical reply length.
      send({ site: SITE, promptText: text, responseChars: 0 });
      return;
    }
    sendsWaiting = Math.min(sendsWaiting + 1, 3);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && isTextBox(e.target)) {
      noteSend(boxText(e.target.closest("textarea, [contenteditable=true]") ?? e.target));
    }
  }, true);

  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element && e.target.closest("button, [role=button]");
    if (!btn) return;
    const label = `${btn.getAttribute("aria-label") ?? ""} ${btn.getAttribute("data-testid") ?? ""} ${btn.className}`;
    if (/send|submit/i.test(label)) noteSend(boxText(composerNear(btn)));
  }, true);

  document.addEventListener("submit", (e) => noteSend(boxText(composerNear(e.target))), true);

  // If the site's layout changed and your message never showed up where we
  // look for it, still count the prompt (with a typical reply length).
  function expireSends() {
    if (!sendsWaiting || Date.now() - lastSendAt <= SEND_WINDOW_MS) return;
    sendsWaiting = 0;
    send({ site: SITE, promptText: lastSendText, responseChars: 0 });
  }

  const textOf = (el) => (el?.innerText || el?.textContent || "").trim();

  // A short fingerprint of a message, so the same prompt is never counted
  // twice (by live tracking and by "Load data"). The text itself isn't stored.
  function hashText(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }

  function keyFor(userEl) {
    const hash = hashText(textOf(userEl));
    let occurrence = 0;
    for (const el of document.querySelectorAll(sel.user)) {
      if (el === userEl) break;
      if (hashText(textOf(el)) === hash) occurrence++;
    }
    return `${SITE}:${location.pathname}:${hash}:${occurrence}`;
  }

  function send(event) {
    try {
      chrome.runtime.sendMessage({ type: "ai-event", ...event });
    } catch (e) {
      // Happens after the extension is reloaded; refresh the page to fix.
      console.debug("[PromptPrint] could not send event:", e);
    }
  }

  function finishPending() {
    if (!pending) return;
    send({
      site: SITE,
      promptText: pending.promptText,
      responseChars: Math.max(pending.lastLen, 0),
      // Made when the reply finishes, after a new chat gets its final URL.
      importKey: pending.userEl.isConnected ? keyFor(pending.userEl) : undefined,
    });
    pending = null;
  }

  // "Load data" button: list every prompt visible on this page with its reply
  // length. background.js skips the ones already counted.
  function scanPage() {
    if (!sel) return []; // this site's layout isn't mapped yet
    const items = [];
    let current = null;
    for (const el of document.querySelectorAll(`${sel.user}, ${sel.assistant}`)) {
      if (el.matches(sel.user)) {
        current = null;
        if (pending && el === pending.userEl) continue; // still being answered
        const text = textOf(el);
        if (!text) continue;
        current = { site: SITE, promptText: text, responseChars: 0, timestamp: Date.now(), importKey: keyFor(el), gotReply: false };
        items.push(current);
      } else if (current && !current.gotReply) {
        current.responseChars = textOf(el).length; // first reply after the prompt
        current.gotReply = true;
      }
    }
    return items.map(({ gotReply, ...item }) => item);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "scan-page") sendResponse({ items: scanPage() });
    else if (msg?.type === "ping") sendResponse({ ok: true });
  });

  function scanForNewPrompts() {
    if (!sel) return;
    expireSends();

    for (const el of document.querySelectorAll(sel.user)) {
      if (seen.has(el)) continue;
      const text = textOf(el);
      if (!text) continue; // not rendered yet; check again next scan
      seen.add(el);

      // Same prompt re-drawn by the site (e.g. when a new chat gets its
      // address): follow the new copy instead of counting it again.
      if (pending && !pending.userEl.isConnected && text === pending.promptText) {
        pending.userEl = el;
        continue;
      }
      if (!sendsWaiting) continue; // loaded with an old conversation
      sendsWaiting--;

      finishPending(); // previous prompt is done if a new one was sent
      pending = {
        promptText: text,
        userEl: el,
        startedAt: Date.now(),
        lastLen: -1,
        stableSince: Date.now(),
      };
    }
  }

  function checkReply() {
    if (!pending || !sel) return;
    if (!pending.userEl.isConnected) {
      // The site re-drew the chat; find our prompt again by its text.
      const again = [...document.querySelectorAll(sel.user)].reverse().find((u) => textOf(u) === pending.promptText);
      if (again) {
        seen.add(again);
        pending.userEl = again;
      }
    }
    const replies = document.querySelectorAll(sel.assistant);
    const lastReply = replies[replies.length - 1];
    const now = Date.now();

    // Only a reply that appears AFTER our prompt on the page belongs to it.
    const isAfterPrompt =
      lastReply &&
      pending.userEl.compareDocumentPosition(lastReply) & Node.DOCUMENT_POSITION_FOLLOWING;

    if (isAfterPrompt) {
      const len = textOf(lastReply).length;
      if (len !== pending.lastLen) {
        pending.lastLen = len;
        pending.stableSince = now;
      } else if (len > 0 && now - pending.stableSince >= STABLE_MS) {
        finishPending();
        return;
      }
    }
    if (pending && now - pending.startedAt > TIMEOUT_MS) finishPending();
  }

  let scanTimer = null;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForNewPrompts, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    scanForNewPrompts();
    checkReply();
  }, 1000);

  // Don't lose a prompt if the tab is closed mid-reply.
  window.addEventListener("pagehide", finishPending);

  console.debug(`[PromptPrint] tracking ${SITE}`);
})();
