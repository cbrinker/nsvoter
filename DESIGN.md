# Voter — Design Proposal

Automate the "vote for our server" loop: pull the current vote links from a Discord
channel, vote on 3 of them (Discord OAuth flow), then run `/claim` back in Discord.
Runs are time-gated (~4h cooldown per site), so the design leans heavily on being
testable **without** spending a live vote.

Status: **draft for review**

---

## 0. Guiding principle: distributed, per-player, zero shared secrets

Three requirements — heavy auth/token handling, surviving bot detection, and
letting other players run it too — all point at the **same** decision:

> **The tool ships to each player and runs on their own machine against their own
> browser session. No player's credentials or tokens ever leave their device, and
> there is no central server that holds them.**

Why this one decision satisfies all three:

- **Auth/tokens stay safe** because nobody (including you) ever custodies another
  player's Discord token. A central token store would make *you* the breach target
  and the party responsible if it leaks. Distributed = each player owns their risk.
- **Bot detection is defeated, not fought** because each player votes from their
  own IP and their own real browser fingerprint. The opposite — many players'
  votes flowing through one server — is the *exact* botnet signature these sites
  are built to catch, and would get everyone banned at once.
- **Distribution is trivial** because "install and run locally" is already the
  shape of the tool; there's no service to operate, scale, or secure.

Everything below is designed around this principle. Where a feature would tempt us
toward a central server (shared config, aggregated results), we keep the *secrets*
local and only ever share non-sensitive data (which links are live, layout
fixtures) — never tokens.

---

### Concrete targets (from the demo)

- **Discord server/channel:** `https://discord.com/channels/1234587242614362263/1246757880149835776`
- **Vote sites:** ARK server lists, e.g. `https://ark-servers.net/server/369390/vote/`.
  `ark-servers.net` is the **first adapter target**; other sites in the channel get
  their own adapters as we hit them.
- **Credential method:** each site offers **Steam** *or* **Discord** login. Both are
  supported; the player picks their default in the popup. (The demo used Discord.)
  Earlier drafts said "Stam" — that was a typo for Steam.

## 1. The workflow, restated

1. **Harvest** — read the Discord channel above; extract the current vote links
   (they rotate every few days, so never hardcode them).
2. **Select** — pick 3 links according to the player's saved preference (§3).
3. **Vote** (per link ×3):
   a. Open link → find the green **Vote** button → click.
   b. On the vote page, choose the player's method — **Steam** or **Discord**.
   c. Auth page (Steam sign-in / Discord OAuth) → click **Authorize / Sign In**.
   d. Land on confirmation page → verify the "you can vote again in ~4 hours" notice.
4. **Claim** — back in Discord, run `/claim` in the bot channel; read the bot's
   reply to confirm the claim registered.

Note: Steam and Discord auth differ — Discord is a single **Authorize** click on a
remembered app; Steam may show its own sign-in / confirm page. The adapter handles
each method's auth page separately, but both are the player's own live session.

## 2. Architecture

The runtime that best fits §0 (per-player, own browser, no central secrets) is a
**Chrome extension (Manifest V3)**. It runs *inside* the player's real, logged-in
browser by construction — so real IP, real fingerprint, real session, and nothing
to custody — and it installs with one click, which is what "other players can use
it" actually requires. Claude's role shifts from *runtime* to *build & maintenance
tool*: we use it to author and, crucially, to keep the per-site adapters current
(§8's markup-drift problem).

### Recommended: Chrome extension (MV3)

```
┌─ popup UI ─────────┐   config, preferences, "Vote now", run report
├─ background worker ┤   orchestrates the state machine (§4) across tabs
├─ content scripts ──┤   per-site adapters: find vote button, detect confirm page
└─ storage (local) ──┘   ledger + config, never synced, never sent anywhere
```

Why it's the right runtime here:

- **Best possible fit for §0.** There is no server, no token store, no shared
  session — the extension only ever acts in the player's own browser with the
  player's own cookies. "Distributed and per-player" isn't a design effort; it's
  the platform's default.
- **One-click distribution.** Install from a packaged extension beats "set up
  Claude Code and a skill" for non-technical server members. (Self-hosted for now,
  §9.) This is the deciding factor if the multi-player goal is ever pursued.
- **Native cross-tab orchestration.** With host permissions for the vote sites +
  the Discord OAuth origin, the background worker can drive the open link → vote →
  OAuth → confirm sequence across tabs, reading each page's real DOM.
- **No credential handling and no AI cost per run.** Reuses the live session;
  fully self-contained; free to run as often as cooldowns allow.

Two real tradeoffs we take on by choosing this (both manageable, neither free):

1. **We lose semantic page-reading.** A Claude agent can find "the green vote
   button" by meaning; an extension matches DOM. When a site redesigns, the
   adapter breaks until updated. **Mitigation:** small, per-site *adapter modules*
   with layered selectors (text/role/color heuristics, not one brittle CSS path),
   a `--dry-run` that surfaces a break *before* a live vote, and a fast
   Claude-assisted update loop against captured fixtures (§5) when one rots.
2. **Synthetic events can be detected.** An extension's `element.click()` /
   `dispatchEvent` produces events with `isTrusted === false`, which some anti-bot
   checks (and some vote buttons) look for. A CDP-driven click (the Claude/Chrome
   path) produces *trusted* events. **This is site-dependent** — the OAuth
   Authorize button and most confirm flows don't check; a hardened vote button
   might. See §8a for how we handle it, including the fallback where the extension
   just *highlights* the button and the player clicks it (a real, trusted click).

### The Discord piece needs care either way

Reading the links channel is a read-only DOM scrape of the player's own Discord —
fine. But *typing `/claim`* by injecting into Discord's message box is fragile
(hostile DOM/CSP) and edges toward user-account automation (self-bot ToS). Since
you don't control this server, the default is (b) below; (a) is a "nice to have"
if the admin you know is willing:

- (a) *Admin-assisted (best, needs the admin):* a bot-side path that doesn't
  require typing in-app, or the bot posting links in a machine-friendly format so
  harvesting is trivial and ToS-clean. Park this as an ask for your admin contact.
- (b) *Prompt (default):* the extension does the votes, then opens the claim
  channel and prompts "votes cast — type `/claim` here" for the player to send.
- (c) *DOM-inject:* last resort only; fragile and closest to the self-bot line.

### Alternatives considered

- **Claude Code skill driving Chrome** (prior recommendation): semantic
  resilience, trusted CDP clicks, graceful natural-language failure handling — but
  it can't be handed to a player and you've opted for **just the extension**.
  **Verdict:** we use Claude only at *build time* (writing/fixing adapters against
  fixtures), not as a runtime. No standing Claude-in-Chrome path to maintain.
- **Standalone Playwright/cron script:** rejected as before — selector
  brittleness, headless bot-detection, and self-bot ToS. An extension gets the
  real-browser benefits a headless script can't.
- **Userscript (Tampermonkey):** lighter than an extension and easy to share, but
  no clean cross-tab orchestration or background state, and it pushes a dependency
  (the userscript manager) onto every player. An MV3 extension is the better
  packaging of the same idea.

We keep the per-step contract (§4) runtime-agnostic, so the same state machine
backs both the extension and the Claude dev path.

## 3. Components

```
voter/                          ← repo (dev + fixtures + docs)
├── DESIGN.md                   ← this file
├── extension/                  ← the shipped MV3 extension
│   ├── manifest.json           ← host permissions: discord OAuth + vote sites
│   ├── background.js           ← state machine (§4), cross-tab orchestration
│   ├── popup/                  ← config UI, "Vote now", run report
│   ├── content/                ← per-site adapters (one module per vote site)
│   │   ├── discord.js          ← read links channel; prompt for /claim
│   │   ├── _base.js            ← shared button/confirm heuristics
│   │   └── <site>.js           ← find vote button, detect confirm page
│   └── storage.js              ← chrome.storage.local: config + ledger
├── fixtures/                   ← captured page snapshots for offline adapter tests
│   └── <site>/<step>.{html,png,txt}   (secrets redacted, §7)
└── tools/                      ← Claude-assisted dev: adapter updates, fixture replay
```

Config lives in `chrome.storage.local` (never `storage.sync` — see §7), edited
through the popup. The logical shape:

```yaml
discord:
  links_channel_url: https://discord.com/channels/<guild>/<channel>
  claim_channel_url: https://discord.com/channels/<guild>/<channel>
  claim_command: /claim
  claim_mode: prompt          # prompt | bot-webhook | dom-inject (see §2)

selection:
  count: 3
  # Ordered preference. First N matches win; supports substring/domain match.
  prefer:
    - ark-servers.net
    - "*"            # fallback: anything else, in message order
  avoid: []           # never pick these

vote:
  method: discord     # discord | steam — player's default login on vote sites
  click_mode: auto    # auto → assisted fallback if programmatic click fails (§8a)
  cooldown_hours: 4   # FALLBACK only; the real window is parsed from the site's
                      # "vote again in ~N hours" page (ark-servers is ~2h, not 4).
  cooldown_slack_minutes: 15   # don't run a site until cooldown + slack

notify:
  window_open: true   # Chrome notification when a cooldown window opens (§6a)
  on_failure: true    # Chrome notification when a run fails partway
```

The ledger (per-site vote timestamps + last confirmation text) and per-run
checkpoint state also live in `chrome.storage.local`, keyed so a partial run
resumes without re-voting a confirmed site.

### The ledger

One entry per site: last vote timestamp, last outcome, the exact confirmation
text seen. This is what makes runs safe to repeat — the extension refuses to touch
a site still inside its cooldown, so a re-run after a partial failure only does the
remaining work.

## 4. The run: a checkpointed state machine

The background worker runs each vote as a sequence of steps with **explicit
pre/postconditions**, persisted to storage after every step. A crash, tab close,
or mid-run failure resumes from the checkpoint — it never re-votes a site that
already confirmed, and a failure on site 2 doesn't block site 3.

| # | Step        | Postcondition (verified before advancing)                     |
|---|-------------|---------------------------------------------------------------|
| 1 | harvest     | ≥3 distinct vote URLs extracted; each is a plausible vote-site domain |
| 2 | select      | 3 URLs chosen; all outside cooldown per ledger                 |
| 3 | vote.open   | Vote button located (screenshot + element captured)            |
| 4 | vote.click  | Credential-method page reached (Steam/Discord choice visible)  |
| 5 | vote.auth   | Auth page for the *chosen* method (Discord app / Steam sign-in) |
| 6 | vote.confirm| Confirmation page shows success + revote-window text           |
| 7 | claim       | Bot **ack** reply seen ("I'm checking your votes…"). That's all we can observe — the actual result is in-game only (§10). |

Steps 3–6 repeat per site. During development (and opt-in "help fix a broken
adapter" mode) each step saves a redacted page snapshot to `fixtures/` — the audit
trail and offline test corpus (§5). In normal player use, snapshotting is off by
default; only the ledger's confirmation text is retained.

Step 7 detail: the ack is the **only** feedback the tool can see; the claim's real
outcome (reward granted / no new votes) happens in-game and is invisible to the
extension. So step 7 verifies *"the command was accepted"*, nothing more — success
of the vote itself is already proven at step 6 (the confirmation page). A `/claim`
is not re-issued within the bot's 2-minute command throttle (distinct from the 4h
vote cooldown — see §10).

Failure policy: any postcondition miss → stop that site, snapshot the page,
continue with the next site, and report exactly where it diverged. Never guess
past a failed check — at one live test per 4 hours, a wrong click costs a window.

## 5. Testing without burning cooldowns  ← the important part

Four layers, cheapest first:

1. **Dry-run mode ("Preview" in the popup).** Executes everything *read-only*:
   harvests links, applies selection, opens each vote page, locates the green
   vote button — then instead of clicking, highlights the target element and
   reports "here is exactly what I would click." Zero votes spent. Validates
   steps 1–3 completely and can run any time, repeatedly. (This is also the
   §8a probe: it confirms the adapter finds the button before you spend a vote.)

2. **Fixture replay (dev harness).** Captured HTML snapshots let the per-site
   adapters be unit-tested offline in `tools/` — "does the harvester still find 3
   links in this saved channel dump?", "does this adapter still find the button in
   last week's page?" Free, instant, repeatable; run on every adapter change so a
   redesign is caught before a live run. This is where Claude earns its keep:
   updating a broken adapter against a fresh fixture, then proving it green here.

3. **Staggered live validation.** Never debug all three sites in one window.
   With a 4h cooldown there are ~6 windows/day: vote *one site per window* while
   validating (the popup's per-site "Vote just this one"), keeping the other two
   available. First full live run happens only after each site passes individually.

4. **Post-hoc verification.** Even a "successful" run is verified from evidence,
   not assumption: the confirmation-page text, the ledger entry, and the bot's
   `/claim` reply are all recorded and shown in the run report.

The 4-hour constraint mainly punishes *steps 4–6* (the actual click/OAuth/confirm
chain). Steps 1–3 and 7 are cheap to test: harvesting and selection are read-only,
and `/claim` can be tested independently any time the bot allows it (worst case it
replies "no votes to claim", which is itself a successful test of step 7).

## 6. Constraints & guardrails (non-negotiable)

- **CAPTCHAs are never bypassed.** If a vote site throws a CAPTCHA, the run
  pauses, notifies you, you solve it by hand, and the run resumes. (Expect this —
  vote sites use them precisely to stop tools like this one.)
- **The OAuth "Authorize" click and the `/claim` action are surfaced to the
  player** as account-level, outward-facing actions (a popup confirm, or the
  assisted-click of §8a). Observed reality: the ARK-Servers app re-prompts
  **Authorize on every vote** (it does not skip on a remembered grant), so each
  vote requires one real click. The flow foregrounds the tab and highlights the
  button so this is a single, obvious click per site.
- **No passwords, ever.** If a session has expired, the run stops and tells the
  player to log in manually; it never enters credentials.
- **Cooldown ledger is authoritative.** The extension will not vote on a site
  whose ledger entry is inside `cooldown + slack`, even if asked.
- **ToS note.** This automates *your* votes on *your* account at human pace, one
  cycle per cooldown window — but most vote sites' ToS technically prohibit any
  automation. Worth a conscious ✓ from you before we build.

### 6a. Notifications

Two Chrome notifications, both toggleable (config in §3):

- **Window open** — when the earliest site's `cooldown + slack` elapses, the
  extension badges its icon and fires a notification ("Voting available — 3 sites
  ready"). Implemented with a `chrome.alarms` timer set from the ledger's next
  eligible timestamp; survives browser restarts. Clicking it opens the popup.
- **Failure** — if a run halts partway (CAPTCHA, expired login, adapter miss, no
  confirm page), a notification names the site and the reason, and the popup run
  report has the detail + "what to do." No silent failures.

These use the `notifications` and `alarms` permissions only — no background
network, no polling a server. "Window open" is the closest we get to hands-off:
the extension tells you when to act; you still click Vote.

## 7. Auth & token handling

The single most sensitive part of the project. Rules, in priority order:

- **Never see, type, or store a password.** Login happens in the player's own
  browser, by the player, before the run. If a session is expired, the run stops
  and asks them to log in — it does not authenticate on their behalf.
- **Never centralize tokens.** No player's Discord token, OAuth grant, session
  cookie, or vote-site auth ever leaves their machine or gets sent to a shared
  service. There is no "token database."
- **Prefer to never touch the token at all.** By driving the player's real logged-in
  browser, the tool *reuses* an existing session rather than handling a token.
  Discord's OAuth "Authorize" is a click in that browser, not a token we extract.
- **If a token must ever be read** (e.g. a future headless mode), it lives only in
  OS-level secure storage (Keychain on macOS) on the player's own device, is never
  logged, never written to `state/` or `fixtures/`, and is scrubbed from any page
  snapshot before it's saved (see §5 fixture capture — snapshots get a
  redaction pass for `Authorization` headers, `token=` query params, cookies, and
  OAuth `code`/`access_token` values).
- **Fixtures are sanitized by default.** Because we snapshot pages for offline
  testing, the capture step must strip secrets *before* writing to disk, or a
  shared fixture corpus (§9) would leak them. Treat this redaction as a hard
  gate, not a nicety.

Threat model in one line: the tool should be safe to hand to a stranger, and safe
for that stranger to run, precisely because it holds nothing of theirs.

## 8. Surviving bot detection

You're right that this will get scrutinized — detecting tools like this is these
sites' core competency. Strategy is "look human because you largely are," not
"out-engineer their fingerprinting":

- **Real browser, real profile, real IP.** Per §0, each player uses their own
  Chrome. No headless flags, no fresh automation profile, no datacenter IP — the
  three things detectors weight most heavily.
- **Human pacing.** One cooldown cycle per window, randomized think-time between
  actions, no burst of identical timings. Never parallelize the three votes.
- **No shared fingerprint across players.** The distributed model means players
  don't share IPs, cookies, canvas/WebGL fingerprints, or timing patterns — so a
  ban signal on one can't cascade.
- **CAPTCHA = stop and hand off.** We never solve or bypass CAPTCHAs (also a hard
  rule in §6). Hitting one is expected; the run pauses for the human.
- **Fail closed on anomalies.** Maintenance pages, unexpected redirects, or "are
  you a robot" interstitials halt the run and snapshot, rather than retrying in a
  way that looks like a bot hammering the endpoint.
- **What we explicitly do NOT do:** spoof user-agents, forge fingerprints, rotate
  proxies, or otherwise actively evade detection. That's an arms race we'd lose,
  and it crosses from "automating my own votes" into deception. If a site's
  detection blocks the real-browser approach, that's a signal to stop, not to
  escalate.

### 8a. Trusted vs. synthetic clicks (the extension-specific wrinkle)

An extension's programmatic click (`el.click()`, `dispatchEvent`) is marked
`isTrusted === false`; a click the human physically makes, or one driven via
Chrome DevTools Protocol, is `isTrusted === true`. Some hardened vote buttons
check this. How we handle it, in order:

1. **Try the honest programmatic click and verify the postcondition (§4).** If the
   confirm page appears, the site didn't care — done, no complexity needed.
2. **If it silently fails**, fall back to **assisted click**: the extension
   scrolls to and highlights the exact button, and the *player* clicks it — a
   genuinely trusted event, zero spoofing. This keeps the 3-vote flow mostly
   automated while staying honest on the one gated action.
3. **We deliberately avoid `chrome.debugger`/CDP inside the extension** to forge
   trusted events: it shows a scary "extension is debugging this browser" banner
   and is fragile. If a site genuinely requires trusted clicks end-to-end, the
   assisted-click fallback (step 2) covers it — the player's real click is trusted.

Worth an early live probe on `ark-servers.net`: on one real vote, check whether a
plain programmatic click registers. That single test tells us whether the
assisted-click fallback is needed at all, or only as a safety net.

## 9. Multi-player distribution (deferred — build for you first)

**Priority note:** you've said getting it working for yourself matters more than
reusability, so this whole section is **Phase B**. It stays in the design as the
target shape so Phase A doesn't paint us into a corner (secrets local, adapters
modular), but none of it is built until your single-player flow is solid.

Goal, when we get there: any player on the server can install and run this for
their own votes.

**Shape:** the MV3 extension (§2). A player installs it, opens the popup, sets
their Discord channel URLs and preferences, and clicks Vote. Onboarding is
"install, point at your channels, Preview, then go live" — no toolchain, no config
files, no Claude required at runtime.

**What ships vs. what stays on-device:**

| Ships in the extension (non-sensitive)         | On-device only (never leaves)            |
|------------------------------------------------|------------------------------------------|
| Extension code + per-site adapters             | Discord token, session cookies, OAuth    |
| Default preferences / known-site list          | The player's ledger + run state          |
| Redacted layout fixtures (dev repo only)       | The player's browser profile & config    |

**Distribution: self-hosted (decided).** No Chrome Web Store for now — we ship the
packaged extension for **"load unpacked" / developer mode**, or as a self-hosted
`.crx` + update feed. This sidesteps store review (a voting/Discord-injecting
extension is exactly the kind that draws scrutiny) at the cost of manual install
and updates. Fine for a handful of trusted players; revisit the store only if
distribution ever needs to go wide.

**Explicitly out of scope (and why):** a hosted "vote-for-me" service, a shared
account, or any component that votes on players' behalf from central infra —
rejected for the security and bot-detection reasons in §0. If demand pushes that
way, the answer is better local tooling, not a central token vault.

**Support surface:** because each player runs their own real browser, most
failures (expired login, CAPTCHA, new layout) are things only that player can
resolve. The tool's job is to detect and *clearly report* those, so a
non-technical player knows exactly what to do, rather than silently failing.

## 10. Decisions (resolved) & remaining questions

**Resolved from your feedback:**

| Topic            | Decision                                                            |
|------------------|--------------------------------------------------------------------|
| Runtime          | MV3 Chrome extension only — no Claude runtime, Claude is build-time |
| Vote sites       | ARK server lists; `ark-servers.net` is the first adapter           |
| Credential method| Support **both** Steam and Discord; player picks default in popup  |
| Selection pref   | Per-player setting in the popup (§3 `selection`)                    |
| Cadence          | On-demand + **"window open" notification** (§6a)                    |
| Failure alerting | **Chrome notification** on partial failure (§6a)                    |
| Priority         | Single-player first; multi-player (§9) deferred to Phase B          |
| Distribution     | Self-hosted / load-unpacked; no Chrome Web Store for now           |

**Also resolved:** no admin ask for now (harvest by DOM scrape, prompt for
`/claim`). Discord method built first, Steam added later.

**The `/claim` reply — and an important subtlety.** The known success reply is:

> "\<user>, I'm checking your votes! Please note that you can only claim once
> every 2 minutes."

This is an **acknowledgment that the bot started checking — not confirmation that
votes were counted or a reward granted.** Consequences for step 7 (§4):

- **The outcome is invisible to us.** The real result (reward granted / no new
  votes) is delivered **in-game only** — there is no message in Discord or the
  browser the extension can read. So step 7 can verify *"the `/claim` command was
  accepted"* and nothing more. That's acceptable: the vote's own success is already
  proven at step 6 by the site's confirmation page. Claiming is fire-and-confirm.
- **Two distinct throttles.** The "once every 2 minutes" is a rate-limit on the
  `/claim` *command*; it is **separate** from the ~4-hour *vote* cooldown per site.
  The ledger tracks the 4h vote windows; a small local guard also avoids
  re-issuing `/claim` inside 2 minutes.

## 11. Build plan (once design is approved)

Phase A — **works for you** (single-player, all secrets on-device). This is the
whole current focus:

1. Scaffold the extension shell: `manifest.json` (host permissions for
   `ark-servers.net`, the Discord OAuth origin, and Discord; `notifications` +
   `alarms` perms), background worker with the §4 state machine, popup with config
   + Preview + Vote, and `chrome.storage.local` for config/ledger/run state.
2. Build the **`ark-servers.net` adapter** + `_base.js` button/confirm heuristics
   (Discord method first), plus the fixture-capture redaction gate (§7) so no
   snapshot lands on disk with a token in it.
3. Validate harvesting (the real channel) + selection + Preview — read-only, no
   cost, repeatable.
4. **The §8a probe:** one live vote on `ark-servers.net` to learn whether a
   programmatic click registers, or the assisted-click fallback is needed. Set
   `click_mode` from the result.
5. Live-validate one site end-to-end per cooldown window (§5.3). Add the Steam
   method to the adapter once we can watch a real Steam vote (Q2).
6. Wire the `/claim` step in prompt mode (§2b) + step-7 read-back of the bot reply;
   validate independently.
7. Add the §6a notifications (window-open + failure).
8. First full 3-site run; iterate on the popup run report. Add adapters for the
   other channel sites as we encounter them.

Phase B — **packaged for other players** (deferred; only if/when you want it):

9. Separate the dev repo (adapters, fixtures, `tools/`) from the shipped extension;
   ensure nothing player-identifying is bundled.
10. Onboarding: a short README/GIF and a first-run popup flow that checks
    prerequisites (Chrome, logged-in Discord/Steam) and walks a player through Preview.
11. Package for self-hosted install (§9) — `.crx` + update feed; no Web Store.
