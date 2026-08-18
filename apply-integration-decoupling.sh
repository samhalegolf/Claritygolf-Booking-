#!/usr/bin/env bash
#
# Applies the integration decoupling refactor.
#
# Run from the repo root (the folder containing `source/`), with
# integration-decoupling.tgz sitting beside this script:
#
#     bash apply-integration-decoupling.sh
#
# What it does, in order:
#   1. git mv the nine files that moved, so history follows them
#   2. unpack the new/rewritten files over the top
#   3. patch four one-line references the tarball doesn't cover
#   4. verify every file against the checksums this was built from
#
# It refuses to start on a dirty tree, and every step is a git operation you
# can undo with `git checkout .` / `git reset --hard`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARBALL="$ROOT/integration-decoupling.tgz"
cd "$ROOT/source"

SHARED="netlify/functions/_shared"
INT="$SHARED/integrations"

# --- 0. safety ---------------------------------------------------------------
[ -f "$TARBALL" ] || { echo "✗ integration-decoupling.tgz not found beside this script."; exit 1; }
[ -d "$SHARED" ] || { echo "✗ Run this from the repo root (the folder containing source/)."; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is not clean. Commit or stash first — this touches 16 files."
  git status --short
  exit 1
fi

if [ -d "$INT" ]; then
  echo "✗ $INT already exists. Looks like this was applied already."
  exit 1
fi

echo "→ on branch $(git branch --show-current)"

# --- 1. moves ----------------------------------------------------------------
# git mv rather than a plain copy so blame still reaches back through the
# rename. Nine files; the first three carried no Optix logic at all.
mkdir -p "$INT/providers"

git mv "$SHARED/optix-payload.mts"          "$INT/payload.mts"
git mv "$SHARED/optix-db.mts"               "$INT/db.mts"
git mv "$SHARED/external-providers.mts"     "$INT/registry.mts"
git mv "$SHARED/optix-origin.mts"           "$INT/ingest.mts"
git mv "$SHARED/optix-passes.mts"           "$INT/purchases.mts"
git mv "$SHARED/optix-inbound.test.mts"     "$INT/ingest.test.mts"
git mv "$SHARED/optix-passes.test.mts"      "$INT/purchases.test.mts"
git mv "$SHARED/optix-webhook-auth.mts"     "$INT/providers/optix-webhook-auth.mts"
git mv "$SHARED/optix-webhook-auth.test.mts" "$INT/providers/optix-webhook-auth.test.mts"

echo "→ 9 files moved"

# --- 2. contents -------------------------------------------------------------
# Overwrites the moved files with their rewritten contents and adds the two new
# ones (types.mts, providers/optix.mts).
tar xzf "$TARBALL"
echo "→ contents unpacked"

# --- 3. the four stragglers --------------------------------------------------
# One line each: two real imports, two stale comments. Not worth shipping whole
# files (booking-core.mts alone is 4,000 lines) for a single line apiece.
sed -i.bak 's|} from "./external-providers.mts";|} from "./integrations/registry.mts";|' \
  "$SHARED/external-reschedule.mts" "$SHARED/external-reschedule.test.mts"

sed -i.bak 's|see _shared/optix-db.mts|see _shared/integrations/db.mts|' \
  netlify/functions/billing-api.mts

sed -i.bak -e 's|EXTERNAL_BOOKING_SERVICE_ID in _shared/optix-origin.mts|EXTERNAL_BOOKING_SERVICE_ID in _shared/integrations/ingest.mts|' \
           -e 's|processStoredOptixEvent()|processStoredExternalEvent()|' \
  netlify/functions/booking-core.mts

# The test glob needs quoting or the shell expands it one level deep and the
# new nested tests are silently skipped — 29 of them, passing invisibly.
sed -i.bak 's|"test": "tsx --test netlify/functions/\*\*/\*.test.mts src/\*\*/\*.test.ts"|"test": "tsx --test \\"netlify/functions/**/*.test.mts\\" \\"src/**/*.test.ts\\""|' package.json

find . -name '*.bak' -not -path './node_modules/*' -delete 2>/dev/null || true
echo "→ 5 one-line patches applied"

# --- 4. verify ---------------------------------------------------------------
echo "→ verifying checksums"
FAIL=0
verify() {
  local want="$1" file="$2"
  local got
  got="$(md5sum "$file" 2>/dev/null | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "  ✗ $file"
    FAIL=1
  fi
}

verify 61e3af6cdcccce1dc3e0f9fe324f5a03 "$INT/db.mts"
verify 046dac041c9dd2922fc8d60279290aa5 "$INT/ingest.mts"
verify 26a63f4787688abe77f4cc1b009e75a6 "$INT/ingest.test.mts"
verify 0951c2b5cc325c3870f0b8f3b74f9d5a "$INT/payload.mts"
verify 5a648278c6ec0c65a264b01cd4bbcec1 "$INT/providers/optix-webhook-auth.mts"
verify 933b25fe91176dc00454a94b2321ca32 "$INT/providers/optix-webhook-auth.test.mts"
verify 112a8b8127b47667fce496bc23ea0515 "$INT/providers/optix.mts"
verify a68865dbcdf33703e656a304c4bd90d1 "$INT/purchases.mts"
verify 798afeb226541b412c84b4c304aecd8c "$INT/purchases.test.mts"
verify 24ad1b28b4022e745809806f5e167b49 "$INT/registry.mts"
verify 63af52b31e57f93bc1d74ccbdc6d2c99 "$INT/types.mts"
verify aa0da844f388224125e488cd7595770f netlify/functions/external-bookings.mts
verify 2b737caa212ab72e30946d8955222092 netlify/functions/optix-webhook.mts

if [ "$FAIL" = 1 ]; then
  echo "✗ Checksums do not match. Your tree differed from the one this was built"
  echo "  against. Run 'git status' to see what landed, or 'git reset --hard' to undo."
  exit 1
fi

# The nine that moved must be gone. The outbound transport files
# (optix-client, optix-book-resource, optix-cancel, optix-reconcile,
# optix-auto-select) stay put on purpose — those really are Optix-specific, so
# an Optix name is honest there.
for gone in optix-payload optix-db external-providers optix-origin optix-passes \
            optix-inbound.test optix-passes.test optix-webhook-auth optix-webhook-auth.test; do
  if [ -e "$SHARED/$gone.mts" ]; then
    echo "✗ $SHARED/$gone.mts should have moved but is still there."
    exit 1
  fi
done

echo "✓ Applied and verified."
echo
echo "Next:"
echo "    cd source && npm test          # expect 295 passing"
echo "    npm run typecheck"
echo
echo "Undo with:  git reset --hard && git clean -fd source/netlify/functions/_shared/integrations"
