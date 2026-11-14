#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_offline.py —— 生成单文件离线版（phpquiz离线版.html）

把 css/style.css、js/core.js、js/app.js、js/secure.js 全部内联进一个 HTML，
发送到手机后无需网络即可使用（解密在本机完成，密码仍是进站门槛）。
产物含 AES 密文，不进仓库（.gitignore）。
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(os.path.dirname(ROOT), 'phpquiz离线版.html')


def read(*parts):
    return open(os.path.join(ROOT, *parts), encoding='utf-8').read()


def safe_js(src):
    """内联进 <script> 前的处理：防止源码中出现 </script> 提前闭合标签。
    JS 字符串/正则中 \\/ 与 / 等价，替换不影响语义；仅处理真实出现的情况。"""
    if '</script' not in src.lower():
        return src
    return re.sub(r'</script', r'<\\/script', src, flags=re.IGNORECASE)


def main():
    html = read('index.html')
    css = read('css', 'style.css')
    core = read('js', 'core.js')
    app = read('js', 'app.js')
    secure = read('js', 'secure.js')

    # 1) 内联样式
    html = html.replace(
        '<link rel="stylesheet" href="css/style.css">',
        '<style>\n' + css + '\n</style>')
    assert 'href="css/style.css"' not in html, '样式未完全内联'

    # 2) 去掉 PWA 引用（单文件无意义）：manifest / 图标 / SW 注册脚本
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', '', html)
    html = re.sub(r'\s*<link rel="apple-touch-icon"[^>]*>', '', html)
    html = re.sub(r'\s*<meta name="mobile-web-app-capable"[^>]*>', '', html)
    html = re.sub(r'\s*<meta name="apple-mobile-web-app[^"]*"[^>]*>', '', html)
    html = re.sub(r'\s*<script>\s*\n?\s*/\* PWA 离线支持[\s\S]*?</script>', '', html)

    # 3) 内联三个脚本
    html = html.replace('<script src="js/secure.js"></script>',
                        '<script>\n/* secure.js —— 加密题库+知识库+作业实验（密文） */\n' + secure + '\n</script>')
    html = html.replace('<script src="js/core.js"></script>',
                        '<script>\n' + safe_js(core) + '\n</script>')
    html = html.replace('<script src="js/app.js"></script>',
                        '<script>\n' + safe_js(app) + '\n</script>')
    assert 'src="js/' not in html, '脚本未完全内联'

    # 4) 头部标注
    html = html.replace('<title>PHP程序设计 · 学生自主答题</title>',
                        '<title>PHP答题 · 离线版</title>\n'
                        '  <meta name="format-detection" content="telephone=no">')

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print(f'已生成 {OUT}（{size/1024:.0f} KB）')
    # 自检：无外链引用
    ext = re.findall(r'(?:src|href)="(?!data:)([^"]+)"', html)
    ext = [e for e in ext if not e.startswith('#')]
    print('剩余外链:', ext if ext else '无（完全自包含）')


if __name__ == '__main__':
    main()
