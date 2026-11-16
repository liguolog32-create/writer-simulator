#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
投喂素材 -> 离线训练 -> 静态用户词典（jieba / jieba-wasm userdict 格式）

这是「用户主动投喂、WorkBuddy 侧训练」这一环的产出工具。全程离线、零第三方依赖，
不读取屏幕、不联网、不接触 Cloudflare。产物只有一个纯文本文件，供前端同源 fetch。

用法
----
  python3 tools/build_userdict.py
      扫描 tools/feed/ 下所有 *.txt，合并投喂词 + 统计发现的候选词，
      产出 public/dict/userdict.txt 与可审计的 tools/feed/_learned.json

  python3 tools/build_userdict.py --add "夏子豪 土木行业 HBM"
      在扫描结果之外，再追加命令行投喂的词（空格/逗号/换行分隔）

  python3 tools/build_userdict.py --feed /path/to/dir --add "新词"
      指定别的投喂目录（也可以是单个 .txt 文件）

  python3 tools/build_userdict.py --check
      不写文件，只用固定回归串检查当前词典是否覆盖预期词

投喂素材约定
------------
  tools/feed/*.words.txt   每行一个词 —— 显式词表，优先级最高、必定进入词典
  tools/feed/*.txt         其余视为自由文本 —— 做 n-gram 统计候选（见下方说明）
  tools/feed/_learned.json 是脚本自己的产出，不作为输入

关于「训练」的诚实说明
----------------------
屏幕 OCR 一屏只有几十字，PMI / 左右熵这类统计新词发现需要数千条语料才成立；
jieba 的 HMM 参数也是预训练固定的、没有重训 API。所以这里的训练是：
  1) 把用户显式投喂的词表直接写成词典条目（主路径，实测 167 字节即可修好专名碎裂）；
  2) 对自由文本做 2-4 字 n-gram 频次 + 左右邻接多样性统计，产出候选词（辅助路径，
     语料少于 MIN_CORPUS_CHARS 时自动跳过，避免把噪点当词）。
真正的「模型训练」不是本工具的目标；产出的是可审计、可 diff、可回滚的静态词表。

⚠️ 隐私边界
-----------
public/dict/userdict.txt 会随前端一起公开发布，任何访问站点的人都能下载它。
**只投喂通用词 / 领域术语**；人名、内部项目名、客户名这类私有实体不要放进
public/ 产出。若需要私有词，应改为「浏览器本机 localStorage 导入、不进构建产物」，
前端 jiebaSegmenter.ts 已有词典缺席容错，可平滑扩展。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEED_DIR = ROOT / "tools" / "feed"
OUT_DICT = ROOT / "public" / "dict" / "userdict.txt"
OUT_AUDIT = FEED_DIR / "_learned.json"

WORD_FREQ = 100000          # jieba userdict 词频：足够大，保证优先切出
WORD_TAG = "n"              # 词性占位（本工具不做词性标注）
MIN_CORPUS_CHARS = 2000     # 统计新词发现所需最小语料量
MIN_NGRAM_FREQ = 3          # 候选词最低出现次数
MIN_NEIGHBOR_VARIETY = 2    # 左右邻接字的最低多样性
MAX_STAT_WORDS = 120        # 统计候选词上限，防止词典膨胀

CJK_RUN_RE = re.compile(r"[\u4e00-\u9fa5]{2,}")
LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9.\-]{1,15}")
CJK_RE = re.compile(r"^[\u4e00-\u9fa5]{2,4}$")
LATIN_OK_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.\-]{1,15}$")

# 与 src/bot/nlpSlice.ts 的停用词/UI 黑名单保持同口径，避免把界面碎片学进词典
STOPWORDS = {
    "的", "了", "和", "在", "是", "有", "也", "就", "但", "还", "把", "被", "为",
    "不", "很", "更", "相当", "这种", "所谓", "无论", "一个", "可以", "什么",
    "怎么", "自己", "他们", "我们", "你们", "这", "那", "它", "与", "或", "及",
    "对", "从", "到", "把", "让", "给", "用", "以", "而", "且", "则", "已",
    "可能", "应该", "需要", "进行", "通过", "关于", "以及", "一些", "这个", "那个",
}
UI_WORDS = {
    "通讯录", "服务号", "资料库", "今日已领", "管理后台", "收藏夹", "所有书签",
    "文件传输助手", "正在共享", "屏幕", "窗口", "编辑", "显示", "帮助", "设置",
    "返回", "更多", "消息", "群聊", "公众号", "朋友圈", "发现", "连接", "加载",
    "切片", "采信", "未通过", "记下了", "看到了", "这一幕", "没有切出",
}

# 固定回归串：来自本项目真实 OCR 输出，用来验证词典是否真的修好碎裂
CHECK_SENTENCE = "造船被归为制造业 ， 但小镇觉得更像建筑业也就是土木行业 。 夏子豪和马斯克在聊HBM存储芯片"
CHECK_EXPECT = ["制造业", "建筑业", "土木行业", "存储芯片", "HBM"]


def read_texts(feed: Path) -> tuple[list[str], list[str], list[str]]:
    """返回 (显式词, 自由文本列表, 来源文件名列表)"""
    explicit: list[str] = []
    corpus: list[str] = []
    sources: list[str] = []
    paths = [feed] if feed.is_file() else sorted(feed.glob("*.txt"))
    for p in paths:
        if not p.is_file() or p.name == "_learned.json":
            continue
        try:
            body = p.read_text(encoding="utf-8", errors="ignore")
        except OSError as e:
            print(f"  [跳过] {p.name}: {e}", file=sys.stderr)
            continue
        sources.append(str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p))
        if ".words." in p.name or p.name.startswith("words"):
            for line in body.splitlines():
                w = line.strip().split()[0] if line.strip() else ""
                if w:
                    explicit.append(w)
        else:
            corpus.append(body)
    return explicit, corpus, sources


def normalize_word(w: str) -> str | None:
    w = (w or "").strip().strip(",，、;；\t")
    if not w or len(w) > 16:
        return None
    if w in STOPWORDS or w in UI_WORDS:
        return None
    if CJK_RE.match(w) or LATIN_OK_RE.match(w):
        return w
    return None


def mine_stat_words(corpus: list[str]) -> tuple[list[str], int]:
    """2-4 字 n-gram 频次 + 左右邻接多样性；语料不足时不做统计。"""
    text = "\n".join(corpus)
    chars = len(text)
    if chars < MIN_CORPUS_CHARS:
        return [], chars

    freq: Counter[str] = Counter()
    left: dict[str, set[str]] = {}
    right: dict[str, set[str]] = {}
    for run in CJK_RUN_RE.findall(text):
        for n in (2, 3, 4):
            for i in range(len(run) - n + 1):
                g = run[i : i + n]
                freq[g] += 1
                if i > 0:
                    left.setdefault(g, set()).add(run[i - 1])
                if i + n < len(run):
                    right.setdefault(g, set()).add(run[i + n])
    for w in LATIN_RE.findall(text):
        freq[w] += 1

    candidates: list[tuple[int, str]] = []
    for w, n in freq.items():
        if n < MIN_NGRAM_FREQ or not normalize_word(w):
            continue
        # 中文词要求左右邻字有一定多样性（避免总是长词的一个固定切片）
        if CJK_RE.match(w):
            if len(left.get(w, set())) < MIN_NEIGHBOR_VARIETY and len(right.get(w, set())) < MIN_NEIGHBOR_VARIETY:
                continue
        candidates.append((n, w))
    candidates.sort(key=lambda x: (-x[0], -len(x[1]), x[1]))
    return [w for _, w in candidates[:MAX_STAT_WORDS]], chars


def build(explicit: list[str], corpus: list[str], sources: list[str]) -> dict:
    stat_words, corpus_chars = mine_stat_words(corpus)
    words: list[str] = []
    seen: set[str] = set()
    origin: dict[str, str] = {}
    for w in explicit:
        n = normalize_word(w)
        if n and n not in seen:
            seen.add(n)
            words.append(n)
            origin[n] = "explicit"
    for w in stat_words:
        n = normalize_word(w)
        if n and n not in seen:
            seen.add(n)
            words.append(n)
            origin[n] = "statistical"

    OUT_DICT.parent.mkdir(parents=True, exist_ok=True)
    OUT_DICT.write_text(
        "".join(f"{w} {WORD_FREQ} {WORD_TAG}\n" for w in words),
        encoding="utf-8",
    )
    audit = {
        "version": 1,
        "sources": sources,
        "corpus_chars": corpus_chars,
        "stat_discovery": "on" if corpus_chars >= MIN_CORPUS_CHARS else "off (corpus too small)",
        "words": [{"word": w, "origin": origin[w]} for w in words],
    }
    FEED_DIR.mkdir(parents=True, exist_ok=True)
    OUT_AUDIT.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return audit


def check() -> int:
    if not OUT_DICT.exists():
        print("FAIL: 词典不存在，请先运行 build_userdict.py")
        return 1
    body = OUT_DICT.read_text(encoding="utf-8")
    words = {line.split()[0] for line in body.splitlines() if line.strip() and not line.startswith("<")}
    missing = [w for w in CHECK_EXPECT if w not in words]
    print(f"回归串: {CHECK_SENTENCE}")
    print(f"词典 {OUT_DICT.relative_to(ROOT)}: {len(words)} 词 / {len(body.encode('utf-8'))} 字节")
    print("覆盖检查:", "全部命中" if not missing else f"缺少 {missing}")
    for w in CHECK_EXPECT:
        print(f"  {w}: {'Y' if w in words else 'N'}")
    return 1 if missing else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="投喂素材 -> 离线训练 -> jieba 用户词典")
    ap.add_argument("--feed", default=str(FEED_DIR), help="投喂目录或单个 .txt 文件")
    ap.add_argument("--add", default="", help="额外投喂的词，空格/逗号/换行分隔")
    ap.add_argument("--check", action="store_true", help="只校验当前词典，不写文件")
    args = ap.parse_args()

    if args.check:
        return check()

    feed = Path(args.feed).expanduser().resolve()
    if not feed.exists():
        print(f"投喂路径不存在，创建空目录: {feed}")
        feed.mkdir(parents=True, exist_ok=True)
    explicit, corpus, sources = read_texts(feed)
    extras = [x for x in re.split(r"[\s,，、]+", args.add) if x]
    explicit.extend(extras)
    if extras:
        sources.append("cli:--add")

    audit = build(explicit, corpus, sources)
    print(f"投喂来源 {len(sources)} 个 | 语料 {audit['corpus_chars']} 字 | 统计发现: {audit['stat_discovery']}")
    print(f"产出 {OUT_DICT.relative_to(ROOT)}: {len(audit['words'])} 词 / {OUT_DICT.stat().st_size} 字节")
    print(f"审计 {OUT_AUDIT.relative_to(ROOT)}")
    by_origin = Counter(w["origin"] for w in audit["words"])
    print("来源分布:", dict(by_origin))
    print()
    return check()


if __name__ == "__main__":
    sys.exit(main())
