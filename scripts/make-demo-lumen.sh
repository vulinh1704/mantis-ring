#!/usr/bin/env bash
# Builds demo/lumen, the sample repository the demo and the benchmark run on, from Mantis's
# buggy-app fixture (MIT, same author): a small marketing site with 13 planted UI bugs.
# The PLANTED.json answer key and every comment that hints at a bug are stripped, so the agent
# starts from the same blind position as a real repository. The answer key stays in Mantis.
# Usage: bash scripts/make-demo-lumen.sh [path to the mantis repo, default ../mantis]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$(cd "${1:-$here/../mantis}/fixtures/buggy-app" && pwd)"
dest="$here/demo/lumen"
rm -rf "$dest" && mkdir -p "$dest" && cp -r "$src"/. "$dest"/
cd "$dest"
rm -f PLANTED.json
node -e '
const fs = require("fs"), path = require("path");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(".").filter((f) => /\.(css|js|html)$/.test(f))) {
  let t = fs.readFileSync(f, "utf8");
  t = t.replace(/\/\*[\s\S]*?\*\//g, (m) => (/PLANTED|bug/i.test(m) ? "" : m));
  t = t.replace(/<!--[\s\S]*?-->/g, (m) => (/PLANTED|bug/i.test(m) ? "" : m));
  t = t.replace(/^[ \t]*\/\/.*(PLANTED|bug).*$/gim, "");
  fs.writeFileSync(f, t);
}'
if grep -rqiE 'planted|\bbug' --include='*.css' --include='*.js' --include='*.html' . ; then echo "hints left in demo/lumen" >&2; exit 1; fi
echo "demo/lumen: $(find . -type f | wc -l) files from $(cd "$src/../.." && git describe --tags --always 2>/dev/null || echo mantis)"
