#!/usr/bin/env bash
# check-living-docs.sh — grep ONLY the living docs for a term (Layer 3).
#
# Use before finishing any change that alters a fact/term/count/name: search for
# the OLD value AND the new one, and reconcile every hit. A fact usually lives in
# several living docs, and the drift happens when the "home" doc is updated but
# the echoes are not.
#
# Scope = living docs only. Point-in-time records (Docs/plans, audits, reports,
# deprecated, specs, mockups, reference) are deliberately frozen history and are
# NOT searched — never retro-edit them.
#
# Usage:  bash tools/check-living-docs.sh '<extended-regex>'
#   e.g.  bash tools/check-living-docs.sh '[0-9]+ (live |registered )?tools?'
#         bash tools/check-living-docs.sh 'FOSE'
set -euo pipefail

term="${1:?usage: bash tools/check-living-docs.sh '<extended-regex>'}"

# Resolve repo root from this script's location so it works from any cwd.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

grep -rnE --color=auto "$term" \
  CLAUDE.md \
  README.md \
  Docs/README.md \
  Docs/STATUS.md \
  Docs/FROZEN.md \
  Docs/GLOSSARY.md \
  Docs/core_philosophy.md \
  Docs/index.json \
  Docs/current-system/ \
  2>/dev/null || { echo "(no matches in living docs)"; exit 0; }
