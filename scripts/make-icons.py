#!/usr/bin/env python3
"""Рисует иконки puuush: png для Linux, ico для Windows, icns для macOS.

Само приложение зависимостей не имеет — нужен только Electron. Этот скрипт
нужен один раз при сборке и требует numpy (pip install numpy).

PNG пишется через zlib, ICO и ICNS — контейнеры вокруг уже готовых PNG, без
 pillow и без внешних утилит, чтобы результат не зависел от того, что стоит
на машине сборки.

    python3 scripts/make-icons.py
"""
import os
import struct
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

# Фирменные цвета: синий в зелёный, как в интерфейсе приложения.
C1 = np.array([0x4A, 0x9E, 0xFF], dtype=np.float32)
C2 = np.array([0x00, 0xFF, 0xBE], dtype=np.float32)
WHITE = np.array([255.0, 255.0, 255.0], dtype=np.float32)

SS = 2  # рисуем вдвое крупнее и усредняем — получаем сглаженные края


def _sdf_round_box(u, v, r, margin=0.0):
    """Знаковое расстояние до скруглённого прямоугольника. <0 значит внутри."""
    half = 0.5 - margin
    dx = np.abs(u - 0.5) - (half - r)
    dy = np.abs(v - 0.5) - (half - r)
    outside = np.sqrt(np.maximum(dx, 0) ** 2 + np.maximum(dy, 0) ** 2)
    inside = np.minimum(np.maximum(dx, dy), 0.0)
    return outside + inside - r


def _glyph_mask(u, v):
    """Белая стрелка вверх «загрузка» в нормализованных координатах 0..1."""
    stem = (u >= 0.41) & (u <= 0.59) & (v >= 0.44) & (v <= 0.80)
    bar = (u >= 0.22) & (u <= 0.78) & (v >= 0.83) & (v <= 0.92)

    def side(p1, p2, p3):
        return ((p1[0] - p3[0]) * (p2[1] - p3[1]) -
                (p2[0] - p3[0]) * (p1[1] - p3[1]))

    a, b, c = (0.50, 0.17), (0.20, 0.50), (0.80, 0.50)
    d1, d2, d3 = side((u, v), a, b), side((u, v), b, c), side((u, v), c, a)
    tri = ~(((d1 < 0) | (d2 < 0) | (d3 < 0)) &
            ((d1 > 0) | (d2 > 0) | (d3 > 0)))

    return stem | bar | tri


def render(size, glyph_rgb=None, radius_ratio=0.22, margin=0.0):
    """RGBA-буфер размера size x size."""
    n = size * SS
    axis = (np.arange(n, dtype=np.float32) + 0.5) / n
    u, v = np.meshgrid(axis, axis)

    r = radius_ratio * (1 - 2 * margin)
    bg = _sdf_round_box(u, v, r, margin) <= 0
    glyph = _glyph_mask(u, v) & bg

    t = (u * 0.45 + v * 0.55)[..., None]
    rgb = C1 * (1 - t) + C2 * t
    rgb = np.where(glyph[..., None], glyph_rgb if glyph_rgb is not None else WHITE, rgb)
    alpha = bg.astype(np.float32)

    img = np.concatenate([rgb, alpha[..., None]], axis=-1)
    # Строка целиком идёт слева направо, поэтому раскладываем по осям
    # (SS, size) x (SS, size) — так усреднение попадает в настоящий квадрат.
    img = img.reshape(size, SS, size, SS, 4).mean(axis=(1, 3))
    # Альфа усредняется как доля покрытия 0..1 — разворачиваем обратно в 0..255.
    img[..., 3] *= 255.0
    return np.clip(img, 0, 255).astype(np.uint8).tobytes()


def png_bytes(rgba, size):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4]
                   for y in range(size))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def ico_bytes(images):
    """images: [(size, png_bytes), ...] — ICO с PNG внутри (Vista+)."""
    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII",
                               0 if size >= 256 else size,
                               0 if size >= 256 else size,
                               0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return header + entries + blobs


def icns_bytes(images):
    """images: [(os_type, png_bytes), ...]. Типы — размеры, которые понимает Finder."""
    body = b""
    for os_type, data in images:
        body += os_type + struct.pack(">I", len(data) + 8) + data
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    os.makedirs(ASSETS, exist_ok=True)
    made = []
    square = {}

    def square_png(size):
        if size not in square:
            square[size] = png_bytes(render(size), size)
        return square[size]

    # Иконка приложения: 1024 основа и уменьшенные копии.
    for size in (1024, 512, 256, 128, 64, 48, 32):
        name = "icon.png" if size == 1024 else f"icon-{size}.png"
        path = os.path.join(ASSETS, name)
        with open(path, "wb") as f:
            f.write(square_png(size))
        made.append(path)

    # ico для Windows.
    ico = ico_bytes([(s, square_png(s)) for s in (16, 24, 32, 48, 64, 128, 256)])
    ico_path = os.path.join(ASSETS, "icon.ico")
    with open(ico_path, "wb") as f:
        f.write(ico)
    made.append(ico_path)

    # icns для macOS: типы соответствуют размерам, которые понимает Finder.
    icns_map = [b"icp4", b"icp5", b"icp6", b"ic07", b"ic08",
                b"ic09", b"ic10", b"ic11", b"ic12", b"ic13", b"ic14"]
    icns_sizes = [16, 32, 64, 128, 256, 512, 1024, 32, 64, 256, 512]
    icns = icns_bytes(list(zip(icns_map, (square_png(s) for s in icns_sizes))))
    icns_path = os.path.join(ASSETS, "icon.icns")
    with open(icns_path, "wb") as f:
        f.write(icns)
    made.append(icns_path)

    # Трей. На macOS шаблонная картинка чёрная — система перекрасит сама.
    for name, size, kwargs in (
        ("tray.png", 32, dict(radius_ratio=0.24)),
        ("trayTemplate.png", 44, dict(glyph_rgb=np.zeros(3, np.float32),
                                      radius_ratio=0.0, margin=0.06)),
    ):
        path = os.path.join(ASSETS, name)
        with open(path, "wb") as f:
            f.write(png_bytes(render(size, **kwargs), size))
        made.append(path)

    for p in made:
        print(f"{os.path.getsize(p):>8}  {os.path.relpath(p, os.path.dirname(HERE))}")


if __name__ == "__main__":
    main()