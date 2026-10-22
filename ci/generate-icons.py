"""Verify the checked-in Logo 1 brand set; it no longer generates any mark.

The polygon wordmark generator this file used to hold is retired: the site
ships the official Logo 1 vectors (public/logo.svg, public/favicon.svg) and
their renders (public/icons/*.png, public/og-1200x630.png) as checked-in
files. Regenerating the old mark would silently revert the brand, so this
script only verifies the set is present, well-formed and consistently sized.
Usage: python3 ci/generate-icons.py (exit 0 verifies, 1 reports a gap).
"""
from pathlib import Path
import math
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parent.parent / "public"

# W3C maskable minimum safe zone: a launcher may apply a circular mask of
# diameter 80% of the tile, so every mark pixel must sit inside r=0.8
# (normalised by the half-width) or the mark renders with its tips shaved.
MASKABLE_SAFE_RADIUS = 0.8
MASKABLE_TILE_RGB = (0x14, 0x11, 0x17)  # #141117 Ember tile

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


def _paeth(left, up, upper_left):
    prediction = left + up - upper_left
    pa, pb, pc = abs(prediction - left), abs(prediction - up), abs(prediction - upper_left)
    if pa <= pb and pa <= pc:
        return left
    return up if pb <= pc else upper_left


def maskable_mark_radius(path):
    """Max mark-pixel radius on a tile, in half-widths. Mark pixels are those
    differing from the Ember tile; raises ValueError on unexpected encoding."""
    data = path.read_bytes()
    if data[:8] != PNG_MAGIC:
        raise ValueError(f"{path.name}: not a PNG")
    width, height, bit_depth, color_type, _, _, interlace = struct.unpack(
        ">IIBBBBB", data[16:29]
    )
    if (bit_depth, interlace) != (8, 0) or color_type not in (2, 6):
        raise ValueError(f"{path.name}: want 8-bit RGB(A), non-interlaced")
    channels = 3 if color_type == 2 else 4
    raw = b""
    pos = 8
    while pos < len(data):
        (length, kind) = struct.unpack(">I4s", data[pos : pos + 8])
        if kind == b"IDAT":
            raw += data[pos + 8 : pos + 8 + length]
        pos += 12 + length
    pixels = zlib.decompress(raw)
    stride = width * channels
    if len(pixels) != (stride + 1) * height:
        raise ValueError(f"{path.name}: truncated IDAT")
    center = (width - 1) / 2.0
    worst = 0.0
    prev = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        selector = pixels[start]
        if selector not in (0, 1, 2, 3, 4):
            raise ValueError(f"{path.name}: bad filter {selector}")
        line = bytearray(pixels[start + 1 : start + 1 + stride])
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up = prev[i]
            upper_left = prev[i - channels] if i >= channels else 0
            if selector == 1:
                line[i] = (line[i] + left) & 255
            elif selector == 2:
                line[i] = (line[i] + up) & 255
            elif selector == 3:
                line[i] = (line[i] + ((left + up) >> 1)) & 255
            elif selector == 4:
                line[i] = (line[i] + _paeth(left, up, upper_left)) & 255
        for x in range(width):
            off = x * channels
            if (line[off], line[off + 1], line[off + 2]) != MASKABLE_TILE_RGB:
                worst = max(worst, math.hypot(x - center, y - center) / center)
        prev = line
    return worst


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
    maskable = ROOT / "icons/maskable-512.png"
    radius = None
    if maskable.is_file():
        try:
            radius = maskable_mark_radius(maskable)
        except ValueError as error:
            failures.append(str(error))
        else:
            if radius > MASKABLE_SAFE_RADIUS:
                failures.append(
                    f"icons/maskable-512.png: mark radius {radius:.3f} "
                    f"exceeds safe circle {MASKABLE_SAFE_RADIUS}"
                )
    if failures:
        print("\n".join(failures))
        return 1
    print(
        f"brand set OK: {len(SVG_FILES)} SVGs, {len(PNG_FILES)} PNGs, "
        f"maskable radius {radius:.3f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
