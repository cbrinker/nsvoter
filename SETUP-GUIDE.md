# NerdServers Voter — Install & Setup Guide

*Auto-cast your daily ARK-Servers votes for the NerdServers cluster.*

> **Draft** — the tool is still being refined, so steps and screenshots may change.

NerdServers Voter is a Chrome extension. It reads the current vote links from the Discord
channel, votes for the servers you choose (using your own Discord or Steam login),
and then reminds you to run `/claim`. It runs entirely in **your** browser — it
never sees your password and never sends your account info anywhere.

---

## Before you start

You'll need:

- **Google Chrome** on a computer (not mobile).
- To be **logged into Discord in Chrome** (the web app, `discord.com`) and a member
  of the NerdServers server. If you'll vote with Steam, be logged into Steam in
  Chrome too.
- 2 minutes for setup.

---

## 1. Install the extension

1. Download the Voter folder (or unzip it) somewhere you'll keep it — don't delete
   it later, Chrome loads it from this folder.
2. In Chrome, go to **`chrome://extensions`**.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and select the **`extension`** folder.
5. You should see the **Voter** tile (pink “V” icon) appear. Pin it to your toolbar
   for easy access (click the puzzle-piece icon → pin Voter).

*(A one-click Chrome Web Store install may come later; for now it's this manual load.)*

---

## 2. First-time setup

Click the **Voter** icon to open the popup, then open **Settings**:

1. **Links channel URL** — the Discord channel where the vote links are posted.
   Open that channel in Discord, copy the URL from your browser's address bar, and
   paste it in. (It looks like `https://discord.com/channels/…/…`.)
2. **Claim channel URL** — the channel where you type `/claim` (often the same one).
3. **Vote method** — **Discord** or **Steam**, whichever you use to vote.
4. Click **Save settings**.

Then set up your favorites under **Preferred servers**:

5. Click **Rescan links** — Voter reads the channel and lists the servers currently
   up for voting, by name.
6. **Check the servers you want to vote for.** These get priority. Pick up to 3
   (the default number of votes per run).

---

## 3. Cast your votes

1. *(Optional but recommended the first time)* click **Preview** — Voter opens each
   server's vote page and highlights the button it would click, **without** voting.
   Zero votes spent; just a dry run so you can see what it'll do.
2. Click **Vote now**.
3. Voter handles one site at a time and brings each tab to the front. When the
   **Discord Authorize** page appears, **click Authorize** — that's the one step
   you do yourself each time (Discord requires a real click).
4. When it finishes, it opens the claim channel. **Type `/claim`** and send it.
   The bot replies "I'm checking your votes!" — that's the confirmation. (Your
   reward shows up in-game.)

That's it. You can vote again after the cooldown (about 2 hours) — the popup shows
a countdown for each server, and Voter can notify you when they're ready again
(enable this under Settings → Notifications).

---

## Keeping it up to date

Vote sites change their pages sometimes, so Voter gets updates. It **can't**
update itself automatically (that's a limitation of this install method), but it
**tells you** when a new version is out:

- When an update exists, you'll get a notification and an **"Update available"**
  banner at the top of the popup. You can also click **Check for updates** at the
  bottom of the popup any time.
- To update: click the banner to open the download page, download the new zip,
  unzip it (replacing your old folder), then go to `chrome://extensions` and click
  the **reload** icon on the Voter card (or remove it and Load unpacked again).

Your settings and preferred servers are kept — updating only replaces the program
files.

## Troubleshooting

- **Test notification / alerts don't show.** On Mac, allow them at
  **System Settings → Notifications → Google Chrome**, and turn off Do Not
  Disturb / Focus. Use Settings → **Send test notification** to check.
- **"Vote button not found" or it stalls.** The vote site may have changed its
  page, or you may be logged out. Make sure you're logged into Discord/Steam in
  Chrome and try again; if it persists, the extension needs a small update.
- **A CAPTCHA appears.** Solve it yourself in the tab — Voter will not, and should
  not, bypass it.
- **"Ad blocker detected."** The vote site refuses to count votes with an ad
  blocker active on their page. Pause it for `ark-servers.net` and retry.
- **Nothing eligible.** All your chosen servers are still in cooldown — check the
  countdown in the popup.

---

## Your privacy

- Voter runs only in your browser and uses your existing logins. It **never** asks
  for or stores your password, and there is no central server collecting anything.
- It only reads the vote channel to find links, and only acts on the servers you
  choose.
