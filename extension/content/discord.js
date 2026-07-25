// discord.js — runs on the Discord web app channel view (discord.com/channels/*).
//
// Two jobs:
//   HARVEST_LINKS — read the current channel's messages and pull vote URLs.
//   CLAIM         — help the user send /claim (prompt mode by default).
//
// Everything here reads the user's OWN logged-in Discord. It never types on the
// user's behalf in the default 'prompt' mode (self-bot ToS caution, DESIGN.md §2).

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case "HARVEST_LINKS":
      return { links: harvestLinks(msg.patterns || []) };
    case "CLAIM":
      return claim(msg);
    default:
      return { error: `discord adapter: unknown cmd ${msg.cmd}` };
  }
}

// Scrape vote links from the visible message list. Grabs both real anchors and
// bare URLs in message text, then keeps only those matching the vote patterns.
function harvestLinks(patternSources) {
  const patterns = patternSources.map((s) => new RegExp(s, "i"));
  const urls = new Set();

  // Anchors Discord has linkified.
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (patterns.some((p) => p.test(href))) urls.add(cleanUrl(href));
  }
  // Bare URLs in message text (in case some aren't linkified).
  const text = document.body?.innerText || "";
  for (const m of text.matchAll(/https?:\/\/[^\s)]+/gi)) {
    const u = m[0];
    if (patterns.some((p) => p.test(u))) urls.add(cleanUrl(u));
  }
  return [...urls];
}

function cleanUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString().replace(/\/$/, "/"); // keep trailing slash as-is
  } catch {
    return u;
  }
}

// Default 'prompt' mode: focus the message box and tell the user to type /claim.
// We deliberately do NOT auto-send. 'dom-inject' is a last-resort path (§2c) and
// left unimplemented on purpose until you decide it's worth the ToS risk.
async function claim(msg) {
  if (msg.mode === "dom-inject") {
    return { acked: false, message: "dom-inject claim mode is intentionally not implemented (see DESIGN.md §2)." };
  }
  const box = findMessageBox();
  if (box) {
    box.scrollIntoView({ block: "center" });
    box.focus?.();
    banner(`Type ${msg.command} here and press Enter to claim.`);
    return { acked: false, prompted: true, message: `Prompted user to send ${msg.command}.` };
  }
  banner(`Open the claim channel and send ${msg.command}.`);
  return { acked: false, prompted: true, message: "Message box not found; showed a banner." };
}

function findMessageBox() {
  return (
    document.querySelector('div[role="textbox"][contenteditable="true"]') ||
    document.querySelector('[data-slate-editor="true"]') ||
    null
  );
}

function banner(text) {
  const el = document.createElement("div");
  el.textContent = "Voter: " + text;
  Object.assign(el.style, {
    position: "fixed", bottom: "20px", left: "50%", transform: "translateX(-50%)",
    background: "#5865F2", color: "#fff", padding: "10px 16px", borderRadius: "8px",
    font: "14px system-ui, sans-serif", zIndex: 2147483647, boxShadow: "0 2px 12px rgba(0,0,0,.4)",
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 10000);
}
