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

  const GRACE_MS = 3000; // ignore messages that load with an old conversation
  const STABLE_MS = 2500; // reply counts as finished after this long unchanged
  const TIMEOUT_MS = 120000; // give up waiting for a reply after 2 minutes

  const seen = new WeakSet();
  let ignoreUntil = Date.now() + GRACE_MS;
  let lastUrl = location.href;
  let pending = null; // the prompt we're waiting on a reply for

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
    // Switching conversations in these single-page apps loads old messages;
    // don't count those.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ignoreUntil = Date.now() + GRACE_MS;
    }

    for (const el of document.querySelectorAll(sel.user)) {
      if (seen.has(el)) continue;
      if (Date.now() < ignoreUntil) {
        seen.add(el);
        continue;
      }
      const text = textOf(el);
      if (!text) continue; // not rendered yet; check again next scan
      seen.add(el);

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
