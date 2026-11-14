#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_icons.py —— 生成 PWA 图标（192/512 + apple-touch 180 + maskable 512）

「试卷批改」主题：米色纸底 + 墨色衬线 PHP 字样 + 红笔批注点缀。
仅本地生成一次，产物入库（icons/），明文无关。
"""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'icons')
os.makedirs(OUT, exist_ok=True)

PAPER = (246, 241, 227, 255)     # 米色纸
INK = (43, 37, 25, 255)          # 墨色
RED = (143, 43, 31, 255)         # 红笔
LINE = (214, 205, 186, 255)

FONT_CANDIDATES = [
    '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 背景（maskable 需要满幅出血）
    if maskable:
        d.rectangle([0, 0, size, size], fill=PAPER)
        pad = int(size * 0.16)
    else:
        r = int(size * 0.22)
        d.rounded_rectangle([0, 0, size, size], radius=r, fill=PAPER)
        pad = int(size * 0.08)
    # 顶部红色批改条
    bar_h = max(3, int(size * 0.035))
    d.rectangle([pad, pad, size - pad, pad + bar_h], fill=RED)
    # PHP 字样
    f = load_font(int(size * 0.34))
    text = 'PHP'
    bbox = d.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = int(size * 0.40) - th // 2 - bbox[1]
    d.text((tx, ty), text, font=f, fill=INK)
    # 底部三条横线（答题卡意象）
    y = int(size * 0.74)
    line_w = size - 2 * pad
    for i in range(3):
        w = line_w if i < 2 else int(line_w * 0.62)
        d.rectangle([pad, y + i * int(size * 0.062), pad + w, y + i * int(size * 0.062) + max(2, int(size * 0.02))], fill=LINE)
    # 红勾
    check = [(int(size * 0.70), int(size * 0.80)), (int(size * 0.76), int(size * 0.86)), (int(size * 0.90), int(size * 0.68))]
    d.line(check, fill=RED, width=max(4, int(size * 0.045)))
    return img


for name, sz, maskable in [
    ('icon-192.png', 192, False),
    ('icon-512.png', 512, False),
    ('icon-maskable-512.png', 512, True),
    ('apple-touch-icon.png', 180, False),
]:
    img = draw_icon(sz, maskable)
    if name == 'apple-touch-icon.png':
        # iOS 不支持透明角标：铺实底
        bg = Image.new('RGB', (sz, sz), PAPER[:3])
        bg.paste(img, (0, 0), img)
        img = bg
    img.save(os.path.join(OUT, name))
    print('生成', name)
