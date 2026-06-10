"""
Generate assets/icon.ico for CinematicAI Studio.
Requires Pillow (already in requirements.txt).
Run from project root: python scripts/create_icon.py
"""
import struct
import zlib
import math
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False


def draw_icon(size: int) -> "Image.Image":
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background circle — dark navy
    margin = max(2, size // 16)
    draw.ellipse(
        [margin, margin, size - margin, size - margin],
        fill=(14, 14, 24, 255),
        outline=(201, 168, 76, 255),
        width=max(1, size // 24),
    )

    cx, cy = size // 2, size // 2
    r = (size // 2) - margin - max(2, size // 12)

    # Film-reel spokes (6)
    spoke_w = max(1, size // 32)
    for i in range(6):
        angle = math.radians(i * 60)
        inner = r * 0.28
        outer = r * 0.72
        x1 = cx + inner * math.cos(angle)
        y1 = cy + inner * math.sin(angle)
        x2 = cx + outer * math.cos(angle)
        y2 = cy + outer * math.sin(angle)
        draw.line([(x1, y1), (x2, y2)], fill=(201, 168, 76, 200), width=spoke_w)

    # Centre hub
    hub_r = max(2, int(r * 0.22))
    draw.ellipse(
        [cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r],
        fill=(201, 168, 76, 255),
    )

    # Outer ring
    ring_w = max(1, size // 20)
    draw.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        outline=(201, 168, 76, 255),
        width=ring_w,
    )

    # Sprocket holes — 8 small circles on the outer ring
    hole_r = max(1, size // 22)
    for i in range(8):
        angle = math.radians(i * 45)
        hx = cx + r * 0.85 * math.cos(angle)
        hy = cy + r * 0.85 * math.sin(angle)
        draw.ellipse(
            [hx - hole_r, hy - hole_r, hx + hole_r, hy + hole_r],
            fill=(14, 14, 24, 255),
            outline=(201, 168, 76, 180),
            width=max(1, size // 48),
        )

    return img


def save_ico(path: str):
    sizes = [16, 32, 48, 64, 128, 256]
    images = [draw_icon(s) for s in sizes]

    # Build ICO manually so we don't need the Windows-only ICO encoder
    entries = []
    image_data = []
    offset = 6 + 16 * len(sizes)  # ICONDIR + ICONDIRENTRY * n

    for img in images:
        w, h = img.size
        # Convert to raw BGRA bytes via PNG then re-encode as raw BMP DIB
        # Easier: save as PNG inside ICO (Windows Vista+ supports PNG ICO)
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()

        entries.append({
            "width":  w if w < 256 else 0,
            "height": h if h < 256 else 0,
            "color_count": 0,
            "reserved": 0,
            "planes": 1,
            "bit_count": 32,
            "size": len(data),
            "offset": offset,
        })
        image_data.append(data)
        offset += len(data)

    with open(path, "wb") as f:
        # ICONDIR
        f.write(struct.pack("<HHH", 0, 1, len(sizes)))
        # ICONDIRENTRY × n
        for e in entries:
            f.write(struct.pack(
                "<BBBBHHII",
                e["width"], e["height"], e["color_count"], e["reserved"],
                e["planes"], e["bit_count"], e["size"], e["offset"],
            ))
        # image blobs
        for data in image_data:
            f.write(data)

    print(f"[OK] Icon saved: {path}")


def save_png(path: str, size: int = 512):
    img = draw_icon(size)
    img.save(path, format="PNG")
    print(f"[OK] PNG saved: {path}")


if __name__ == "__main__":
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets_dir = os.path.join(project_root, "assets")
    os.makedirs(assets_dir, exist_ok=True)

    if not HAS_PILLOW:
        print("[ERROR] Pillow not installed. Run: pip install pillow")
        sys.exit(1)

    save_ico(os.path.join(assets_dir, "icon.ico"))
    save_png(os.path.join(assets_dir, "icon.png"))

    # macOS ICNS placeholder (copy PNG — electron-builder accepts PNG for macOS too)
    import shutil
    shutil.copy(
        os.path.join(assets_dir, "icon.png"),
        os.path.join(assets_dir, "icon.icns"),
    )
    print("[OK] icon.icns (PNG copy) saved — replace with real ICNS for production macOS")
