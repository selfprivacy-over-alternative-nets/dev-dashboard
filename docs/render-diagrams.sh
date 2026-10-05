#!/usr/bin/env bash
# Render docs/*.puml -> docs/*.svg DETERMINISTICALLY, using a PINNED plantuml (+ its JRE/graphviz)
# via nix — so a local render and the CI render produce byte-identical output. This one script is the
# single source of truth, used by both the pre-commit hook (.githooks/pre-commit) and the diagrams CI
# workflow (.github/workflows/diagrams.yml). No global plantuml/Java install needed.
#
#   bash docs/render-diagrams.sh          # render every docs/*.puml
#
# Pin: the same nixpkgs rev the backend builds from, so the plantuml version never drifts.
set -euo pipefail
NIXPKGS=${NIXPKGS:-github:NixOS/nixpkgs/23d72dabcb3b12469f57b37170fcbc1789bd7457}
DOCS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

shopt -s nullglob
pumls=("$DOCS"/*.puml)
if [ ${#pumls[@]} -eq 0 ]; then echo "no .puml files in $DOCS — nothing to render"; exit 0; fi

echo "rendering ${#pumls[@]} diagram(s) with pinned plantuml ($NIXPKGS)…"
nix --extra-experimental-features 'nix-command flakes' run "$NIXPKGS#plantuml" -- \
  -tsvg -nometadata -o "$DOCS" "${pumls[@]}"
echo "done → $DOCS/*.svg"
