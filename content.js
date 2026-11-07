// content.js — runs inside ChatGPT, Claude and Gemini pages.
// Watches the page for new messages YOU send, waits for the AI's reply to
// finish, then sends one event to background.js. Nothing leaves your computer.

(() => {
  // Note: "Load data" re-adds this script only to tabs where it isn't responding
  // (e.g. after the extension was reloaded), so it doesn't need a run-once guard.
  const host = location.hostname;
  const SITE = host.includes("claude.ai")
    ? "claude"
    : host.includes("gemini.google.com")
    ? "gemini"
    : "chatgpt";

  // Where each site puts user messages and AI replies.
  // These sites change their HTML often — if tracking stops working,
  // open DevTools (F12), inspect a message, and update these selectors.
  const SELECTORS = {
    chatgpt: {
      user: '[data-message-author-role="user"]',
      assistant: '[data-message-author-role="assistant"]',
    },
    claude: {
      user: '[data-testid="user-message"]',
      assistant: ".font-claude-response, [data-is-streaming]",
    },
    gemini: {
      user: "user-query",
      assistant: "model-response",
    },
  };
  const sel = SELECTORS[SITE];

  const SEND_WINDOW_MS = 15000; // a sent message must appear within 15 s of pressing send
  const STABLE_MS = 2500; // reply counts as finished after this long unchanged
  const TIMEOUT_MS = 120000; // give up waiting for a reply after 2 minutes

  const seen = new WeakSet();
  let pending = null; // the prompt we're waiting on a reply for

  // Only messages YOU send count. Messages that appear because you opened an
  // old conversation aren't preceded by a send, so they're ignored. (Watching
  // for a send works even when a new chat changes the page address.)
  let sendsWaiting = 0;
  let lastSendAt = 0;
  function noteSend() {
    sendsWaiting = Math.min(sendsWaiting + 1, 3);
    lastSendAt = Date.now();
  }

  const isTextBox = (t) =>
    t instanceof Element && (t.matches("textarea, input[type=text]") || t.isContentEditable);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && isTextBox(e.target)) noteSend();
  }, true);

  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element && e.target.closest("button, [role=button]");
    if (!btn) return;
    const label = `${btn.getAttribute("aria-label") ?? ""} ${btn.getAttribute("data-testid") ?? ""} ${btn.className}`;
    if (/send|submit/i.test(label)) noteSend();
  }, true);

  document.addEventListener("submit", noteSend, true);

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
  });

  function scanForNewPrompts() {
    if (sendsWaiting && Date.now() - lastSendAt > SEND_WINDOW_MS) sendsWaiting = 0;

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
    if (!pending) return;
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
