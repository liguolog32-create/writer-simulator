#!/usr/bin/env python3
"""
1) 核对 ~/Downloads/小说样本 中：已解析 / 未解析 / zip 容器 三类文件
2) 备份整个目录到 ~/Downloads/小说样本_备份_<日期>/
"""
import json, shutil, os
from pathlib import Path
from datetime import datetime

SRC = Path.home() / "Downloads" / "小说样本"
CORPUS = Path("/Users/apple/Downloads/writer-simulator 2/baidu_corpus.json")
stamp = datetime.now().strftime("%Y%m%d")
BACKUP = Path.home() / "Downloads" / f"小说样本_备份_{stamp}"

corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
keys = set(corpus.keys())

def norm(s):
    for ch in ("《", "》", " ", "　"):
        s = s.replace(ch, "")
    return s

key_norm = {norm(k) for k in keys}

txts = sorted([p for p in SRC.iterdir() if p.is_file() and p.suffix.lower() == ".txt"])
zips = sorted([p for p in SRC.iterdir() if p.is_file() and p.suffix.lower() == ".zip"])

parsed, unparsed = [], []
for p in txts:
    stem = norm(p.stem)
    hit = stem in key_norm or any(k in stem or stem in k for k in key_norm if len(k) >= 4)
    (parsed if hit else unparsed).append(p)

print(f"=== 盘点 {SRC} ===")
print(f"txt 总计: {len(txts)}")
print(f"  已解析(在语料库中): {len(parsed)}")
print(f"  未解析: {len(unparsed)}  -> {[p.name for p in unparsed]}")
print(f"zip 容器: {len(zips)}")

# 备份
BACKUP.mkdir(parents=True, exist_ok=True)
copied = 0
for p in txts + zips:
    dst = BACKUP / p.name
    if not dst.exists():
        shutil.copy2(p, dst)
        copied += 1
print(f"\n=== 备份 ===")
print(f"备份目录: {BACKUP}")
print(f"已复制 {copied} 个文件（共 {len(txts)+len(zips)} 个）")
print(f"备份后目录内文件数: {len(list(BACKUP.iterdir()))}")
