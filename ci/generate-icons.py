"""Verify the checked-in Logo 1 brand set; it no longer generates any mark.

The polygon wordmark generator this file used to hold is retired: the site
ships the official Logo 1 vectors (public/logo.svg, public/favicon.svg) and
their renders (public/icons/*.png, public/og-1200x630.png) as checked-in
files. Regenerating the old mark would silently revert the brand, so this
script only verifies the set is present, well-formed and consistently sized.
Usage: python3 ci/generate-icons.py (exit 0 verifies, 1 reports a gap).
"""
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parent.parent / "public"

SVG_FILES = ["logo.svg", "favicon.svg"]
# Raster set: (filename, width, height). The 32px icon is the PNG favicon
# fallback; 180/192/512 keep the install identity and manifest URLs.
PNG_FILES = [
    ("icons/icon-32.png", 32, 32),
    ("icons/apple-touch-icon.png", 180, 180),
    ("icons/icon-192.png", 192, 192),
    ("icons/icon-512.png", 512, 512),
    ("icons/maskable-512.png", 512, 512),
    ("og-1200x630.png", 1200, 630),
]

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_size(path):
    data = path.read_bytes()
    if data[:8] != PNG_MAGIC:
        raise ValueError(f"{path.name}: not a PNG")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def main():
    failures = []
    for name in SVG_FILES:
        path = ROOT / name
        if not path.is_file():
            failures.append(f"{name}: missing")
            continue
        text = path.read_text()
        if "<svg" not in text or "twoGrad" not in text:
            failures.append(f"{name}: not the Logo 1 mark")
    for name, width, height in PNG_FILES:
        path = ROOT / name
        if not path.is_file():
            failures.append(f"{name}: missing")
            continue
        try:
            actual = png_size(path)
        except ValueError as error:
            failures.append(str(error))
            continue
        if actual != (width, height):
            failures.append(f"{name}: {actual[0]}x{actual[1]}, want {width}x{height}")
    if failures:
        print("\n".join(failures))
        return 1
    print(f"brand set OK: {len(SVG_FILES)} SVGs, {len(PNG_FILES)} PNGs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
