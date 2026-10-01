"""Generate the temporary TWO wordmark and install icons without external assets."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent / "public"
BACKGROUND = (21, 23, 32)
INK = (245, 246, 251)
ACCENT = (163, 255, 18)
SHAPES = [
    (INK, [(30, 64), (59, 64), (59, 71), (49, 71), (49, 96), (40, 96), (40, 71), (30, 71)]),
    (INK, [(63, 64), (71, 64), (75, 84), (79, 71), (86, 71), (90, 84), (94, 64), (102, 64), (95, 96), (87, 96), (82, 82), (78, 96), (70, 96)]),
    (INK, [(106, 64), (130, 64), (130, 96), (106, 96)]),
    (BACKGROUND, [(114, 72), (122, 72), (122, 88), (114, 88)]),
    (ACCENT, [(65, 105), (95, 105), (95, 110), (65, 110)]),
]


def contains(x, y, polygon):
    inside = False
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
        previous = current
    return inside


def pixel(x, y):
    color = BACKGROUND
    for fill, polygon in SHAPES:
        if contains(x, y, polygon):
            color = fill
    return color


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel((x + dx) * 160 / size, (y + dy) * 160 / size)
                       for dx in (.125, .375, .625, .875) for dy in (.125, .375, .625, .875)]
            rows.extend(round(sum(color[c] for color in samples) / len(samples)) for c in range(3))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">',
       '<title>Together We Own</title>', '<rect width="160" height="160" fill="#151720"/>']
for fill, polygon in SHAPES:
    color = "#" + "".join(f"{c:02x}" for c in fill)
    points = " ".join(f"{x},{y}" for x, y in polygon)
    svg.append(f'<polygon points="{points}" fill="{color}"/>')
svg.append('</svg>')
(ROOT / "logo.svg").write_text("\n".join(svg) + "\n")
for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("maskable-512.png", 512), ("apple-touch-icon.png", 180)]:
    (ROOT / "icons" / name).write_bytes(png(size))
