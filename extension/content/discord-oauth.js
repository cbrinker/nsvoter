// discord-oauth.js — runs on the Discord OAuth authorize page (discord.com/oauth2/*).
//
// The vote flow lands here when the site uses Discord login. Authorizing is an
// outward-facing, account-level action (DESIGN.md §6) AND Discord's Authorize
// button ignores synthetic/untrusted clicks (§8a) — so this is ALWAYS assisted:
// we highlight the button and the human clicks it (a real, trusted event). The
// background worker detects completion by watching the tab navigate off this page.
//
// Discord usually remembers a prior grant, so on later cycles this page often
// auto-redirects and we never see it.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case "CLASSIFY":
      return classify();
    case "CLICK_AUTHORIZE":
      return promptAuthorize();
    default:
      return { stage: "unknown" };
  }
}

function classify() {
  if (findAuthorizeButton()) return { stage: "discord-authorize" };
  const body = (document.body?.innerText || "").toLowerCase();
  if (/log ?in|enter (a|your) password|verify/i.test(body)) return { stage: "needs-login" };
  return { stage: "unknown" };
}

function findAuthorizeButton() {
  const clickable = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });
  // Prefer an exact "Authorize"; fall back to one that contains it (but not "Cancel").
  const label = (b) => (b.innerText || b.value || "").trim();
  return (
    clickable.find((b) => /^authorize$/i.test(label(b))) ||
    clickable.find((b) => /\bauthorize\b/i.test(label(b)) && !/cancel/i.test(label(b))) ||
    null
  );
}

// Highlight the button and return immediately. We do NOT programmatically click:
// Discord ignores untrusted clicks, and this step is human-gated by design. The
// background worker waits for the resulting navigation as the completion signal.
async function promptAuthorize() {
  const btn = findAuthorizeButton();
  if (!btn) return { awaitingUser: false, error: "Authorize button not found." };
  highlight(btn, "Click Authorize to cast your vote");
  return { awaitingUser: true };
}

function highlight(el, label) {
  el.scrollIntoView({ block: "center" });
  el.style.outline = "3px solid #ff4dd2";
  el.style.outlineOffset = "2px";
  const tip = document.createElement("div");
  tip.textContent = "⬆ Voter: " + label;
  Object.assign(tip.style, {
    position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
    background: "#111", color: "#fff", padding: "10px 16px", borderRadius: "8px",
    font: "14px system-ui, sans-serif", zIndex: 2147483647, boxShadow: "0 2px 12px rgba(0,0,0,.4)",
  });
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 12000);
}
