#!/usr/bin/env bash
# Fetch and subset the Ember Hours webfonts (two-design-kit v0.2.0, tokens §2).
#
# Families (all SIL OFL, self-hosted, no remote font origin):
#   Mona Sans variable (wght 200-900, wdth pinned at 100) latin subset, preloaded;
#   Instrument Serif Italic 400 subset, display optional, never preloaded;
#   Fragment Mono 400 subset, display optional, never preloaded.
#
# Mona Sans starts from Google's exact latin subset (its sha256 is recorded in
# public/fonts/OFL-SOURCES.txt). The site never sets font-stretch, so the wdth
# axis is pinned at its default 100 with fontTools' instancer: same characters,
# OpenType features, metadata and glyph outlines at every weight, 98 KB -> 40 KB
# (OFL-FAQ 2.8 functional equivalence; fixes the PR #2032 LCP regression). Serif and
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
echo '5ea3740633e5ac7af56c13d7e8ec32bcae12e7723e53d34284469a8947ccb2f3  '"$TMP/mona.woff2" | sha256sum -c --quiet -

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
from fontTools.pens.recordingPen import RecordingPen
from fontTools.varLib import instancer

src = TTFont(f'{tmp}/mona.woff2')
axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in src['fvar'].axes}
assert axes.get('wght') == (200.0, 200.0, 900.0), axes
assert axes.get('wdth') == (75.0, 100.0, 125.0), axes
mona = instancer.instantiateVariableFont(TTFont(f'{tmp}/mona.woff2'), {'wdth': 100}, updateFontNames=False)
mona.flavor = 'woff2'
mona.recalcTimestamp = False  # keep upstream head.modified: reproducible bytes
mona.save(f'{tmp}/mona-wght.woff2')
mona = TTFont(f'{tmp}/mona-wght.woff2')
assert [a.axisTag for a in mona['fvar'].axes] == ['wght'], 'mona axes'
assert mona.getBestCmap() == src.getBestCmap(), 'mona character set'
for nid in (0, 1, 2, 3, 4, 5, 6, 13, 14):
    assert mona['name'].getDebugName(nid) == src['name'].getDebugName(nid), f'mona name {nid}'
assert mona['name'].getDebugName(1) == 'Mona Sans ExtraLight', 'mona family'
# Same outlines and advances as the original at width 100 for every used weight.
for wght in (200, 400, 600, 700, 900):
    a = instancer.instantiateVariableFont(TTFont(f'{tmp}/mona.woff2'), {'wdth': 100, 'wght': wght}).getGlyphSet()
    b = instancer.instantiateVariableFont(TTFont(f'{tmp}/mona-wght.woff2'), {'wght': wght}).getGlyphSet()
    for name in src.getGlyphOrder():
        pa, pb = RecordingPen(), RecordingPen()
        a[name].draw(pa)
        b[name].draw(pb)
        assert (pa.value, a[name].width) == (pb.value, b[name].width), f'mona glyph {name} at wght {wght}'

serif = TTFont(f'{tmp}/serif-small.woff2')
assert serif['name'].getDebugName(1) == 'Instrument Serif', 'serif family'
assert serif['name'].getDebugName(2) == 'Italic', 'serif style'

mono = TTFont(f'{tmp}/mono-small.woff2')
assert mono['name'].getDebugName(1) == 'Fragment Mono', 'mono family'
EOF

cp "$TMP/mona-wght.woff2" "$OUT/mona-sans-latin-wght.woff2"
cp "$TMP/serif-small.woff2" "$OUT/instrument-serif-latin-400-italic.woff2"
cp "$TMP/mono-small.woff2" "$OUT/fragment-mono-latin-400.woff2"

mona_bytes=$(wc -c <"$OUT/mona-sans-latin-wght.woff2")
serif_bytes=$(wc -c <"$OUT/instrument-serif-latin-400-italic.woff2")
mono_bytes=$(wc -c <"$OUT/fragment-mono-latin-400.woff2")
# Budgets: Mona Sans <= 40 KiB preloaded (was 98 KB with the unused wdth axis);
# serif and mono subsets < 12 KB.
[ "$mona_bytes" -le 40960 ] || { echo "mona $mona_bytes B over budget" >&2; exit 1; }
[ "$serif_bytes" -lt 12288 ] || { echo "serif $serif_bytes B over budget" >&2; exit 1; }
[ "$mono_bytes" -lt 12288 ] || { echo "mono $mono_bytes B over budget" >&2; exit 1; }
echo "mona-sans-latin-wght.woff2 $mona_bytes B"
echo "instrument-serif-latin-400-italic.woff2 $serif_bytes B"
echo "fragment-mono-latin-400.woff2 $mono_bytes B"
sha256sum "$OUT"/mona-sans-latin-wght.woff2 "$OUT"/instrument-serif-latin-400-italic.woff2 "$OUT"/fragment-mono-latin-400.woff2
