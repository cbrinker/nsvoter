// ark-servers.js — adapter for ark-servers.net vote pages.
//
// Verified against the live page (server/<id>/vote/). The real structure:
//   - Two <form> elements, both POST to /auth/, each with an <input type="image">
//     submit. They differ ONLY by the image src: steam-vote.png vs discord-vote.png.
//   - A required privacy checkbox #sharedAccept that must be ticked before submit.
//   - There is NO separate "green vote button" and NO separate method-choice page;
//     the vote page *is* the method choice. Submitting the chosen form redirects
//     to /auth/ -> the provider's login (Discord OAuth / Steam) -> back to a
//     confirmation page.
//
// TODO(live): the confirmation-page wording is still a heuristic (isConfirmed) —
// tighten it once we've seen a real post-vote page.

const B = globalThis.VoterBase;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true; // async
});

// --- element locators (verified selectors) ---------------------------------

function methodForm(method) {
  const src = method === "steam" ? "steam-vote" : "discord-vote";
  return (
    [...document.querySelectorAll("form")].find((f) => {
      const img = f.querySelector('input[type="image"]');
      return img && (img.src || "").includes(src);
    }) || null
  );
}

function submitImage(method) {
  return methodForm(method)?.querySelector('input[type="image"]') || null;
}

function acceptCheckbox() {
  return document.querySelector('#sharedAccept, input[type="checkbox"][name="sharedAccept"]');
}

// The server's display name, from the 'Vote For "<name>"' heading (falls back to
// the page title). Used for the readable "Discovered servers" picker.
function serverName() {
  const h = [...document.querySelectorAll("h1, h2")].map((e) => e.textContent.trim());
  const quoted = h.map((t) => t.match(/vote for\s+"([^"]+)"/i)?.[1]).find(Boolean);
  if (quoted) return quoted;
  const title = (document.title || "").match(/vote for\s+(.+)$/i)?.[1];
  return title ? title.trim() : null;
}

function adBlockerBlocking() {
  const el = [...document.querySelectorAll(".alert, [role=alert]")].find((a) =>
    /ad\s*blocker/i.test(a.textContent)
  );
  return !!el && el.offsetParent !== null; // only if actually visible
}

// Strong post-vote / cooldown phrases. A match here is what flips a site to
// "voted". Kept deliberately specific so the pre-vote form never matches — note
// that form literally contains "You can vote using either Steam or Discord", so
// anything matching "you can vote" is off-limits.
// TODO(live): extend with the exact ark-servers wording once captured on a real
// post-authorize page (the vote page itself does NOT show cooldown state).
// Confirmed via the observed live wording: a successful vote OR the daily-limit
// / cooldown page (both mean "your vote is registered, can't vote now").
const CONFIRM_RE =
  /thanks?\s+for\s+voting|already voted|reached your (daily )?vote limit|daily vote limit|vote again in|come back in|your vote (has been )?(recorded|counted)|voted successfully|successfully voted|been counted/i;

// Return the actual line that signals confirmation (so it's stored as a
// meaningful confirmText), or null if the page isn't a confirmation/cooldown page.
function confirmationLine() {
  const lines = (document.body?.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => CONFIRM_RE.test(l)) || null;
}

function isConfirmed() {
  return !!confirmationLine();
}

// ark tells us the real revote window, e.g. "vote again in approximately 2 hours".
// Parse it so the ledger uses the true cooldown instead of a hardcoded guess.
function parseCooldownMs() {
  // Parse ONLY within the single line that has the countdown, so a stray
  // "…N hours…" elsewhere on the page can't be grabbed (that caused a 22h lock).
  const lines = (document.body?.innerText || "").split("\n");
  for (const line of lines) {
    if (!/vote again in/i.test(line)) continue;
    const h = line.match(/(\d+)\s*hour/i);
    const m = line.match(/(\d+)\s*min/i);
    if (!h && !m) continue;
    let ms = 0;
    if (h) ms += parseInt(h[1], 10) * 3600e3;
    if (m) ms += parseInt(m[1], 10) * 60e3;
    return ms || null;
  }
  return null;
}

// --- message handlers ------------------------------------------------------

async function handle(msg) {
  switch (msg.cmd) {
    case "CLASSIFY":
      return classify(msg.method || "discord");

    case "FIND_VOTE_BUTTON": {
      const btn = submitImage(msg.method || "discord");
      if (!btn) return { found: false, error: `no ${msg.method} vote form on page`, name: serverName() };
      return { found: true, ref: "submit", text: `${msg.method} vote submit`, name: serverName() };
    }

    case "HIGHLIGHT": {
      const btn = submitImage(msg.method || "discord");
      const cb = acceptCheckbox();
      if (cb && !cb.checked) B.highlight(cb, "Would tick this privacy checkbox first");
      B.highlight(btn, `Would click the ${msg.method} submit to vote (preview only).`);
      return { ok: true };
    }

    case "SHOW_PROGRESS":
      B.banner(msg.text || "Voting…");
      return { ok: true };

    case "CLICK_VOTE":
      return clickVote(msg.method || "discord", msg.clickMode);

    default:
      return { error: `ark adapter: unknown cmd ${msg.cmd}` };
  }
}

function classify(method) {
  if (adBlockerBlocking()) return { stage: "ad-blocker" };
  const confirmLine = confirmationLine();
  if (confirmLine) {
    return { stage: "confirmed", confirmText: confirmLine, cooldownMs: parseCooldownMs() };
  }
  if (submitImage(method) || submitImage("steam") || submitImage("discord")) {
    return { stage: "vote-form" };
  }
  return { stage: "unknown" };
}

// Tick the required checkbox, then submit the chosen method's form. Responds
// promptly (the submit navigates the tab away, which would otherwise drop the
// message channel); the background worker then just waits for the navigation.
async function clickVote(method, clickMode) {
  if (adBlockerBlocking()) return { clicked: false, error: "Ad-blocker warning is active on the page." };

  const cb = acceptCheckbox();
  if (cb && !cb.checked) cb.click(); // fires change handlers that sync the hidden 'accept' field

  const btn = submitImage(method);
  if (!btn) return { clicked: false, error: `no ${method} vote form on page` };

  if (clickMode === "assisted") {
    // Highlight and let the human click (a real, trusted event, §8a). We return
    // now; navigation happens when they click.
    B.highlight(btn, `Click the ${method} button to cast your vote`);
    return { clicked: true, mode: "assisted", awaitingUser: true };
  }

  // Auto: schedule the submit just after we return, so this response is delivered
  // before the page navigates.
  setTimeout(() => btn.click(), 50);
  return { clicked: true, mode: "auto" };
}
