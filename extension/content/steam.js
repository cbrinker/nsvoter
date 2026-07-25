// steam.js — runs on Steam's sign-in / OpenID pages during a Steam-method vote
// (steamcommunity.com/openid/*, /login/*).
//
// We never type a password (prohibited). So this is fully assisted: focus the
// page, highlight the "Sign in" button if there is one, and let the user complete
// Steam sign-in / authorization. The background worker detects completion when the
// tab navigates back off Steam to ark-servers.
//
// NOTE(live): verified against Steam's login button; the OpenID *confirm* page
// (when already logged in) may differ slightly — tighten after a real Steam vote.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case "CLASSIFY":
      return { stage: "steam-signin" }; // any Steam page here means the user must act
    case "CLICK_SIGNIN":
      return promptSignin();
    default:
      return { stage: "unknown" };
  }
}

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

function findSignInButton() {
  return (
    [...document.querySelectorAll('button, input[type="submit"], input[type="image"]')]
      .filter(visible)
      .find((el) => /sign\s?in/i.test(el.value || el.innerText || el.alt || "")) || null
  );
}

function promptSignin() {
  const btn = findSignInButton();
  if (btn) highlight(btn, "Sign in to Steam to cast your vote");
  else banner("Complete Steam sign-in to continue voting");
  return { awaitingUser: true };
}

function highlight(el, label) {
  el.scrollIntoView({ block: "center" });
  el.style.outline = "3px solid #ff4dd2";
  el.style.outlineOffset = "2px";
  banner(label);
}

function banner(text) {
  const el = document.createElement("div");
  el.textContent = "⬆ Voter: " + text;
  Object.assign(el.style, {
    position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
    background: "#111", color: "#fff", padding: "10px 16px", borderRadius: "8px",
    font: "14px system-ui, sans-serif", zIndex: 2147483647, boxShadow: "0 2px 12px rgba(0,0,0,.4)",
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}
