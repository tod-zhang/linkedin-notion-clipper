"""Render the extension icons (icons/icon{16,32,48,128}.png). Requires Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw

BLUE = (10, 102, 194, 255)
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"


def render(size: int) -> Image.Image:
    s = 16  # supersample, then downscale for smooth edges
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=BLUE)

    # Bookmark ribbon
    left, right = n * 0.30, n * 0.70
    top, bottom = n * 0.20, n * 0.82
    notch = n * 0.64
    d.polygon(
        [(left, top), (right, top), (right, bottom), (n * 0.5, notch), (left, bottom)],
        fill=WHITE,
    )
    # Plus sign cut out of the ribbon
    cx, cy = n * 0.5, n * 0.41
    arm, w = n * 0.105, n * 0.045
    d.rectangle([cx - arm, cy - w, cx + arm, cy + w], fill=BLUE)
    d.rectangle([cx - w, cy - arm, cx + w, cy + arm], fill=BLUE)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        render(size).save(OUT / f"icon{size}.png")
        print(f"icons/icon{size}.png")
