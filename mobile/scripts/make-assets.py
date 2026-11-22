#!/usr/bin/env python3
"""生成调度官手机端图标与启动图。

唯一图标来源：<repo>/plugin-build/icon.svg
（Marshal 蓝 #1F6FEB 底 + 三阶信号横条 + 顶灯圆点）。

用法：python3 scripts/make-assets.py
依赖：rsvg-convert（librsvg）、Pillow。
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent
SOURCE = REPO / "plugin-build" / "icon.svg"
BRAND = "#1F6FEB"
BRAND_RGB = (31, 111, 235)

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
NOTIFY_SIZES = {
    "drawable-mdpi": 24,
    "drawable-hdpi": 36,
    "drawable-xhdpi": 48,
    "drawable-xxhdpi": 72,
    "drawable-xxxhdpi": 96,
}


def glyph_markup() -> str:
    """从仓库 icon.svg 里取信号条与顶灯，不重新画图形。"""
    text = SOURCE.read_text(encoding="utf-8")
    path = re.search(r'<path\b[^>]*\bd="([^"]+)"', text)
    circle = re.search(
        r'<circle\b[^>]*\bcx="([\d.]+)"[^>]*\bcy="([\d.]+)"[^>]*\br="([\d.]+)"',
        text,
    )
    if not path or not circle:
        raise SystemExit(f"无法从 {SOURCE} 解析图标路径")
    cx, cy, radius = circle.groups()
    return (
        f'<path d="{path.group(1)}" fill="none" stroke="#FFFFFF" '
        'stroke-width="4" stroke-linecap="round"/>'
        f'<circle cx="{cx}" cy="{cy}" r="{radius}" fill="#FFFFFF"/>'
    )


GLYPH = glyph_markup()


def svg_tile(radius: int) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" '
        'width="64" height="64">'
        f'<rect width="64" height="64" rx="{radius}" fill="{BRAND}"/>'
        f"{GLYPH}</svg>"
    )


def svg_foreground() -> str:
    """Android 自适应图标前景：108dp 画布，图形落在 66% 安全区内。"""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" '
        'width="108" height="108">'
        '<g transform="translate(19.2 19.2) scale(1.0875)">'
        f"{GLYPH}</g></svg>"
    )


def svg_notify() -> str:
    """状态栏小图标：单色白，四周留白。"""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" '
        'width="64" height="64"><g transform="translate(9 9) scale(0.72)">'
        f"{GLYPH}</g></svg>"
    )


def svg_splash() -> str:
    """启动图：品牌蓝满铺 + 居中白色标记（与 iOS 启动画面一致）。"""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" '
        'width="1024" height="1024">'
        f'<rect width="1024" height="1024" fill="{BRAND}"/>'
        '<g transform="translate(272 272) scale(7.5)">'
        f"{GLYPH}</g></svg>"
    )


def render(svg: str, width: int, height: int) -> Image.Image:
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as handle:
        handle.write(svg)
        svg_path = Path(handle.name)
    png_path = svg_path.with_suffix(".png")
    try:
        subprocess.run(
            ["rsvg-convert", "-w", str(width), "-h", str(height), "-o", str(png_path), str(svg_path)],
            check=True,
        )
        with Image.open(png_path) as image:
            return image.convert("RGBA")
    finally:
        svg_path.unlink(missing_ok=True)
        png_path.unlink(missing_ok=True)


def flatten(image: Image.Image) -> Image.Image:
    """iOS 图标不能带透明通道：先铺品牌底再合成。"""
    canvas = Image.new("RGB", image.size, BRAND_RGB)
    canvas.paste(image, (0, 0), image)
    return canvas


def round_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask


def foreground(size: int) -> Image.Image:
    return render(svg_foreground(), size, size)


def write_android_paths() -> list[str]:
    written: list[str] = []
    res = ROOT / "android/app/src/main/res"
    if not res.exists():
        return written
    for folder, size in ANDROID_DENSITIES.items():
        target = res / folder
        target.mkdir(parents=True, exist_ok=True)
        legacy = render(svg_tile(14), size, size)
        legacy.save(target / "ic_launcher.png")
        rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        rounded.paste(legacy, (0, 0), round_mask(size))
        rounded.save(target / "ic_launcher_round.png")
        written += [str(target / "ic_launcher.png"), str(target / "ic_launcher_round.png")]
    for folder, size in FOREGROUND_SIZES.items():
        target = res / folder
        target.mkdir(parents=True, exist_ok=True)
        foreground(size).save(target / "ic_launcher_foreground.png")
        written.append(str(target / "ic_launcher_foreground.png"))
    for folder, size in NOTIFY_SIZES.items():
        target = res / folder
        target.mkdir(parents=True, exist_ok=True)
        render(svg_notify(), size, size).save(target / "ic_stat_notify.png")
        written.append(str(target / "ic_stat_notify.png"))
    for path in sorted(res.glob("drawable*/splash.png")):
        try:
            with Image.open(path) as existing:
                size = existing.size
        except OSError:
            continue
        flatten(render(svg_splash(), *size)).save(path)
        written.append(str(path))
    # 自适应图标背景色与启动画面底色统一为品牌蓝。
    color_xml = res / "values/ic_launcher_background.xml"
    color_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        '    <color name="ic_launcher_background">#1F6FEB</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    vector = res / "drawable/ic_launcher_background.xml"
    if vector.exists():
        text = vector.read_text(encoding="utf-8").replace("#94CEFD", BRAND)
        vector.write_text(text, encoding="utf-8")
    return written


def write_ios_assets() -> list[str]:
    written: list[str] = []
    assets = ROOT / "ios/App/App/Assets.xcassets"
    icon_dir = assets / "AppIcon.appiconset"
    if icon_dir.exists():
        target = icon_dir / "AppIcon-512@2x.png"
        flatten(render(svg_tile(0), 1024, 1024)).save(target)
        written.append(str(target))
    splash_dir = assets / "Splash.imageset"
    if splash_dir.exists():
        for target in sorted(splash_dir.glob("splash-2732x2732*.png")):
            flatten(render(svg_splash(), 2732, 2732)).save(target)
            written.append(str(target))
    notify_dir = assets / "NotifyIcon.imageset"
    if notify_dir.exists():
        for scale, name in ((1, "notify.png"), (2, "notify@2x.png"), (3, "notify@3x.png")):
            target = notify_dir / name
            render(svg_notify(), 24 * scale, 24 * scale).save(target)
            written.append(str(target))
    return written


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"缺少仓库图标：{SOURCE}")
    written = write_android_paths() + write_ios_assets()
    print(f"source: {os.path.relpath(SOURCE, ROOT)}")
    print(f"wrote {len(written)} assets")
    for path in written[:8]:
        print(" -", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
