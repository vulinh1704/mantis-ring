#!/usr/bin/env bash
# Builds demo/atlas, the admin-only bench sample, from the Atlas fixture of Mantis's agent benchmark
# (bench/fixtures/atlas in the mantis repo, MIT, same author, committed on 30 Oct 2026, before the
# event): a small invoicing app with 3 pages, in English and Vietnamese, light and dark, whose planted
# UI bugs mostly show only when a page renders (at 360px, in Vietnamese, or in dark mode). The fixture
# holds no hints. Its phone smoke test (scripts/check-ui.mjs), the `check:ui` script and the
# playwright devDependency are left out, so the copy that goes into a sandbox installs nothing and
# carries no test. The grader, bench/grade-atlas.mjs, runs on the host and never enters a sandbox.
# Usage: bash scripts/make-demo-atlas.sh [path to the mantis repo, default ../mantis]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$(cd "${1:-$here/../mantis}/bench/fixtures/atlas" && pwd)"
dest="$here/demo/atlas"
rm -rf "$dest" && mkdir -p "$dest" && cp -r "$src"/. "$dest"/
cd "$dest"
rm -rf scripts .mantis node_modules
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
delete pkg.devDependencies;
if (pkg.scripts) delete pkg.scripts["check:ui"];
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);'
if grep -rqiE 'planted|\bbug|check:ui|check-ui|playwright|mantis' --include='*.css' --include='*.js' --include='*.mjs' --include='*.html' --include='*.json' . ; then
  echo "hints or test hooks left in demo/atlas" >&2
  exit 1
fi
echo "demo/atlas: $(find . -type f | wc -l) files from $(cd "$src" && git log -1 --format='%h (%cs)' -- . 2>/dev/null || echo 'the mantis repo')"
