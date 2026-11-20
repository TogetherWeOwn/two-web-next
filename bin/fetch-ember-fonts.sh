#!/usr/bin/env bash
# Fetch and subset the Ember Hours webfonts (two-design-kit v0.2.0, tokens §2).
#
# Families (all SIL OFL, self-hosted, no remote font origin):
#   Mona Sans variable (wght 200-900) latin subset, preloaded;
#   Instrument Serif Italic 400 subset, display optional, never preloaded;
#   Fragment Mono 400 subset, display optional, never preloaded.
#
# Mona Sans ships as Google's exact latin subset bytes for the weight-only
# family (css2 family=Mona+Sans:wght@200..900; the sha256 in
# public/fonts/OFL-SOURCES.txt matches the gstatic URL below). The site never
# sets font-stretch, so the wdth 75-125 axis file (98 KB) is not needed: this
# one is 40 KB with identical glyphs at width 100 (fixes the PR #2032 LCP
# regression). Serif and mono are re-subset with pyftsubset to meet the kit's < 12 KB budgets; the
# set is ASCII printable + nbsp + smart punctuation + euro + trademark.
# Arrows stay out of the serif/mono subsets, keeping prior system rendering.
#
# Usage: bash bin/fetch-ember-fonts.sh   (writes public/fonts/*.woff2)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MONA_URL='https://fonts.gstatic.com/s/monasans/v4/o-0bIpQmx24alC5A4PNB6Ryti20_6n1iPHjc5a7duw.woff2'
SERIF_URL='https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7M.woff2'
MONO_URL='https://fonts.gstatic.com/s/fragmentmono/v6/4iCr6K5wfMRRjxp0DA6-2CLnB4NHhg.woff2'
# ASCII printable + nbsp + en/em dash + smart quotes + ellipsis + euro + tm.
SMALL_SUBSET='U+0020-007E,U+00A0,U+2013-2014,U+2018-2019,U+201C-201D,U+2026,U+20AC,U+2122'

curl -fsSL -o "$TMP/mona.woff2" "$MONA_URL"
echo 'a59061e38c5e7e6a00aaa6b6645a220c7d9c530991167f058cc0f8575f5d5844  '"$TMP/mona.woff2" | sha256sum -c --quiet -
curl -fsSL -o "$TMP/serif.woff2" "$SERIF_URL"
curl -fsSL -o "$TMP/mono.woff2" "$MONO_URL"

# The serif/mono subset bytes depend on the toolchain (another fontTools
# release passes every check below but writes different bytes), so require the
# exact versions.
command -v pyftsubset >/dev/null || {
  echo 'fetch-ember-fonts: pyftsubset not found (pip install fonttools==4.68.0 brotli==1.2.1)' >&2
  exit 2
}
python3 -c 'import brotli, fontTools, sys; sys.exit(0 if (fontTools.version, brotli.__version__) == ("4.68.0", "1.2.1") else 1)' || {
  echo 'fetch-ember-fonts: needs fonttools==4.68.0 and brotli==1.2.1' >&2
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
assert axes == {'wght': (200.0, 200.0, 900.0)}, axes
assert mona['name'].getDebugName(1) == 'Mona Sans ExtraLight', 'mona family'

serif = TTFont(f'{tmp}/serif-small.woff2')
assert serif['name'].getDebugName(1) == 'Instrument Serif', 'serif family'
assert serif['name'].getDebugName(2) == 'Italic', 'serif style'

mono = TTFont(f'{tmp}/mono-small.woff2')
assert mono['name'].getDebugName(1) == 'Fragment Mono', 'mono family'
EOF

# /fonts is served immutable: refuse to write bytes that differ from the pins.
sha256sum -c --quiet - <<SUMS
a59061e38c5e7e6a00aaa6b6645a220c7d9c530991167f058cc0f8575f5d5844  $TMP/mona.woff2
2ea8887dec935b5a45ba939c463d9733fc3f6c465c30ae6881b8c331a9a1dece  $TMP/serif-small.woff2
d1c6a317e267c5db61bf1744a774d65ffe5258bdd6ffcc678db482ef50b490b4  $TMP/mono-small.woff2
SUMS

cp "$TMP/mona.woff2" "$OUT/mona-sans-latin-wght.woff2"
cp "$TMP/serif-small.woff2" "$OUT/instrument-serif-latin-400-italic.woff2"
cp "$TMP/mono-small.woff2" "$OUT/fragment-mono-latin-400.woff2"

mona_bytes=$(wc -c <"$OUT/mona-sans-latin-wght.woff2")
serif_bytes=$(wc -c <"$OUT/instrument-serif-latin-400-italic.woff2")
mono_bytes=$(wc -c <"$OUT/fragment-mono-latin-400.woff2")
# Budgets: Mona Sans <= 40 KiB preloaded (the wdth-axis file was 98 KB);
# serif and mono subsets < 12 KB.
[ "$mona_bytes" -le 40960 ] || { echo "mona $mona_bytes B over budget" >&2; exit 1; }
[ "$serif_bytes" -lt 12288 ] || { echo "serif $serif_bytes B over budget" >&2; exit 1; }
[ "$mono_bytes" -lt 12288 ] || { echo "mono $mono_bytes B over budget" >&2; exit 1; }
echo "mona-sans-latin-wght.woff2 $mona_bytes B"
echo "instrument-serif-latin-400-italic.woff2 $serif_bytes B"
echo "fragment-mono-latin-400.woff2 $mono_bytes B"
sha256sum "$OUT"/mona-sans-latin-wght.woff2 "$OUT"/instrument-serif-latin-400-italic.woff2 "$OUT"/fragment-mono-latin-400.woff2
