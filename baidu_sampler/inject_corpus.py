#!/usr/bin/env python3
"""
把 baidu_corpus.json 的分析结果【整体重建】为 aiRecommendations.ts 的 bookLibrary。
以 baidu_corpus.json 为唯一真相源，替换整个 bookLibrary 块，消除重复/键格式混乱。
- 书名含非标识符字符（空格/中文逗号）时加引号
- 括号平衡自检 + 末尾简单校验
"""
import json, re
from pathlib import Path

CORPUS = Path("/Users/apple/Downloads/writer-simulator 2/baidu_corpus.json")
TS = Path("/Users/apple/Downloads/writer-simulator 2/src/data/aiRecommendations.ts")

DIMS = ["设定", "人物", "文笔", "结构", "篇幅", "情节", "节奏"]

def fmt_key(k: str) -> str:
    if re.match(r'^[A-Za-z0-9_\u4e00-\u9fff]+$', k):
        return k
    return "'" + k + "'"

def build_entry(name, entry):
    tags = entry.get("tags", [])
    bd = entry.get("byDimension", {})
    lines = []
    lines.append(f"  {fmt_key(name)}: {{")
    lines.append(f"    author: {json.dumps(entry.get('author',''), ensure_ascii=False)},")
    lines.append(f"    tags: {json.dumps(tags, ensure_ascii=False)},")
    lines.append("    byDimension: {")
    for d in DIMS:
        if d not in bd:
            continue
        dim = bd[d]
        feat = dim.get("feature", "")
        ex = dim.get("example", "")
        lines.append(f"      {d}: {{")
        lines.append(f"        feature: {json.dumps(feat, ensure_ascii=False)},")
        lines.append(f"        example: {json.dumps(ex, ensure_ascii=False)},")
        lines.append("      },")
    lines.append("    },")
    lines.append("  },")
    return "\n".join(lines)

def main():
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    ts = TS.read_text(encoding="utf-8")

    marker = "export const bookLibrary"
    idx = ts.index(marker)
    eq = ts.index("=", idx)
    brace_open = ts.index("{", eq)
    rest = ts[brace_open:]
    m = re.search(r"\n\}\n", rest)          # 列 0 闭合 '}'
    if not m:
        m = re.search(r"\n\};\n", rest)     # 容错：带分号
    if not m:
        m = re.search(r"\n\};\n", ts[brace_open:])  # 再容错
    if not m:
        raise SystemExit("找不到 bookLibrary 的闭合 }")
    close_rel = m.start()
    close_abs = brace_open + close_rel  # 指向 '\n}'

    valid = [(n, e) for n, e in corpus.items() if "error" not in e
             and all(d in e.get("byDimension", {}) for d in DIMS)]
    skipped = [n for n, e in corpus.items()
               if "error" in e or not all(d in e.get("byDimension", {}) for d in DIMS)]
    entries = "\n".join(build_entry(n, e) for n, e in valid)

    head = ts[:brace_open + 1]
    tail = ts[close_abs:]  # 以 '\n};' 开头
    new_ts = head + "\n" + entries + "\n" + tail

    TS.write_text(new_ts, encoding="utf-8")
    print(f"✅ 重建 bookLibrary：注入 {len(valid)} 本真实分析（跳过 {len(skipped)} 本异常）。")
    if skipped:
        print(f"   ⏭ 跳过: {skipped}")
    print(f"📐 大括号平衡: {{={new_ts.count('{')} }}={new_ts.count('}')}")
    # 顶层 key 数（粗略：统计 '  xxx:' 或 'xxx:' 行首）
    keycount = len(re.findall(r"^\s{2}['\"]?[^\s'\":]+['\"]?\s*:\s*\{", new_ts, re.M))
    print(f"📚 估计顶层 key 数: {keycount}")

if __name__ == "__main__":
    main()
