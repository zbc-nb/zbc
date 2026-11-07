// content.js — runs inside ChatGPT, Claude and Gemini pages.
// Watches the page for new messages YOU send, waits for the AI's reply to
// finish, then sends one event to background.js. Nothing leaves your computer.

(() => {
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
    });
    pending = null;
  }

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
