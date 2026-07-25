// storage.js — thin wrappers over chrome.storage.local.
//
// Everything the extension persists lives here: config, the per-site vote
// ledger, and the current run's checkpoint. All local, never synced, never sent
// anywhere (see DESIGN.md §7). Deliberately NOT chrome.storage.sync.

const KEYS = {
  config: "config",
  ledger: "ledger", // { [siteKey]: { lastVoteAt, lastOutcome, confirmText } }
  run: "run", // current/last run checkpoint (see background.js)
  names: "names", // { [serverId]: "display name" } learned from vote pages
  removed: "removed", // { [serverId]: true } servers delisted on ark (HTTP 410)
};

export const DEFAULT_CONFIG = {
  discord: {
    linksChannelUrl:
      "https://discord.com/channels/1234587242614362263/1246757880149835776",
    claimChannelUrl:
      "https://discord.com/channels/1234587242614362263/1246757880149835776",
    claimCommand: "/claim",
    claimMode: "prompt", // prompt | dom-inject  (see DESIGN.md §2)
  },
  selection: {
    count: 3,
    // Pinned server ids the user checked in the "Discovered servers" picker.
    // These take top priority over `prefer`. Empty = fall back to prefer/patterns.
    preferIds: [],
    prefer: ["ark-servers.net", "*"], // ordered patterns; first N matches win
    avoid: [],
  },
  vote: {
    method: "discord", // discord | steam
    clickMode: "auto", // auto -> assisted-click fallback if programmatic fails (§8a)
    // Fallback window when the page's "vote again in ~N hours" can't be parsed
    // (or is discarded as implausible). ark-servers reports ~2h, so default to that.
    cooldownHours: 2,
    cooldownSlackMinutes: 15,
    claimThrottleMinutes: 2, // bot rate-limits /claim; distinct from vote cooldown
  },
  notify: {
    windowOpen: true,
    onFailure: true,
  },
  // Dev-only: capture redacted page snapshots for offline adapter tests (§5, §7).
  captureFixtures: false,
};

function deepMerge(base, override) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    out[k] = deepMerge(base[k], override[k]);
  }
  return out;
}

export async function getConfig() {
  const stored = (await chrome.storage.local.get(KEYS.config))[KEYS.config];
  return deepMerge(DEFAULT_CONFIG, stored || {});
}

export async function setConfig(partial) {
  const current = await getConfig();
  const merged = deepMerge(current, partial);
  await chrome.storage.local.set({ [KEYS.config]: merged });
  return merged;
}

export async function getLedger() {
  return (await chrome.storage.local.get(KEYS.ledger))[KEYS.ledger] || {};
}

export async function recordVote(siteKey, { outcome, confirmText, cooldownMs }) {
  const ledger = await getLedger();
  const now = Date.now();
  ledger[siteKey] = {
    lastVoteAt: now,
    lastOutcome: outcome,
    confirmText: confirmText || null,
    // Explicit next-eligible time from the site's own "vote again in…" wording,
    // when we could parse it; otherwise null and we fall back to the config cooldown.
    nextEligibleAt: cooldownMs ? now + cooldownMs : null,
  };
  await chrome.storage.local.set({ [KEYS.ledger]: ledger });
  return ledger[siteKey];
}

// A site is eligible to vote again once cooldown + slack has elapsed.
export function cooldownMsFor(config) {
  return (
    config.vote.cooldownHours * 3600e3 +
    config.vote.cooldownSlackMinutes * 60e3
  );
}

export function nextEligibleAt(entry, config) {
  if (!entry?.lastVoteAt) return 0;
  // Prefer the site-reported window when we have it.
  if (entry.nextEligibleAt) return entry.nextEligibleAt;
  return entry.lastVoteAt + cooldownMsFor(config);
}

export function isEligible(entry, config, now = Date.now()) {
  return now >= nextEligibleAt(entry, config);
}

// Turn a raw vote-page title into a short display name, e.g.
// "[NerdServers] Island PvE (NoWipe/Modded/2-5x)" -> "Island".
// Drops [bracket] tags, trailing (qualifiers), and the redundant "PvE" token
// (every NerdServers map is PvE, so it adds no information here).
export function cleanServerName(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  s = s.replace(/^(\s*\[[^\]]*\]\s*)+/, ""); // leading [tags]
  s = s.replace(/\s*(\[[^\]]*\]\s*)+$/, ""); // trailing [tags]
  s = s.replace(/\s*(\([^)]*\)\s*)+$/, ""); // trailing (qualifiers)
  s = s.replace(/\bpve\b/gi, " ").replace(/\s{2,}/g, " ").trim(); // redundant PvE
  return s || String(raw).trim(); // never return empty
}

export async function getNames() {
  const raw = (await chrome.storage.local.get(KEYS.names))[KEYS.names] || {};
  // Clean on read too, so names cached before this rule still display tidily.
  const out = {};
  for (const [id, name] of Object.entries(raw)) out[id] = cleanServerName(name);
  return out;
}

export async function setName(serverId, name) {
  if (!serverId || !name) return;
  const clean = cleanServerName(name);
  const raw = (await chrome.storage.local.get(KEYS.names))[KEYS.names] || {};
  if (raw[serverId] === clean) return;
  raw[serverId] = clean;
  await chrome.storage.local.set({ [KEYS.names]: raw });
}

export async function getRemoved() {
  return (await chrome.storage.local.get(KEYS.removed))[KEYS.removed] || {};
}

export async function setRemoved(serverId, isRemoved) {
  if (!serverId) return;
  const removed = await getRemoved();
  if (isRemoved) removed[serverId] = true;
  else delete removed[serverId];
  await chrome.storage.local.set({ [KEYS.removed]: removed });
}

export async function getRun() {
  return (await chrome.storage.local.get(KEYS.run))[KEYS.run] || null;
}

export async function setRun(run) {
  await chrome.storage.local.set({ [KEYS.run]: run });
  return run;
}

// The vote site's numeric server id, e.g. .../server/369390/vote/ -> "369390".
export function serverIdFromUrl(url) {
  return String(url).match(/server\/(\d+)/i)?.[1] || null;
}

// Derive a stable key for a vote site from its URL, e.g.
// "https://ark-servers.net/server/369390/vote/" -> "ark-servers.net/369390".
export function siteKeyFromUrl(url) {
  try {
    const u = new URL(url);
    const idMatch = u.pathname.match(/server\/(\d+)/i);
    return idMatch ? `${u.hostname}/${idMatch[1]}` : `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}
