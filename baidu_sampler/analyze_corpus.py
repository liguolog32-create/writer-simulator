#!/usr/bin/env python3
"""
百度网盘小说语料 → 7 维度分析
读本地 GBK 小说文件，抽取开头/中段/结尾样本，调 DeepSeek 产出 7 维度分析
输出: baidu_corpus.json（可喂入作家模拟器 bookLibrary）
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

API = "https://api.deepseek.com/responses"
MODEL = "deepseek-v4-flash"
KEY = "sk-fd6a81cc278d4c178763fea149a8df68"

SRC_DIR = Path.home() / "Downloads" / "小说样本"
OUT_JSON = Path("/Users/apple/Downloads/writer-simulator 2/baidu_corpus.json")

SYSTEM = """你是资深网文/文学编辑。基于提供的小说样本，产出结构化分析。

严格返回 JSON（不要 markdown 包裹、不要解释）：
{
  "author": "作者名（从文本中提取；未知填空字符串）",
  "tags": ["题材标签1", "标签2", "标签3", "标签4"],
  "byDimension": {
    "设定": {"feature": "世界观/规则/时代背景的核心特征（50-90字）", "example": "书中的一个具体例子（引用或转述，30-70字）"},
    "人物": {"feature": "主角与关键配角的塑造特征（50-90字）", "example": "体现人物弧光的一个具体场景（30-70字）"},
    "文笔": {"feature": "语气、句法、修辞的核心特征（50-90字）", "example": "书中一句典型的话或一个典型写法（30-70字）"},
    "结构": {"feature": "叙事组织、视角、章节推进方式（50-90字）", "example": "结构上的一个具体安排（30-70字）"},
    "篇幅": {"feature": "体量与信息密度、详略分配（50-90字）", "example": "篇幅处理上的一个具体表现（30-70字）"},
    "情节": {"feature": "主线冲突、因果链条、悬念机制（50-90字）", "example": "情节设计上的一个具体例子（30-70字）"},
    "节奏": {"feature": "张力曲线、快慢交替、高潮分布（50-90字）", "example": "节奏控制上的一个具体例子（30-70字）"}
  }
}

要求：
- 七个维度键必须齐全，每个都有 feature 和 example
- 必须基于样本实际内容，不要泛泛而谈空话，也不要编造样本里没有的情节
- example 尽量具体（能引用原文金句最好），feature 提炼规律
- 样本不足以判断的维度，feature 里明确写"样本显示为…"，不要编造
- 全部用中文"""


def read_gbk(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("gbk", "gb18030", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("gbk", errors="replace")


def make_sample(text: str, head=12000, mid=6000, tail=4000) -> str:
    """开头 + 中段 + 结尾，控制总 token"""
    n = len(text)
    parts = []
    parts.append(f"【开篇（前 {head} 字）】\n{text[:head]}")
    if n > head + mid + tail:
        mid_start = n // 2 - mid // 2
        parts.append(f"\n\n【中段（约全书 1/2 处，{mid} 字）】\n{text[mid_start:mid_start + mid]}")
        parts.append(f"\n\n【结尾（末 {tail} 字）】\n{text[-tail:]}")
    return "\n".join(parts)


def extract_output_text(data):
    t = data.get("output_text")
    if isinstance(t, str) and t.strip():
        return t
    items = data.get("output") or []
    for i in range(len(items) - 1, -1, -1):
        it = items[i]
        if it.get("type") == "message":
            for part in it.get("content") or []:
                if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                    return part["text"]
    return ""


def analyze_book(name: str, sample: str) -> dict:
    payload = {
        "model": MODEL,
        "instructions": SYSTEM,
        "input": f"请分析小说《{name}》：\n\n{sample}",
        "max_output_tokens": 16000,  # 模型开推理模式，给少了会 incomplete/空返回
    }
    req = urllib.request.Request(
        API,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=240) as r:
        data = json.loads(r.read().decode())
    text = extract_output_text(data)
    # 宽松解析 JSON
    try:
        return json.loads(text)
    except Exception:
        import re
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            return json.loads(m.group(0))
        raise RuntimeError(f"解析失败: {text[:200]}")


def main():
    files = sorted(SRC_DIR.glob("*.txt"))
    if not files:
        print(f"❌ {SRC_DIR} 里没有 txt 文件")
        sys.exit(1)

    # 已分析过的直接复用，避免重复烧 token
    results = {}
    if OUT_JSON.exists():
        try:
            results = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        except Exception:
            results = {}

    for f in files:
        name = f.stem
        if name in results and "error" not in results[name]:
            print(f"\n⏭ 跳过（已分析）: {name}")
            continue
        print(f"\n{'='*60}\n📖 {name}")
        text = read_gbk(f)
        print(f"   全文 {len(text):,} 字")
        sample = make_sample(text)
        print(f"   样本 {len(sample):,} 字，调用 DeepSeek…")
        t0 = time.time()
        try:
            try:
                r = analyze_book(name, sample)
            except Exception:
                # 输入太长会让模型返回空 —— 降级用更小样本再试一次
                small = make_sample(text, head=7000, mid=3000, tail=2000)
                print(f"   ↻ 首次失败，降级样本 {len(small):,} 字重试…")
                r = analyze_book(name, small)
            results[name] = r
            print(f"   ✅ 完成（{time.time()-t0:.0f}s）")
            print(f"   作者: {r.get('author','?')} | 标签: {r.get('tags',[])}")
            dims = r.get("byDimension", {})
            for d in ["设定", "人物", "文笔", "结构", "篇幅", "情节", "节奏"]:
                if d in dims:
                    print(f"   {d}: {dims[d].get('feature','')[:60]}…")
        except Exception as e:
            print(f"   ❌ 失败: {e}")
            results[name] = {"error": str(e)}

    OUT_JSON.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n\n💾 已保存: {OUT_JSON}")
    return results


if __name__ == "__main__":
    main()
