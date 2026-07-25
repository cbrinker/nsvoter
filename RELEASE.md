# Releasing Voter (maintainer guide)

Distribution model: **self-hosted via GitHub Releases**, with an in-extension
update checker. Players install by "Load unpacked" and the extension notifies them
when a newer release exists. There is no Chrome Web Store listing (see DESIGN.md §9
for why — automation/DOM-injection makes review approval unlikely).

## One-time setup

1. Create the GitHub repo (e.g. `nerdservers/voter`) and push this project.
2. Set the update-check target: in `extension/update.js`, change
   `GITHUB_REPO = "OWNER/REPO"` to your real `owner/repo`. Until you do, the
   checker stays disabled (and `package.sh` warns you).

## Cutting a release

The `Makefile` wraps this. One-time: `brew install gh && gh auth login`.

```sh
make bump V=0.2.1                 # set the new version in manifest.json
git commit -am "v0.2.1: <what changed>"
make release NOTES="<what changed>"   # push, tag v0.2.1, publish release + zip
```

`make release` guards against the common mistakes (gh missing/unauthed,
uncommitted changes, tag already exists), builds the zip, pushes `main`, then
`gh release create`s the tag with the zip attached. `NOTES` is optional.

Manual equivalent, if you prefer:

1. **Bump the version** in `extension/manifest.json` (semver; the update checker
   compares these numbers).
2. **Build:** `./scripts/package.sh` → `dist/voter-v<version>.zip` (contents at
   top level, so unzipping gives a Load-unpacked-ready folder).
3. **Release:** tag `v<version>` (must match the manifest version), attach the zip.
   ```sh
   gh release create v<version> dist/voter-v<version>.zip \
     --title "NerdServers Voter v<version>" --notes "…"
   ``` Within ~12h (or immediately if a player clicks "Check for updates" in
the popup) players on older versions get an "Update available" notification linking
to the release page.

## How the update check works

- On install/startup and every 12h, the background worker calls the GitHub
  Releases API (`/releases/latest`), unauthenticated, read-only.
- If the latest tag > installed `manifest.version`, it notifies once and the popup
  shows an "Update available" banner linking to the release. Clicking either opens
  the release page to download the new zip.
- Players then re-unzip and reload the extension (load-unpacked can't self-update
  the code — this just makes sure nobody is silently stuck on a stale version).

## Notes

- Keep the manifest `version` and the release **tag** in lockstep, or the checker
  will misjudge who's up to date.
- GitHub's unauthenticated API allows 60 req/hr per IP — far above what one
  player's twice-daily check needs.
- If you ever need to force everyone off a broken build, publish a new release and
  the notification nudges them; there's no silent kill switch (by design — no
  central server).
