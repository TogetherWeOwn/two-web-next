#!/usr/bin/env bash
# Fetch and subset the Ember Hours webfonts (two-design-kit v0.2.0, tokens §2).
#
# Families (all SIL OFL, self-hosted, no remote font origin):
#   Mona Sans variable (wght 200-900, wdth 75-125) latin subset, preloaded;
#   Instrument Serif Italic 400 subset, display optional, never preloaded;
#   Fragment Mono 400 subset, display optional, never preloaded.
#
# Mona Sans ships as Google's exact latin subset bytes (auditable: the sha256
# in public/fonts/OFL-SOURCES.txt matches the gstatic URL below). Serif and
# mono are re-subset with pyftsubset to meet the kit's < 12 KB budgets; the
# set is ASCII printable + nbsp + smart punctuation + euro + trademark.
# Arrows stay out of every subset, keeping prior system rendering.
#
# Usage: bash bin/fetch-ember-fonts.sh   (writes public/fonts/*.woff2)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MONA_URL='https://fonts.gstatic.com/s/monasans/v4/o-0IIpQmx24alC5A4PNr5TRA.woff2'
SERIF_URL='https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7M.woff2'
MONO_URL='https://fonts.gstatic.com/s/fragmentmono/v6/4iCr6K5wfMRRjxp0DA6-2CLnB4NHhg.woff2'
# ASCII printable + nbsp + en/em dash + smart quotes + ellipsis + euro + tm.
SMALL_SUBSET='U+0020-007E,U+00A0,U+2013-2014,U+2018-2019,U+201C-201D,U+2026,U+20AC,U+2122'

curl -fsSL -o "$TMP/mona.woff2" "$MONA_URL"
curl -fsSL -o "$TMP/serif.woff2" "$SERIF_URL"
curl -fsSL -o "$TMP/mono.woff2" "$MONO_URL"

command -v pyftsubset >/dev/null || {
  echo 'fetch-ember-fonts: pyftsubset not found (pip install fonttools)' >&2
  exit 2
}
pyftsubset "$TMP/serif.woff2" --flavor=woff2 --no-hinting \
  --unicodes="$SMALL_SUBSET" --layout-features='*' \
  --output-file="$TMP/serif-small.woff2" >/dev/null
pyftsubset "$TMP/mono.woff2" --flavor=woff2 --no-hinting \
  --unicodes="$SMALL_SUBSET" --layout-features='*' \
  --output-file="$TMP/mono-small.woff2" >/dev/null

python3 - "$TMP" <<'EOF'
import sys
from fontTools.ttLib import TTFont

tmp = sys.argv[1]
mona = TTFont(f'{tmp}/mona.woff2')
axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in mona['fvar'].axes}
assert axes.get('wght') == (200.0, 200.0, 900.0), axes
assert axes.get('wdth') == (75.0, 100.0, 125.0), axes
assert mona['name'].getDebugName(1) == 'Mona Sans ExtraLight', 'mona family'

serif = TTFont(f'{tmp}/serif-small.woff2')
assert serif['name'].getDebugName(1) == 'Instrument Serif', 'serif family'
assert serif['name'].getDebugName(2) == 'Italic', 'serif style'

mono = TTFont(f'{tmp}/mono-small.woff2')
assert mono['name'].getDebugName(1) == 'Fragment Mono', 'mono family'
EOF

cp "$TMP/mona.woff2" "$OUT/mona-sans-latin-var.woff2"
cp "$TMP/serif-small.woff2" "$OUT/instrument-serif-latin-400-italic.woff2"
cp "$TMP/mono-small.woff2" "$OUT/fragment-mono-latin-400.woff2"

mona_bytes=$(wc -c <"$OUT/mona-sans-latin-var.woff2")
serif_bytes=$(wc -c <"$OUT/instrument-serif-latin-400-italic.woff2")
mono_bytes=$(wc -c <"$OUT/fragment-mono-latin-400.woff2")
# Kit budgets: Mona Sans ~98 KB preloaded; serif and mono subsets < 12 KB.
[ "$mona_bytes" -le 100352 ] || { echo "mona $mona_bytes B over budget" >&2; exit 1; }
[ "$serif_bytes" -lt 12288 ] || { echo "serif $serif_bytes B over budget" >&2; exit 1; }
[ "$mono_bytes" -lt 12288 ] || { echo "mono $mono_bytes B over budget" >&2; exit 1; }
echo "mona-sans-latin-var.woff2 $mona_bytes B"
echo "instrument-serif-latin-400-italic.woff2 $serif_bytes B"
echo "fragment-mono-latin-400.woff2 $mono_bytes B"
sha256sum "$OUT"/mona-sans-latin-var.woff2 "$OUT"/instrument-serif-latin-400-italic.woff2 "$OUT"/fragment-mono-latin-400.woff2
