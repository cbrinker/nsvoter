// popup.js — the extension's control surface. Loads config into the form, saves
// edits, kicks off Preview / Vote runs via the background worker, and renders the
// run report and per-site cooldown status.

const $ = (id) => document.getElementById(id);

// serverId -> display name, so we can label sites by name (URL goes in a tooltip).
let namesMap = {};
async function loadNames() {
  const res = await send({ cmd: "GET_NAMES" }).catch(() => null);
  if (res?.ok) namesMap = res.data || {};
}
function nameFor(url) {
  return namesMap[siteIdFromUrl(url)] || shortUrl(url);
}

// ---- config <-> form -------------------------------------------------------

async function loadConfig() {
  const cfg = await readConfig();
  $("linksChannelUrl").value = cfg.discord.linksChannelUrl;
  $("claimChannelUrl").value = cfg.discord.claimChannelUrl;
  $("claimCommand").value = cfg.discord.claimCommand;
  $("method").value = cfg.vote.method;
  $("clickMode").value = cfg.vote.clickMode;
  $("prefer").value = cfg.selection.prefer.join(", ");
  $("avoid").value = cfg.selection.avoid.join(", ");
  $("count").value = cfg.selection.count;
  $("notifyWindow").checked = cfg.notify.windowOpen;
  $("notifyFailure").checked = cfg.notify.onFailure;
  $("method-badge").textContent = cfg.vote.method;
}

async function readConfig() {
  const mod = await import("../storage.js");
  return mod.getConfig();
}

async function saveConfig() {
  const mod = await import("../storage.js");
  await mod.setConfig({
    discord: {
      linksChannelUrl: $("linksChannelUrl").value.trim(),
      claimChannelUrl: $("claimChannelUrl").value.trim(),
      claimCommand: $("claimCommand").value.trim() || "/claim",
    },
    vote: {
      method: $("method").value,
      clickMode: $("clickMode").value,
    },
    selection: {
      prefer: splitList($("prefer").value),
      avoid: splitList($("avoid").value),
      count: clampInt($("count").value, 1, 10),
    },
    notify: {
      windowOpen: $("notifyWindow").checked,
      onFailure: $("notifyFailure").checked,
    },
  });
  $("method-badge").textContent = $("method").value;
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 1500);
  await refreshStatus();
}

function splitList(s) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function clampInt(v, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? lo : Math.min(hi, Math.max(lo, n));
}

// ---- runs ------------------------------------------------------------------

async function run(cmd, extra = {}) {
  setBusy(true);
  $("report").innerHTML = `<div class="muted">Running…</div>`;
  try {
    const res = await send({ cmd, ...extra });
    if (!res.ok) throw new Error(res.error);
    renderReport(res.data);
  } catch (e) {
    $("report").innerHTML = `<div class="step-line step-err">${escapeHtml(String(e.message || e))}</div>`;
  } finally {
    setBusy(false);
    await refreshStatus();
  }
}

// Extract the vote site's numeric id from a URL, e.g. .../server/369390/vote/ -> "369390".
function siteIdFromUrl(u) {
  const m = String(u).match(/server\/(\d+)/i);
  return m ? m[1] : u;
}

function renderReport(runData) {
  const box = $("report");
  if (!runData) return (box.innerHTML = "");

  const sites = runData.sites || [];
  const voted = sites.filter((s) => s.stage === "confirmed").length;
  const failed = sites.filter((s) => s.stage === "error").length;
  const preview = sites.filter((s) => s.stage === "preview").length;
  const running = runData.current && !runData.finishedAt;

  const parts = [];

  // Headline — one friendly line summarizing the run.
  if (running) {
    parts.push(`<div class="run-headline running">${escapeHtml(runData.current.label)}: <b>${escapeHtml(runData.current.site)}</b></div>`);
  } else if (runData.fatal) {
    parts.push(`<div class="run-headline err">Couldn't complete the run</div>`);
  } else if (runData.mode === "preview") {
    parts.push(`<div class="run-headline">Preview — ${preview} ready to vote</div>`);
  } else if (voted > 0) {
    parts.push(`<div class="run-headline ok">✓ Voted ${voted} server${voted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}</div>`);
  } else if (runData.note) {
    parts.push(`<div class="run-headline">${escapeHtml(runData.note)}</div>`);
  } else if (failed) {
    parts.push(`<div class="run-headline err">Vote didn't go through</div>`);
  }

  // Server rows — name + status pill (URL in tooltip), with a re-vote button.
  parts.push(
    ...sites.map((s) => {
      const one = s.stage === "confirmed"
        ? ""
        : `<button class="btn secondary vote-one" data-site="${escapeHtml(siteIdFromUrl(s.url))}">Vote</button>`;
      return `<div class="site-row"><span title="${escapeHtml(s.url)}">${escapeHtml(nameFor(s.url))}</span>${pill(s)}${one}</div>`;
    })
  );

  // Call to action: finish by claiming.
  if (!running && runData.claim?.prompted) {
    parts.push(`<div class="run-cta">→ Send <b>/claim</b> in Discord to finish</div>`);
  }

  // Errors, shown plainly by server name.
  for (const s of sites) {
    if (s.stage === "error" && s.error) {
      parts.push(`<div class="run-error">${escapeHtml(nameFor(s.url))}: ${escapeHtml(s.error)}</div>`);
    }
  }
  if (runData.fatal) parts.push(`<div class="run-error">${escapeHtml(runData.fatal)}</div>`);

  box.innerHTML = parts.join("");
}

function pill(site) {
  if (site.stage === "confirmed") return `<span class="pill ok">voted</span>`;
  if (site.stage === "preview") return `<span class="pill wait">would vote</span>`;
  if (site.stage === "error") return `<span class="pill err" title="${escapeHtml(site.error || "")}">failed</span>`;
  return `<span class="pill wait">${escapeHtml(site.stage || "?")}</span>`;
}

// ---- status ----------------------------------------------------------------

async function refreshStatus() {
  const res = await send({ cmd: "GET_STATE" }).catch(() => null);
  if (!res?.ok) return ($("status").innerHTML = `<div class="muted">No status yet.</div>`);
  const { status } = res.data;
  if (!status?.entries?.length) {
    $("status").innerHTML = `<div class="muted">No votes recorded yet. Run Preview to test.</div>`;
    return;
  }
  $("status").innerHTML = status.entries
    .map((e) => {
      const when = e.eligible ? "ready" : `in ${humanizeUntil(e.nextEligibleAt)}`;
      const cls = e.eligible ? "ok" : "wait";
      const label = e.name || e.siteKey;
      return `<div class="site-row"><span title="${escapeHtml(e.siteKey)}">${escapeHtml(label)}</span><span class="pill ${cls}">${when}</span></div>`;
    })
    .join("");
}

function humanizeUntil(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600e3);
  const m = Math.round((ms % 3600e3) / 60e3);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// ---- preferred servers picker ---------------------------------------------

async function loadDiscovered() {
  const res = await send({ cmd: "GET_DISCOVERED" }).catch(() => null);
  renderDiscovered(res?.ok ? res.data : null);
}

function renderDiscovered(data) {
  const box = $("discovered");
  if (!data || !data.items?.length) {
    box.innerHTML = `<div class="muted">No servers discovered yet — run Preview or Rescan.</div>`;
    return;
  }
  box.innerHTML = data.items
    .map((it) => {
      const label = it.name || (it.id ? `#${it.id}` : shortUrl(it.url));
      if (it.removed) {
        return `<label class="row muted"><input type="checkbox" disabled/> <s>${escapeHtml(label)}</s> (removed)</label>`;
      }
      return `<label class="row"><input type="checkbox" class="pin" data-id="${escapeHtml(it.id || "")}" ${it.pinned ? "checked" : ""} ${it.id ? "" : "disabled"}/> ${escapeHtml(label)}</label>`;
    })
    .join("");
}

async function togglePin(id, pinned) {
  const mod = await import("../storage.js");
  const cfg = await mod.getConfig();
  const set = new Set((cfg.selection.preferIds || []).map(String));
  if (pinned) set.add(String(id));
  else set.delete(String(id));
  await mod.setConfig({ selection: { preferIds: [...set] } });
}

async function rescan() {
  $("discovered").innerHTML = `<div class="muted">Rescanning…</div>`;
  const res = await send({ cmd: "RESCAN" }).catch(() => null);
  renderDiscovered(res?.ok ? res.data : null);
}

// ---- update checker --------------------------------------------------------

function showVersion() {
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
}

async function loadUpdate() {
  const { update } = await chrome.storage.local.get("update");
  renderUpdate(update);
}

function renderUpdate(update) {
  const el = $("update-banner");
  if (update?.available && update.url) {
    el.hidden = false;
    el.href = update.url;
    el.innerHTML = `<b>Update available: v${escapeHtml(update.latest)}</b> — you have v${escapeHtml(update.current)}. Click to download.`;
  } else {
    el.hidden = true;
  }
}

async function checkUpdate() {
  $("checkUpdate").textContent = "Checking…";
  const res = await send({ cmd: "CHECK_UPDATE" }).catch(() => null);
  const u = res?.ok ? res.data : null;
  renderUpdate(u);
  $("checkUpdate").textContent =
    u && !u.configured ? "Updates not configured" :
    u?.available ? "Update available" :
    u?.error ? "Check failed — retry" : "Up to date";
  setTimeout(() => ($("checkUpdate").textContent = "Check for updates"), 4000);
}

// ---- helpers ---------------------------------------------------------------

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}
function setBusy(b) {
  ["preview", "vote", "save"].forEach((id) => ($(id).disabled = b));
  // Also disable the dynamic per-site buttons so a second run can't be launched.
  document.querySelectorAll(".vote-one").forEach((btn) => (btn.disabled = b));
}
function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname + url.pathname.replace(/\/vote\/?$/, "");
  } catch {
    return u;
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- wire up ---------------------------------------------------------------

$("preview").addEventListener("click", () => run("RUN_PREVIEW"));
$("vote").addEventListener("click", () => run("RUN_VOTE"));
$("save").addEventListener("click", saveConfig);

// Per-site "Vote this one" (staggered validation, DESIGN.md §5.3) via delegation.
$("report").addEventListener("click", (e) => {
  const btn = e.target.closest(".vote-one");
  if (btn) run("RUN_VOTE_ONE", { site: btn.dataset.site });
});

// Test notification + preferred-servers picker + update check.
$("testNotify").addEventListener("click", () => send({ cmd: "TEST_NOTIFY" }));
$("rescan").addEventListener("click", rescan);
$("checkUpdate").addEventListener("click", checkUpdate);
$("resetCooldowns").addEventListener("click", async () => {
  await send({ cmd: "CLEAR_COOLDOWNS" }).catch(() => null);
  refreshStatus();
});
$("discovered").addEventListener("change", (e) => {
  const cb = e.target.closest(".pin");
  if (cb && cb.dataset.id) togglePin(cb.dataset.id, cb.checked);
});

// Re-render the last run when the popup reopens, so the per-site buttons persist.
async function restoreLastRun() {
  const res = await send({ cmd: "GET_STATE" }).catch(() => null);
  if (res?.ok && res.data?.run) {
    renderReport(res.data.run);
    if (res.data.run.current && !res.data.run.finishedAt) setBusy(true);
  }
}

// Live updates: the background worker persists run state after each step, so a
// popup that happens to stay open (e.g. during the Authorize wait) refreshes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.run) {
    const run = changes.run.newValue;
    if (run) {
      renderReport(run);
      if (run.finishedAt) setBusy(false);
    }
  }
  // Refresh the picker when harvest results or learned names change.
  if (changes.run || changes.names) loadDiscovered();
  if (changes.names) {
    // Reload the name map, then re-label the report + status.
    loadNames().then(() => {
      restoreLastRun();
      refreshStatus();
    });
  }
  if (changes.update) renderUpdate(changes.update.newValue);
});

async function init() {
  showVersion();
  await loadNames(); // labels depend on this, so load it before rendering
  loadConfig();
  refreshStatus();
  restoreLastRun();
  loadDiscovered();
  loadUpdate();
}
init();
