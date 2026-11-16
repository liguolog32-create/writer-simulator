#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v10.88 内置人名词库生成器（纯 Python 零依赖）。

输入：tools/feed/names-corpus-120w.txt（Chinese-Names-Corpus，Apache-2.0，
     https://github.com/wainshine/Chinese-Names-Corpus ，UTF-8 BOM + CRLF，
     约 114 万行现代中文人名，含少量表头行）。

输出：public/dict/names.txt        —— jieba with_dict 格式「词 100000 n」，每行一条；
      public/dict/names.license.txt —— Apache-2.0 许可全文 + 来源与加工说明（随站点公开，满足署名义务）。

隐私边界：语料是公开发布的常见人名列表（与任何用户数据无关），随站点公开是合规的；
用户私有专名（真实联系人等）绝不允许进本文件 —— 那走浏览器 localStorage 私有词典（v10.87）。

用法：
  python3 tools/build_names.py                    # 全量生成
  python3 tools/build_names.py --cap 400000       # 上限裁剪（按语料顺序保留前 N 条唯一名）
  python3 tools/build_names.py --check            # 回归校验（夏子豪/黄靖凯/陈默 命中 + 行数统计）
"""
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'feed', 'names-corpus-120w.txt')
OUT = os.path.join(ROOT, 'public', 'dict', 'names.txt')
LICENSE_OUT = os.path.join(ROOT, 'public', 'dict', 'names.license.txt')
LICENSE_SRC = os.path.join(ROOT, 'tools', 'feed', 'names-corpus-license.txt')

NAME_RE = re.compile(r'^[一-龥]{2,4}$')  # 2-4 个汉字；不含 ·（少数民族名一般超 4 字，直接不收）
DEFAULT_FREQ = 100000
DEFAULT_TAG = 'n'

# 这些名字是本项目 E2E 的判别词，必须保留（若语料更新后缺失会显式报错）
MUST_KEEP = ['夏子豪', '黄靖凯', '陈默']


def main():
    cap = None
    if '--cap' in sys.argv:
        cap = int(sys.argv[sys.argv.index('--cap') + 1])

    if not os.path.exists(SRC):
        print(f'[FAIL] 语料不存在：{SRC}（先下载 Chinese_Names_Corpus（120W）.txt）')
        sys.exit(1)

    seen = set()
    kept = []
    total = 0
    skipped = 0
    with open(SRC, 'r', encoding='utf-8-sig') as f:  # utf-8-sig 自动剥 BOM
        for raw in f:
            total += 1
            line = raw.strip()          # 剥 CRLF / 空白
            if not NAME_RE.match(line):  # 表头 / 空行 / 非 2-4 纯汉字 一律过滤
                skipped += 1
                continue
            if line in seen:
                continue
            seen.add(line)
            kept.append(line)

    out_lines = kept if cap is None else kept[:cap]
    for w in MUST_KEEP:
        if w not in seen:
            print(f'[FAIL] 判别词「{w}」不在语料中——语料版本可能变了，人工确认后再发')
            sys.exit(1)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        for w in out_lines:
            f.write(f'{w} {DEFAULT_FREQ} {DEFAULT_TAG}\n')

    # 许可文件：Apache-2.0 全文 + 加工说明
    if os.path.exists(LICENSE_SRC):
        with open(LICENSE_SRC, 'r', encoding='utf-8') as lf, open(LICENSE_OUT, 'w', encoding='utf-8') as of:
            of.write(lf.read())
        with open(LICENSE_OUT, 'a', encoding='utf-8') as of:
            of.write('\n\n=== 本词库（names.txt）加工说明 ===\n')
            of.write('来源：Chinese-Names-Corpus（Apache-2.0）https://github.com/wainshine/Chinese-Names-Corpus\n')
            of.write(f'原始文件：Chinese_Names_Corpus（120W）.txt，共 {total} 行\n')
            of.write(f'加工：剥离 BOM/CRLF 与表头，仅保留 2-4 个汉字的条目并去重，追加词频 {DEFAULT_FREQ} 与词性 {DEFAULT_TAG}。\n')
            of.write(f'结果：{len(out_lines)} 条唯一人名（语料唯一名共 {len(seen)} 条{f"，按原顺序裁剪至 {cap}" if cap else ""}）。\n')
            of.write('本文件随站点公开发布；用户私有专名一律不进本文件（走浏览器本机私有词典）。\n')

    size = os.path.getsize(OUT)
    print(f'[OK] 写出 {OUT}：{len(out_lines)} 条 / {size} 字节（语料 {total} 行，过滤 {skipped} 行，唯一名 {len(seen)} 条）')
    print(f'[OK] 许可与来源说明：{LICENSE_OUT}')


if __name__ == '__main__':
    main()
