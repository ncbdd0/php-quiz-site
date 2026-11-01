#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""encrypt_data.py —— 把明文题库/知识库加密为 js/secure.js

用途：仓库公开部署（GitHub Pages）时，题库与知识库不以明文出现。
访客拿到 js/secure.js 只是一段密文；密码正确的用户在浏览器里解密使用。

流程：
  1) 读取本地明文 js/data.js、js/notes.js、js/homework.js（由 parse_questions.py /
     parse_notes.py / parse_homework.py 生成，明文文件均已 .gitignore，不进入仓库）
  2) 密钥 = PBKDF2-HMAC-SHA256(密码, salt, rounds, 32字节)
  3) 每份负载独立随机 IV，AES-256-CTR 加密 → base64
  4) 输出 js/secure.js：window.SECURE_DATA = {v, salt, rounds,
     data:{iv,ct}, notes:{iv,ct}, homework:{iv,ct}}

用法：
  python3 tools/encrypt_data.py --password '你的密码'
  # 也可用 --in-data/--in-notes/--out 指定路径，--rounds 自定义轮数
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def extract_json_object(js_path, var_name):
    """从 `window.X = {...};` 或 `const X = {...};` 形式的 js 文件里提取 JSON 文本"""
    src = open(js_path, encoding='utf-8').read()
    m = re.search(r'(?:window\.)?' + var_name + r'\s*=\s*', src)
    if not m:
        raise SystemExit(f'{js_path} 中找不到 window.{var_name}')
    start = src.index('{', m.end())
    # 括号配平扫描（JSON 无转义外括号陷阱，直接计数即可）
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(src)):
        ch = src[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    else:
        raise SystemExit(f'{js_path} 中 window.{var_name} 括号未闭合')
    text = src[start:end]
    json.loads(text)   # 校验是合法 JSON
    return text


def aes256_ctr_encrypt(key_hex, iv_hex, data: bytes) -> bytes:
    """openssl AES-256-CTR（加密与解密同一操作）"""
    p = subprocess.run(
        ['openssl', 'enc', '-aes-256-ctr', '-nosalt',
         '-K', key_hex, '-iv', iv_hex],
        input=data, capture_output=True, check=True)
    return p.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--password', required=True)
    ap.add_argument('--in-data', default=os.path.join(ROOT, 'js', 'data.js'))
    ap.add_argument('--in-notes', default=os.path.join(ROOT, 'js', 'notes.js'))
    ap.add_argument('--in-homework', default=os.path.join(ROOT, 'js', 'homework.js'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'js', 'secure.js'))
    ap.add_argument('--rounds', type=int, default=20000)
    args = ap.parse_args()

    data_json = extract_json_object(args.in_data, 'QUIZ_DATA')
    notes_json = extract_json_object(args.in_notes, 'NOTES_DATA')
    hw_json = extract_json_object(args.in_homework, 'HOMEWORK_DATA')

    salt = secrets.token_hex(16)          # 16 字节盐
    iv_d = secrets.token_hex(16)          # 每份负载独立 16 字节 IV
    iv_n = secrets.token_hex(16)
    iv_h = secrets.token_hex(16)

    key = hashlib.pbkdf2_hmac('sha256', args.password.encode('utf-8'),
                              bytes.fromhex(salt), args.rounds, dklen=32)
    key_hex = key.hex()

    ct_d = base64.b64encode(
        aes256_ctr_encrypt(key_hex, iv_d, data_json.encode('utf-8'))).decode()
    ct_n = base64.b64encode(
        aes256_ctr_encrypt(key_hex, iv_n, notes_json.encode('utf-8'))).decode()
    ct_h = base64.b64encode(
        aes256_ctr_encrypt(key_hex, iv_h, hw_json.encode('utf-8'))).decode()

    enc = {
        'v': 1,
        'alg': 'PBKDF2-HMAC-SHA256 + AES-256-CTR',
        'salt': salt,
        'rounds': args.rounds,
        'data': {'iv': iv_d, 'ct': ct_d},
        'notes': {'iv': iv_n, 'ct': ct_n},
        'homework': {'iv': iv_h, 'ct': ct_h},
    }

    banner = (
        '/* ============================================================\n'
        ' * secure.js —— 加密题库 + 知识库（自动生成，勿手改）\n'
        ' * 生成：tools/encrypt_data.py  |  密码正确时由 core.js 解密\n'
        ' * 明文数据不存在于本仓库任何文件中。\n'
        ' * ============================================================ */\n'
    )
    payload = 'window.SECURE_DATA = ' + json.dumps(enc, ensure_ascii=False) + ';\n'
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(banner + payload)

    kb = len(payload) / 1024
    print(f'已生成 {args.out}（{kb:.0f} KB 密文）')
    print(f'  salt={salt}  rounds={args.rounds}')
    print(f'  data:  {len(data_json)/1024:.0f} KB 明文 -> {len(ct_d)/1024:.0f} KB 密文')
    print(f'  notes: {len(notes_json)/1024:.0f} KB 明文 -> {len(ct_n)/1024:.0f} KB 密文')
    print(f'  homework: {len(hw_json)/1024:.0f} KB 明文 -> {len(ct_h)/1024:.0f} KB 密文')


if __name__ == '__main__':
    main()
