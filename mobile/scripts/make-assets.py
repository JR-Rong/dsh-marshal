#!/usr/bin/env python3
"""生成调度官手机端的图标与启动图（纯本地绘制，不依赖设计稿）。

用法：python3 scripts/make-assets.py
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BG = (21, 23, 25, 255)
ACCENT = (131, 199, 176, 255)
ACCENT_DARK = (79, 143, 123, 255)
INK = (15, 35, 28, 255)
FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"
GLYPH = "调"

ANDROID_DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
FOREGROUND_SIZES = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for index in range(4):
        try:
            return ImageFont.truetype(FONT_PATH, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default()


def gradient_tile(size: int, radius_ratio: float = 0.24) -> Image.Image:
    """带对角渐变的圆角方块。"""
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = gradient.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / max(1, (size - 1) * 2)
            pixels[x, y] = (
                round(ACCENT[0] * (1 - t) + ACCENT_DARK[0] * t),
                round(ACCENT[1] * (1 - t) + ACCENT_DARK[1] * t),
                round(ACCENT[2] * (1 - t) + ACCENT_DARK[2] * t),
                255,
            )
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * radius_ratio), fill=255)
    tile.paste(gradient, (0, 0), mask)
    return tile


def glyph_layer(size: int, scale: float = 0.62, color=INK) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    font = load_font(round(size * scale))
    box = draw.textbbox((0, 0), GLYPH, font=font)
    width, height = box[2] - box[0], box[3] - box[1]
    draw.text(((size - width) / 2 - box[0], (size - height) / 2 - box[1]), GLYPH, font=font, fill=color)
    return layer


def icon(size: int, *, rounded: bool, glyph_scale: float = 0.62, pad_ratio: float = 0.0) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG)
    inner = round(size * (1 - pad_ratio * 2))
    tile = gradient_tile(inner)
    glyph = glyph_layer(inner, glyph_scale)
    tile.alpha_composite(glyph)
    if rounded:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        square.paste(tile, (round(size * pad_ratio), round(size * pad_ratio)))
        result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        result.paste(square, (0, 0), mask)
        return result
    canvas.paste(tile, (round(size * pad_ratio), round(size * pad_ratio)))
    return canvas


def foreground(size: int) -> Image.Image:
    """自适应图标前景：安全区内放主图形。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = round(size * 0.52)
    tile = gradient_tile(inner)
    tile.alpha_composite(glyph_layer(inner, 0.62))
    offset = (size - inner) // 2
    canvas.alpha_composite(tile, (offset, offset))
    return canvas


def splash(width: int, height: int) -> Image.Image:
    canvas = Image.new("RGB", (width, height), BG[:3])
    base = min(width, height) * 0.22
    logo_size = max(96, round(base))
    tile = gradient_tile(logo_size)
    tile.alpha_composite(glyph_layer(logo_size, 0.62))
    canvas.paste(tile, ((width - logo_size) // 2, round(height * 0.4)), tile)
    draw = ImageDraw.Draw(canvas)
    font = load_font(max(14, round(logo_size * 0.17)))
    label = "调度官"
    box = draw.textbbox((0, 0), label, font=font)
    draw.text(((width - (box[2] - box[0])) / 2 - box[0], round(height * 0.4) + logo_size + logo_size * 0.12), label, font=font, fill=(147, 157, 168))
    return canvas


def android_assets() -> list[str]:
    written: list[str] = []
    res = ROOT / "android/app/src/main/res"
    if not res.exists():
        return written
    for folder, size in ANDROID_DENSITIES.items():
        target = res / folder
        target.mkdir(parents=True, exist_ok=True)
        icon(size, rounded=False).save(target / "ic_launcher.png")
        icon(size, rounded=True, pad_ratio=0.02).save(target / "ic_launcher_round.png")
        written += [str(target / "ic_launcher.png"), str(target / "ic_launcher_round.png")]
    for folder, size in FOREGROUND_SIZES.items():
        target = res / folder
        foreground(size).save(target / "ic_launcher_foreground.png")
        written.append(str(target / "ic_launcher_foreground.png"))
    for path in sorted(res.glob("drawable*/splash.png")):
        try:
            with Image.open(path) as existing:
                size = existing.size
        except OSError:
            continue
        splash(*size).save(path)
        written.append(str(path))
    return written


def ios_assets() -> list[str]:
    written: list[str] = []
    assets = ROOT / "ios/App/App/Assets.xcassets"
    icon_dir = assets / "AppIcon.appiconset"
    if icon_dir.exists():
        target = icon_dir / "AppIcon-512@2x.png"
        icon(1024, rounded=False).convert("RGB").save(target)
        written.append(str(target))
    splash_dir = assets / "Splash.imageset"
    if splash_dir.exists():
        for target in sorted(splash_dir.glob("splash-2732x2732*.png")):
            splash(2732, 2732).save(target)
            written.append(str(target))
    return written


def main() -> None:
    written = android_assets() + ios_assets()
    print(f"wrote {len(written)} android assets")
    for path in written[:6]:
        print(" -", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
