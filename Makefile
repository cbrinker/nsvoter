# NerdServers Voter — build & release
#
#   make package          Build the distributable zip
#   make release          Push main, tag, and publish a GitHub release with the zip
#   make bump V=0.2.1     Set the extension version in manifest.json
#   make version          Print the current version
#   make check            Validate manifest.json
#   make clean            Remove dist/
#
# Release needs the GitHub CLI:  brew install gh && gh auth login

VERSION := $(shell grep -m1 '"version"' extension/manifest.json | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')
TAG     := v$(VERSION)
ZIP     := dist/voter-v$(VERSION).zip
NOTES   ?= Install: download the zip below, unzip it, then open chrome://extensions, enable Developer mode, and click "Load unpacked".

.PHONY: help version package release bump check clean

help:
	@echo "NerdServers Voter — current version $(VERSION)"
	@echo ""
	@echo "  make package        Build $(ZIP)"
	@echo "  make release        Push main, tag $(TAG), publish GitHub release + zip"
	@echo "  make bump V=X.Y.Z   Set the version in manifest.json"
	@echo "  make version        Print the current version"
	@echo "  make check          Validate manifest.json"
	@echo "  make clean          Remove dist/"

version:
	@echo $(VERSION)

check:
	@python3 -c "import json; json.load(open('extension/manifest.json'))" && echo "manifest.json OK"

package: check
	@./scripts/package.sh

# Publish a release. Guards against common mistakes before touching the remote.
release: package
	@command -v gh >/dev/null || { echo "error: gh not installed — run 'brew install gh && gh auth login'"; exit 1; }
	@gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated — run 'gh auth login'"; exit 1; }
	@if ! git diff --quiet || ! git diff --cached --quiet; then \
		echo "error: uncommitted changes — commit them so the release matches the code"; exit 1; fi
	@if gh release view $(TAG) >/dev/null 2>&1; then \
		echo "error: release $(TAG) already exists — 'make bump V=...' and commit first"; exit 1; fi
	git push origin main
	gh release create $(TAG) $(ZIP) --target main \
		--title "NerdServers Voter $(TAG)" \
		--notes "$(NOTES)"
	@echo "Released $(TAG)"

# macOS (BSD) sed in-place edit; sets only the manifest "version" field.
bump:
	@test -n "$(V)" || { echo "usage: make bump V=X.Y.Z"; exit 1; }
	@sed -i '' -E 's/("version"[[:space:]]*:[[:space:]]*)"[^"]+"/\1"$(V)"/' extension/manifest.json
	@echo "version -> $(V)  (commit manifest.json, then 'make release')"

clean:
	rm -rf dist
