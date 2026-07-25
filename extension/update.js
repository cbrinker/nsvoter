// update.js — self-hosted update check for the load-unpacked build.
//
// Load-unpacked extensions don't auto-update, so instead we periodically ask the
// GitHub Releases API for the latest tag and, if it's newer than the installed
// version, notify the player with a download link. Read-only, unauthenticated.
//
// >>> SET THIS before cutting your first release: your GitHub "owner/repo". <<<
export const GITHUB_REPO = "cbrinker/nsvoter";

export const UPDATE_ALARM = "voter:update-check";

export function scheduleUpdateChecks() {
  // Twice a day is plenty; also runs once shortly after startup/install.
  chrome.alarms.create(UPDATE_ALARM, { when: Date.now() + 10_000, periodInMinutes: 720 });
}

export function isConfigured() {
  return !!GITHUB_REPO && !GITHUB_REPO.startsWith("OWNER/");
}

// Compare dotted versions: returns true if `a` is newer than `b`.
export function isNewer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// Fetch the latest release, compare, and persist the result under "update".
export async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  if (!isConfigured()) {
    const result = { configured: false, current, checkedAt: Date.now() };
    await chrome.storage.local.set({ update: result });
    return result;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      const result = { configured: true, current, error: `HTTP ${res.status}`, checkedAt: Date.now() };
      await chrome.storage.local.set({ update: result });
      return result;
    }
    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/i, "");
    const url = data.html_url || `https://github.com/${GITHUB_REPO}/releases`;
    const available = !!latest && isNewer(latest, current);
    const result = { configured: true, current, latest, url, available, checkedAt: Date.now() };
    await chrome.storage.local.set({ update: result });
    return result;
  } catch (e) {
    const result = { configured: true, current, error: String(e?.message || e), checkedAt: Date.now() };
    await chrome.storage.local.set({ update: result });
    return result;
  }
}
