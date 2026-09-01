#!/usr/bin/env python3
"""
把 ~/Downloads/小说样本 中【已解析】的 45 本 txt 移入废纸篓。
- 保留：5 个 zip 容器 + 1 本未解析乱码《网游之混沌至尊》
- 机制：优先 trash CLI → 其次 Finder AppleScript → 兜底 mv 到 ~/.Trash
- 每批 ≤10 个，逐批校验
"""
import json, shutil, subprocess, os, sys
from pathlib import Path

SRC = Path.home() / "Downloads" / "小说样本"
CORPUS = Path("/Users/apple/Downloads/writer-simulator 2/baidu_corpus.json")
KEEP = {"网游之混沌至尊.txt"}

corpus = json.loads(CORPUS.read_text(encoding="utf-8"))

def norm(s):
    for ch in ("《", "》", " ", "　", "（", "）", "(2)"):
        s = s.replace(ch, "")
    return s

key_norm = {norm(k) for k in corpus.keys()} | {k for k in corpus.keys()}

targets = []
for p in sorted(SRC.iterdir()):
    if p.suffix.lower() != ".txt":
        continue
    if p.name in KEEP:
        continue
    stem = p.stem
    hit = (norm(stem) in key_norm or stem in key_norm
           or any(k in stem or stem in k for k in key_norm if len(k) >= 2))
    if hit:
        targets.append(p)

print(f"🎯 待移入废纸篓: {len(targets)} 个 txt")
print(f"   保留: {KEEP} + 5 个 zip\n")

use_cli = shutil.which("trash") is not None
print(f"机制: {'trash CLI' if use_cli else 'Finder AppleScript / ~/.Trash'}\n")

def via_cli(batch):
    return subprocess.run(["trash"] + [str(p) for p in batch],
                          capture_output=True, text=True)

def via_osascript(batch):
    items = ", ".join(
        'POSIX file "{}"'.format(str(p).replace("\\", "\\\\").replace('"', '\\"'))
        for p in batch)
    script = f'tell application "Finder" to delete {{{items}}}'
    return subprocess.run(["osascript", "-e", script],
                          capture_output=True, text=True)

def via_trashdir(batch):
    td = Path.home() / ".Trash"
    td.mkdir(exist_ok=True)
    for p in batch:
        dst = td / p.name
        n = 1
        while dst.exists():
            dst = td / f"{p.stem} ({n}){p.suffix}"
            n += 1
        shutil.move(str(p), str(dst))
    return subprocess.CompletedProcess([], 0, "", "")

ok, fail = [], []
for i in range(0, len(targets), 10):
    batch = targets[i:i + 10]
    r = via_cli(batch) if use_cli else via_osascript(batch)
    if r.returncode != 0:
        print(f"   ↻ 第 {i//10+1} 批主机制失败，用 ~/.Trash 兜底")
        r = via_trashdir(batch)
    if r.returncode != 0:
        print(f"   ❌ 第 {i//10+1} 批失败: {r.stderr[:200]}")
        fail.extend(p.name for p in batch)
        continue
    still = [p.name for p in batch if p.exists()]
    if still:
        print(f"   ❌ 第 {i//10+1} 批仍有残留: {still}")
        fail.extend(still)
    else:
        print(f"   ✅ 第 {i//10+1} 批完成（{len(batch)} 个）")
        ok.extend(p.name for p in batch)

print(f"\n{'='*50}")
print(f"✅ 已移入废纸篓: {len(ok)} 个")
if fail:
    print(f"❌ 失败: {len(fail)} 个 -> {fail}")

left_txt = [p.name for p in SRC.iterdir() if p.suffix.lower() == ".txt"]
left_zip = [p.name for p in SRC.iterdir() if p.suffix.lower() == ".zip"]
print(f"\n样本目录剩余: txt {len(left_txt)} 个 -> {left_txt}")
print(f"              zip {len(left_zip)} 个")
