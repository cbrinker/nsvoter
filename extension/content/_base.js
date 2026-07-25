// _base.js — shared, site-agnostic heuristics for vote-site adapters.
//
// Injected alongside each site adapter (see manifest content_scripts). Adapters
// read from globalThis.VoterBase. Keep everything here layered and forgiving:
// text + role + colour heuristics, never one brittle CSS path (DESIGN.md §8).
//
// NOTE(live): the exact markup of ark-servers.net's vote/confirm pages has not
// been verified against a live page yet. These heuristics are a first attempt to
// validate with `Preview` and the §8a probe, then tighten.

(function () {
  const GREEN_HINTS = ["rgb(40, 167, 69)", "rgb(76, 175, 80)", "green"];

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  function looksGreen(el) {
    const s = getComputedStyle(el);
    const bg = s.backgroundColor || "";
    return GREEN_HINTS.some((h) => bg.includes(h)) || /vote/i.test(el.className);
  }

  function text(el) {
    return (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  }

  // Rank clickable candidates by how "vote-button-like" they are.
  function findVoteButton() {
    const candidates = [
      ...document.querySelectorAll(
        'a, button, input[type="submit"], input[type="button"], [role="button"]'
      ),
    ].filter(visible);

    const scored = candidates
      .map((el) => {
        let score = 0;
        const t = text(el).toLowerCase();
        if (/\bvote\b/.test(t)) score += 5;
        if (looksGreen(el)) score += 3;
        if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") score += 1;
        if (/captcha|login|sign\s*in/i.test(t)) score -= 5;
        return { el, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.el || null;
  }

  // Rough page classifier used by the navigation-driven vote loop (background.js).
  function classify() {
    const body = (document.body?.innerText || "").toLowerCase();

    if (document.querySelector('iframe[src*="captcha"], .g-recaptcha, [class*="captcha"]')) {
      return { stage: "captcha" };
    }
    // Confirmation: revote-window wording is the reliable tell (DESIGN.md §1).
    if (/vote again|already voted|thanks?\s+for\s+voting|4\s*hours/i.test(body)) {
      return { stage: "confirmed", confirmText: firstMatchingLine(body, /vote again|voting|hours/i) };
    }
    // Method choice: both Steam and Discord options present.
    if (/steam/.test(body) && /discord/.test(body)) {
      return { stage: "method-choice" };
    }
    if (findVoteButton()) return { stage: "vote-button" };
    return { stage: "unknown" };
  }

  function firstMatchingLine(body, re) {
    return body.split("\n").map((l) => l.trim()).find((l) => l && re.test(l)) || null;
  }

  // Find the button for a chosen credential method on the method-choice page.
  function findMethodButton(method) {
    const re = method === "steam" ? /steam/i : /discord/i;
    const els = [...document.querySelectorAll('a, button, [role="button"]')].filter(visible);
    return els.find((el) => re.test(text(el))) || null;
  }

  // Click honestly, then let the caller verify via the postcondition. Returns
  // whether a programmatic (untrusted) click was dispatched. If the site ignores
  // untrusted clicks, the caller falls back to assisted-click (DESIGN.md §8a).
  function programmaticClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }

  // Assisted click: highlight the target and ask the human to click it — a real,
  // trusted event, zero spoofing. Resolves when the element is activated.
  function assistedClick(el, label = "Click the highlighted button to continue") {
    return new Promise((resolve) => {
      highlight(el, label);
      const done = () => {
        el.removeEventListener("click", done, true);
        resolve(true);
      };
      el.addEventListener("click", done, true);
    });
  }

  function highlight(el, label) {
    if (!el) return;
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
    setTimeout(() => tip.remove(), 8000);
  }

  // A plain status banner (no element outline) for run progress messages.
  function banner(msg, ms = 8000) {
    document.getElementById("__voter_banner")?.remove();
    const el = document.createElement("div");
    el.id = "__voter_banner";
    el.textContent = "Voter: " + msg;
    Object.assign(el.style, {
      position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)",
      background: "#ff4dd2", color: "#111", padding: "10px 16px", borderRadius: "8px",
      font: "600 14px system-ui, sans-serif", zIndex: 2147483647, boxShadow: "0 2px 12px rgba(0,0,0,.4)",
    });
    document.body.appendChild(el);
    if (ms) setTimeout(() => el.remove(), ms);
  }

  globalThis.VoterBase = {
    visible, findVoteButton, classify, findMethodButton,
    programmaticClick, assistedClick, highlight, banner, text,
  };
})();
