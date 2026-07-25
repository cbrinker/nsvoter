# Voter extension (Phase A scaffold)

Semi-automated server voting: harvest the current vote links from a Discord
channel, vote on 3 sites (Discord or Steam login), then prompt you to `/claim`.
See [`../DESIGN.md`](../DESIGN.md) for the full design and rationale.

**Status: scaffold.** The architecture is wired end-to-end, but the vote-site
selectors are first-attempt heuristics that must be tuned against the real
`ark-servers.net` pages (search for `NOTE(live)` / `TODO(live)`). Nothing here
has been run against a live vote yet — that's the §8a probe in the build plan.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Make sure you're logged into Discord (and Steam, if using it) in this Chrome
   profile — the extension reuses your live sessions; it never handles passwords.

Optional: drop 16/48/128px PNGs in `extension/icons/` (`icon16.png`, etc.) and
add an `"icons"` block to `manifest.json`. Chrome uses defaults without them.

## Use

- Click the toolbar icon to open the popup.
- **Preview (no vote):** harvests links, applies your selection, opens each vote
  page, and highlights the button it *would* click. Spends zero votes — run it
  freely to check the adapters.
- **Vote now:** runs the full flow. The Discord Authorize step is assisted by
  default (it highlights the button and you click it — a real, trusted click).
- After voting, it opens the claim channel and prompts you to send `/claim`. The
  bot's only visible reply is an ack; the real result is in-game (DESIGN.md §10).
- **Settings:** channel URLs, vote method, click mode, selection preferences, and
  notification toggles.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions, content-script matches |
| `background.js` | Service worker: run state machine (§4), tab orchestration, notifications |
| `storage.js` | `chrome.storage.local` wrappers: config, ledger, run state |
| `content/_base.js` | Shared vote-site heuristics (button/confirm/method detection) |
| `content/ark-servers.js` | Adapter for ark-servers.net vote pages |
| `content/discord.js` | Harvest links; prompt `/claim` |
| `content/discord-oauth.js` | Click Authorize on the Discord OAuth page |
| `popup/` | Control UI + run report + cooldown status |

## Next steps (per DESIGN.md §11)

1. Load it, open **Preview**, and see whether harvesting + button detection work
   against the real channel and an `ark-servers.net` page. Tune `NOTE(live)` spots.
2. Run the §8a probe: one live vote, to learn whether the programmatic click
   registers or `clickMode: assisted` is needed.
3. Validate one site per cooldown window; then add the Steam method and more site
   adapters.
