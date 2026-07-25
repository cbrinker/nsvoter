// background.js — MV3 service worker. Orchestrates the run state machine
// (DESIGN.md §4) across tabs, owns notifications/alarms, and answers the popup.
//
// It never touches the DOM itself: every page interaction is delegated to a
// content-script adapter (content/*.js). Those adapters classify the page and
// perform actions; this worker decides *what* to do and *when*.

import {
  getConfig,
  getLedger,
  recordVote,
  isEligible,
  nextEligibleAt,
  getRun,
  setRun,
  getNames,
  setName,
  getRemoved,
  setRemoved,
  siteKeyFromUrl,
  serverIdFromUrl,
} from "./storage.js";
import { scheduleUpdateChecks, UPDATE_ALARM, checkForUpdate } from "./update.js";

const ALARM_WINDOW = "voter:window-open";

// Regexes for what counts as a vote link when scraping Discord. Extend as new
// vote sites appear in the channel.
const VOTE_LINK_PATTERNS = [/ark-servers\.net\/server\/\d+\/vote/i];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleWindowAlarm();
  scheduleUpdateChecks();
  await runUpdateCheck();
});
chrome.runtime.onStartup.addListener(async () => {
  await scheduleWindowAlarm();
  scheduleUpdateChecks();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_WINDOW) await onWindowAlarm();
  if (alarm.name === UPDATE_ALARM) await runUpdateCheck();
});

// Check GitHub Releases; notify once if a newer version is out (§ distribution).
async function runUpdateCheck() {
  const r = await checkForUpdate();
  if (r.available) {
    notify(
      "voter:update",
      "NerdServers Voter — update available",
      `v${r.latest} is out — you have v${r.current}. Click to download.`
    );
  }
  return r;
}

// ---------------------------------------------------------------------------
// Popup message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.cmd) return;
  const handlers = {
    RUN_PREVIEW: () => runFlow({ mode: "preview" }),
    RUN_VOTE: () => runFlow({ mode: "vote" }),
    RUN_VOTE_ONE: () => runFlow({ mode: "vote", onlySite: msg.site }),
    GET_STATE: async () => ({ run: await getRun(), status: await statusSummary() }),
    GET_NAMES: () => getNames(),
    GET_DISCOVERED: () => discoveredSummary(),
    RESCAN: () => rescan(),
    CHECK_UPDATE: () => runUpdateCheck(),
    CLEAR_COOLDOWNS: async () => {
      await chrome.storage.local.remove("ledger");
      await scheduleWindowAlarm();
      return { ok: true };
    },
    TEST_NOTIFY: async () => {
      notify("voter:test", "NerdServers Voter", "Notifications are working. 🎉");
      return { ok: true };
    },
  };
  const handler = handlers[msg.cmd];
  if (!handler) return;
  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the message channel open for the async response
});

// ---------------------------------------------------------------------------
// The run (state machine, DESIGN.md §4)
// ---------------------------------------------------------------------------

let runInProgress = false;

async function runFlow({ mode, onlySite }) {
  // Only one run at a time. Clicking several "Vote this one" buttons (or Vote
  // while a run is going) must not spawn racing runs that open tabs on top of
  // each other.
  if (runInProgress) {
    const note = "A run is already in progress — wait for it to finish.";
    return { ...freshRun(mode), note, finishedAt: Date.now() };
  }
  runInProgress = true;

  const config = await getConfig();
  const run = freshRun(mode);
  await setRun(run);

  try {
    // Step 1: harvest -----------------------------------------------------
    logStep(run, "harvest", "running");
    const links = await harvestLinks(config);
    if (links.length < 1) throw new Error("No vote links found in the channel.");
    run.harvested = links;
    logStep(run, "harvest", "ok", `${links.length} links`);
    await setRun(run);

    // Step 2: select ------------------------------------------------------
    logStep(run, "select", "running");
    const removed = await getRemoved();
    let selected = selectLinks(links, config, removed);
    if (onlySite) selected = selected.filter((u) => u.includes(onlySite));
    const eligible = await filterEligible(selected, config);
    run.selected = eligible.map((u) => ({ url: u, siteKey: siteKeyFromUrl(u) }));
    logStep(run, "select", "ok", `${eligible.length} eligible / ${selected.length} chosen`);
    await setRun(run);

    if (eligible.length === 0) {
      run.note = "Nothing eligible — all selected sites are still in cooldown.";
      await finishRun(run, config);
      return run;
    }

    // Steps 3-6: vote each site, one at a time, each tab in the foreground ----
    for (let idx = 0; idx < eligible.length; idx++) {
      const url = eligible[idx];
      const siteKey = siteKeyFromUrl(url);
      const label = `${mode === "preview" ? "Previewing" : "Voting"} ${idx + 1} of ${eligible.length}`;
      // Marker so a re-opened popup shows what's happening right now.
      run.current = { index: idx, total: eligible.length, site: prettySite(url), label };
      await setRun(run);
      notify("voter:progress", label, prettySite(url));
      try {
        const result = await voteSite(url, config, mode, run, { index: idx, total: eligible.length });
        run.sites.push({ url, siteKey, ...result });
      } catch (err) {
        run.sites.push({ url, siteKey, stage: "error", error: String(err?.message || err) });
        await notifyFailure(config, siteKey, err);
      }
      await setRun(run);
    }

    // Step 7: claim (not in preview) -------------------------------------
    if (mode === "vote") {
      const voted = run.sites.filter((s) => s.stage === "confirmed").length;
      if (voted > 0) {
        logStep(run, "claim", "running");
        notify("voter:claim", `Voted ${voted} site${voted > 1 ? "s" : ""}`, "Send /claim in the Discord tab to finish.");
        const claim = await doClaim(config);
        run.claim = claim;
        logStep(run, "claim", claim.acked ? "ok" : "prompted", claim.message);
      } else {
        logStep(run, "claim", "skipped", "no site confirmed a vote this run");
      }
    }
  } catch (err) {
    run.fatal = String(err?.message || err);
    await notifyFailure(config, "run", err);
  } finally {
    runInProgress = false;
  }

  run.current = null; // clear the "in progress" marker on every exit path
  await finishRun(run, config);
  return run;
}

// Step 3-6 for one site. Opens a tab, drives it through the vote flow by
// classifying each page and acting, until a confirmation page is reached.
async function voteSite(url, config, mode, run, position = { index: 0, total: 1 }) {
  // Foreground the tab so the user always sees the site currently being handled.
  const tab = await chrome.tabs.create({ url, active: true });
  await focusTab(tab.id);
  let outcome = { stage: "error" };
  try {
    await waitForComplete(tab.id);

    // Step 3: locate the vote submit for the chosen method.
    const method = config.vote.method;
    const found = await ask(tab.id, { cmd: "FIND_VOTE_BUTTON", method });
    if (!found?.found) throw new Error(found?.error || "Vote submit not found (adapter needs tuning).");
    if (found.name) await setName(serverIdFromUrl(url), found.name); // cache readable label

    if (mode === "preview") {
      await ask(tab.id, { cmd: "HIGHLIGHT", ref: found.ref, method });
      outcome = { stage: "preview", note: `Would tick the checkbox and click the ${method} submit.` };
      return outcome;
    }

    // Progress banner on the page so it's obvious which site (X of N) is active.
    await ask(tab.id, {
      cmd: "SHOW_PROGRESS",
      text: `Voting site ${position.index + 1} of ${position.total} — hang tight`,
    }).catch(() => {});

    // Steps 4-6: click, then drive the cross-origin flow to confirmation.
    outcome = await driveVote(tab.id, config, run);
    if (outcome.stage === "confirmed") {
      // Prefer the real revote window ark reports; add slack; fall back to config.
      // Ignore implausible parses (> 12h) so a misread can never lock a site out.
      const slackMs = config.vote.cooldownSlackMinutes * 60e3;
      const MAX_SANE = 12 * 3600e3;
      const parsed = outcome.cooldownMs && outcome.cooldownMs <= MAX_SANE ? outcome.cooldownMs : null;
      const cooldownMs = parsed ? parsed + slackMs : null;
      await recordVote(siteKeyFromUrl(url), {
        outcome: "confirmed",
        confirmText: outcome.confirmText,
        cooldownMs,
      });
    }
    return outcome;
  } finally {
    // Close the tab only on a clean confirmation; leave it open otherwise so the
    // user can see what went wrong (or finish an assisted step) by hand.
    if (outcome.stage === "confirmed") {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

// Navigation-driven loop: after kicking off the vote, follow the tab across
// origins (ark method-choice -> discord authorize -> ark confirm) by asking the
// live content script "what stage is this page?" and acting accordingly. This is
// more robust than hardcoding an exact page sequence we haven't verified yet.
async function driveVote(tab_id, config, run) {
  await ask(tab_id, {
    cmd: "CLICK_VOTE",
    clickMode: config.vote.clickMode,
    method: config.vote.method,
  });

  const MAX_STEPS = 14;
  let unknownStreak = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    await waitForComplete(tab_id);
    const stage = await classifyActive(tab_id, config); // {stage, confirmText?, ref?}

    switch (stage.stage) {
      case "vote-form":
        // Still on the ark vote page (submit hasn't navigated yet). Let it settle.
        unknownStreak = 0;
        await sleep(600);
        break;
      case "ad-blocker":
        throw new Error("ark-servers shows an ad-blocker warning — disable it for this site and retry.");
      case "method-choice":
        await ask(tab_id, { cmd: "CLICK_METHOD", method: config.vote.method });
        unknownStreak = 0;
        break;
      case "discord-authorize": {
        // Human-gated + Discord ignores synthetic clicks (§6/§8a). Bring the tab
        // forward, prompt, and wait for the user's real click to navigate away.
        await focusTab(tab_id);
        notify("voter:authorize", "Action needed", "Click Authorize in the vote tab to continue.");
        await ask(tab_id, { cmd: "CLICK_AUTHORIZE" });
        await waitForUrlLeave(tab_id, /discord\.com\/oauth2/i, 180000);
        unknownStreak = 0;
        break;
      }
      case "steam-signin": {
        // Steam sign-in/OpenID confirm — fully user-driven (we never type a
        // password). Focus, prompt, and wait for the redirect back off Steam.
        await focusTab(tab_id);
        notify("voter:steam", "Action needed", "Sign in to Steam in the vote tab to continue.");
        await ask(tab_id, { cmd: "CLICK_SIGNIN" });
        await waitForUrlLeave(tab_id, /steamcommunity\.com|steampowered\.com/i, 180000);
        unknownStreak = 0;
        break;
      }
      case "confirmed":
        return { stage: "confirmed", confirmText: stage.confirmText || null, cooldownMs: stage.cooldownMs || null };
      case "captcha":
        throw new Error("CAPTCHA encountered — stopping for you to solve by hand.");
      case "needs-login":
        throw new Error("Not logged in on this site/method — log in and retry.");
      case "unknown":
      default:
        // Transient/redirect page (e.g. /auth/). Give it a beat; only give up
        // after several consecutive unknowns.
        unknownStreak += 1;
        if (unknownStreak >= 5) {
          throw new Error("Stuck on an unrecognized page during the vote flow.");
        }
        await sleep(700);
    }
  }
  throw new Error("Vote flow did not reach a confirmation page.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
}

// Resolve once the tab's URL no longer matches `re` (i.e. it navigated away).
function waitForUrlLeave(tabId, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for Authorize (no click?)."));
    }, timeoutMs);
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(id, info, tab) {
      if (id === tabId && (info.url || tab?.url) && !re.test(info.url || tab.url)) finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => {
      if (t.url && !re.test(t.url)) finish();
    });
  });
}

// Ask whichever content script owns the tab's current origin to classify it.
async function classifyActive(tabId, config) {
  try {
    return await ask(tabId, { cmd: "CLASSIFY", method: config?.vote?.method || "discord" });
  } catch {
    return { stage: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Step 1: harvest
// ---------------------------------------------------------------------------

async function harvestLinks(config) {
  const tab = await openOrFocusDiscord(config.discord.linksChannelUrl);
  await waitForComplete(tab.id);
  const res = await ask(tab.id, { cmd: "HARVEST_LINKS", patterns: patternSources() });
  const links = dedupe(res?.links || []);
  if (links.length === 0) {
    // Distinguish "not ready" from a genuinely empty channel so the user knows
    // what to fix, instead of a vague "no links found".
    if (res?.state === "interstitial") {
      await focusTab(tab.id);
      throw new Error('Discord is showing its "Open in app?" screen — click "Continue in Browser" in that tab, then run again.');
    }
    if (res?.state === "login" || res?.state === "unknown") {
      await focusTab(tab.id);
      throw new Error("You're not logged into Discord in the browser. Log in at discord.com, open the vote channel, then run again.");
    }
    throw new Error("No vote links found in the channel (is this the right channel, and are links posted?).");
  }
  return links;
}

// ---------------------------------------------------------------------------
// Step 2: select (ordered preference, DESIGN.md §3)
// ---------------------------------------------------------------------------

function selectLinks(links, config, removed = {}) {
  const { prefer, avoid, count, preferIds = [] } = config.selection;
  const allowed = links.filter(
    (u) => !removed[serverIdFromUrl(u)] && !avoid.some((a) => matchPref(u, a))
  );
  const picked = [];
  const add = (url) => {
    if (picked.length < count && !picked.includes(url)) picked.push(url);
  };

  // 1) Pinned servers first, in the order the user listed them.
  for (const id of preferIds) {
    const url = allowed.find((u) => serverIdFromUrl(u) === String(id));
    if (url) add(url);
  }
  // 2) Then ordered preference patterns (domain/substring), then the "*" fallback.
  for (const pref of prefer) {
    for (const url of allowed) {
      if (picked.length >= count) break;
      if (matchPref(url, pref)) add(url);
    }
  }
  return picked.slice(0, count);
}

function matchPref(url, pref) {
  if (pref === "*") return true;
  return url.toLowerCase().includes(pref.toLowerCase());
}

async function filterEligible(urls, config) {
  const ledger = await getLedger();
  return urls.filter((u) => isEligible(ledger[siteKeyFromUrl(u)], config));
}

// ---------------------------------------------------------------------------
// Step 7: claim
// ---------------------------------------------------------------------------

async function doClaim(config) {
  const tab = await openOrFocusDiscord(config.discord.claimChannelUrl);
  await focusTab(tab.id); // bring the claim channel forward so the user can send /claim
  await waitForComplete(tab.id);
  // Default 'prompt' mode: the extension does NOT type for the user. It focuses
  // the channel and asks them to send /claim. The bot's only visible reply is an
  // ack ("I'm checking your votes!"); the real result is in-game (DESIGN.md §10).
  const res = await ask(tab.id, {
    cmd: "CLAIM",
    mode: config.discord.claimMode,
    command: config.discord.claimCommand,
    throttleMinutes: config.vote.claimThrottleMinutes,
  });
  return res || { acked: false, message: "Claim prompt shown." };
}

// ---------------------------------------------------------------------------
// Notifications & the "window open" alarm (DESIGN.md §6a)
// ---------------------------------------------------------------------------

async function scheduleWindowAlarm() {
  const config = await getConfig();
  if (!config.notify.windowOpen) {
    await chrome.alarms.clear(ALARM_WINDOW);
    return;
  }
  // Fire when the earliest *still-cooling* site's window opens. If nothing is
  // pending (all already eligible, or empty ledger), don't schedule — we've
  // already notified for open windows; scheduling now would just re-notify.
  const when = await nextFutureEligibleAt(config);
  if (when == null) {
    await chrome.alarms.clear(ALARM_WINDOW);
    return;
  }
  await chrome.alarms.create(ALARM_WINDOW, { when: when + 2000 });
}

async function onWindowAlarm() {
  const config = await getConfig();
  const ready = await countReady(config);
  if (ready > 0 && config.notify.windowOpen) {
    notify("voter:ready", "Voting available", `${ready} site(s) ready to vote.`);
  }
  await scheduleWindowAlarm(); // re-arm for the next window
}

async function notifyFailure(config, siteKey, err) {
  if (!config.notify.onFailure) return;
  notify(
    `voter:fail:${siteKey}`,
    "Vote run hit a problem",
    `${siteKey}: ${String(err?.message || err)}`
  );
}

function notify(id, title, message) {
  // iconUrl IS required by Chrome's notifications API — omitting it makes create()
  // fail silently, which is exactly why the test notification didn't show.
  chrome.notifications.create(
    id,
    { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message },
    () => {
      if (chrome.runtime.lastError) console.warn("notify failed:", chrome.runtime.lastError.message);
    }
  );
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (id === "voter:update") {
    const { update } = await chrome.storage.local.get("update");
    if (update?.url) return void chrome.tabs.create({ url: update.url });
  }
  chrome.action.openPopup?.().catch(() => {});
});

// ---------------------------------------------------------------------------
// Status summary for the popup
// ---------------------------------------------------------------------------

async function statusSummary() {
  const config = await getConfig();
  const ledger = await getLedger();
  const names = await getNames();
  const entries = Object.entries(ledger).map(([siteKey, e]) => ({
    siteKey,
    name: names[siteKey.split("/").pop()] || null,
    lastVoteAt: e.lastVoteAt,
    nextEligibleAt: nextEligibleAt(e, config),
    eligible: isEligible(e, config),
  }));
  return { entries, method: config.vote.method };
}

// The "Discovered servers" list for the picker: every harvested link from the
// last run, with its cached name (if known) and whether it's currently pinned.
async function discoveredSummary() {
  const [run, names, removed, config] = [await getRun(), await getNames(), await getRemoved(), await getConfig()];
  const links = run?.harvested || [];
  const pinned = new Set((config.selection.preferIds || []).map(String));
  const items = links.map((url) => {
    const id = serverIdFromUrl(url);
    const isRemoved = id ? !!removed[id] : false;
    return {
      url, id,
      name: (id && names[id]) || null,
      pinned: id ? pinned.has(id) && !isRemoved : false,
      removed: isRemoved,
    };
  });
  // Alphabetical by display name; removed servers sink to the bottom, unnamed last.
  const key = (it) => (it.removed ? "￿" : "") + (it.name ? it.name.toLowerCase() : "~" + (it.id || ""));
  items.sort((a, b) => key(a).localeCompare(key(b)));
  return { items, harvestedAt: run?.startedAt || null };
}

// Harvest-only pass: refresh the discovered list without opening vote tabs, and
// resolve readable names for anything we haven't seen yet.
async function rescan() {
  if (runInProgress) return { note: "A run is in progress." };
  const config = await getConfig();
  const run = await getRun() || freshRun("rescan");
  run.harvested = await harvestLinks(config);
  await setRun(run);
  await resolveNames(run.harvested);
  return discoveredSummary();
}

// Best-effort: fetch each server's vote page and pull its name from the <title>
// ("Vote for <name>"). Read-only GET — voting is a POST to /auth/, so this never
// casts a vote. Cookies omitted; results cached in the names map.
//
// Fetched in small batches (not one big Promise.all burst) because ark-servers
// throttles a flood of simultaneous requests, which silently dropped some names.
async function resolveNames(links) {
  const names = await getNames();
  const missing = links
    .filter((u) => {
      const id = serverIdFromUrl(u);
      return id && !names[id];
    })
    .slice(0, 30);

  const BATCH = 3;
  for (let i = 0; i < missing.length; i += BATCH) {
    await Promise.all(missing.slice(i, i + BATCH).map((u) => resolveOneName(u)));
    if (i + BATCH < missing.length) await sleep(300);
  }
}

async function resolveOneName(url, attempt = 0) {
  const id = serverIdFromUrl(url);
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) {
      // 410 = server delisted on ark; flag it so we never try to vote it.
      if (res.status === 410) return setRemoved(id, true);
      if (res.status === 429 && attempt < 2) {
        await sleep(700);
        return resolveOneName(url, attempt + 1);
      }
      return;
    }
    const html = await res.text();
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || "";
    const name = title.match(/vote for\s+(.+?)\s*$/i)?.[1];
    if (name) {
      await setName(id, name.trim());
      await setRemoved(id, false); // in case it was previously delisted and came back
    }
  } catch {
    if (attempt < 2) {
      await sleep(400);
      return resolveOneName(url, attempt + 1);
    }
  }
}

async function countReady(config) {
  // We can only count sites we've seen before (in the ledger). New sites are
  // always "ready" but unknown until a harvest; treat known-eligible as the count.
  const ledger = await getLedger();
  return Object.values(ledger).filter((e) => isEligible(e, config)).length;
}

// The soonest moment a cooling-down site becomes eligible again, or null if none
// are pending (all eligible now, or nothing in the ledger).
async function nextFutureEligibleAt(config) {
  const ledger = await getLedger();
  const now = Date.now();
  const future = Object.values(ledger)
    .map((e) => nextEligibleAt(e, config))
    .filter((t) => t > now);
  return future.length ? Math.min(...future) : null;
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

async function openOrFocusDiscord(url) {
  const [existing] = await chrome.tabs.query({ url: "https://discord.com/channels/*" });
  if (existing) {
    if (!existing.url?.startsWith(url)) {
      await chrome.tabs.update(existing.id, { url });
    }
    return existing;
  }
  return chrome.tabs.create({ url, active: false });
}

function waitForComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for the page to load."));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Small settle delay so content scripts finish initializing.
        setTimeout(resolve, 400);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    // In case it's already complete.
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(resolve, 400);
      }
    });
  });
}

async function ask(tabId, message, timeoutMs = 15000) {
  try {
    return await sendOnce(tabId, message, timeoutMs);
  } catch (e) {
    // A tab that was open before the extension loaded/reloaded has no live content
    // script. Inject the right one on demand and retry once.
    if (/Receiving end does not exist|Could not establish connection/i.test(String(e?.message || e))) {
      await ensureInjected(tabId);
      return await sendOnce(tabId, message, timeoutMs);
    }
    throw e;
  }
}

function sendOnce(tabId, message, timeoutMs) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`No response to ${message.cmd}`)), timeoutMs)
    ),
  ]);
}

// Inject the content script(s) matching a tab's URL (mirrors manifest matches).
async function ensureInjected(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  let files = null;
  if (/^https:\/\/discord\.com\/channels\//.test(url)) files = ["content/discord.js"];
  else if (/^https:\/\/discord\.com\/oauth2\//.test(url)) files = ["content/discord-oauth.js"];
  else if (/^https:\/\/([a-z0-9-]+\.)?ark-servers\.net\//.test(url))
    files = ["content/_base.js", "content/ark-servers.js"];
  else if (/^https:\/\/(steamcommunity\.com|[a-z0-9-]+\.steampowered\.com)\//.test(url))
    files = ["content/steam.js"];
  if (!files) return;
  await chrome.scripting.executeScript({ target: { tabId }, files });
}

// ---------------------------------------------------------------------------
// Run bookkeeping helpers
// ---------------------------------------------------------------------------

function freshRun(mode) {
  return {
    id: `run-${Date.now()}`,
    mode,
    startedAt: Date.now(),
    steps: [],
    sites: [],
    harvested: [],
    selected: [],
    claim: null,
    finishedAt: null,
  };
}

function logStep(run, name, status, detail = "") {
  // Upsert by step name so a step shows once with its latest status, instead of
  // stacking a "running" line and a final line (which looked like it was stuck).
  const existing = run.steps.find((s) => s.name === name);
  if (existing) {
    existing.status = status;
    existing.detail = detail;
    existing.at = Date.now();
  } else {
    run.steps.push({ name, status, detail, at: Date.now() });
  }
}

async function finishRun(run, config) {
  run.finishedAt = Date.now();
  await setRun(run);
  await scheduleWindowAlarm(); // ledger may have changed
  return run;
}

function patternSources() {
  return VOTE_LINK_PATTERNS.map((r) => r.source);
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function prettySite(url) {
  try {
    const u = new URL(url);
    const id = u.pathname.match(/server\/(\d+)/i)?.[1];
    return id ? `${u.hostname} #${id}` : u.hostname;
  } catch {
    return url;
  }
}
