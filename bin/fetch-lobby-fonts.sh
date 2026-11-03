#!/bin/sh
# Rebuild the Living Lobby self-hosted OFL subsets in public/fonts/.
# Design §3.2: Space Grotesk (display), Atkinson Hyperlegible (body),
# IBM Plex Mono (data), Source Serif 4 italic (records names).
# Sources are the upstream OFL releases in the google/fonts mirror;
# each input is sha256-verified below, then instanced (variable fonts)
# and subset to the Google Fonts "latin" unicode set as woff2.
# Nothing here is vendored: run this script and diff public/fonts/.
# Requires: curl, python3 with fonttools (for varLib + pyftsubset), brotli.
set -eu

ROOT="$(CDPATH= LC_ALL=C cd -- "$(dirname -- "$0")/.." && pwd)"
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT INT TERM
BASE="https://raw.githubusercontent.com/google/fonts/main/ofl"

fetch() { # $1=upstream-path $2=sha256 $3=dest-name
  curl -sSL -o "$SRC/$3" "$BASE/$1"
  printf '%s  %s\n' "$2" "$SRC/$3" | sha256sum -c - >/dev/null
}

fetch "spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf" \
  acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72 sg.ttf
fetch "atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf" \
  7fb917c89019896d0b52ee84b7cbb3304c18cb90b19a62f5e32712bd23e97669 atkinson400.ttf
fetch "atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf" \
  5a3b0c8cc8ca545155150b4512a1fa248298df121c50d6557e651e61fbdab92f atkinson700.ttf
fetch "ibmplexmono/IBMPlexMono-Regular.ttf" \
  6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46 plex400.ttf
fetch "ibmplexmono/IBMPlexMono-Medium.ttf" \
  a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755 plex500.ttf
fetch "sourceserif4/SourceSerif4-Italic%5Bopsz%2Cwght%5D.ttf" \
  15fbc7e4679489a501998c3669272637a6646388ef7e4bd77eebb5bf967a1f42 serif.ttf

python3 - "$SRC" <<'EOF'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

src = sys.argv[1]
# instantiateVariableFont returns the instance (inplace=False default):
# ignoring the return value silently ships the variable font.
jobs = [
    ("sg.ttf", {"wght": 500}, "sg500.ttf", 500),
    ("sg.ttf", {"wght": 700}, "sg700.ttf", 700),
    ("serif.ttf", {"wght": 600, "opsz": 24}, "serif600.ttf", 600),
]
for name, axes, out, weight in jobs:
    font = TTFont(f"{src}/{name}")
    instanced = instantiateVariableFont(font, axes, updateFontNames=True)
    assert "fvar" not in instanced, f"{out}: still variable"
    assert instanced["OS/2"].usWeightClass == weight, f"{out}: weight wrong"
    instanced.save(f"{src}/{out}")
print("instanced")
EOF

LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
subset() { # $1=input $2=output $3=layout-features
  pyftsubset "$SRC/$1" --output-file="$ROOT/public/fonts/$2" --flavor=woff2 \
    --unicodes="$LATIN" --layout-features="$3" \
    --no-hinting --desubroutinize
}

subset sg500.ttf space-grotesk-latin-500.woff2 '*'
subset sg700.ttf space-grotesk-latin-700.woff2 '*'
subset atkinson400.ttf atkinson-hyperlegible-latin-400.woff2 '*'
subset atkinson700.ttf atkinson-hyperlegible-latin-700.woff2 '*'
subset plex400.ttf ibm-plex-mono-latin-400.woff2 '*'
subset plex500.ttf ibm-plex-mono-latin-500.woff2 '*'
# Records serif is names only: kern+liga, full feature set not needed.
subset serif600.ttf source-serif-4-latin-600-italic.woff2 "kern,liga"

ls -la "$ROOT/public/fonts/"*.woff2
