#!/usr/bin/env python3
"""解压剩余 zip + 校验 12 本新书的 GBK 编码 + 抽取样本到 samples_batch5.txt。"""
import zipfile, os, re
from pathlib import Path

DL = Path.home() / "Downloads" / "小说样本"
OUT = Path("/Users/apple/Downloads/writer-simulator 2/baidu_sampler/samples_batch5.txt")

NEW = [
    "徐徐诱之.txt",
    "谁说我，不爱你_派派后花园.txt",
    "竹马镶青梅 作者：北倾.txt",
    "《他从火光中走来》作者：耳东兔子.txt",
    "《招惹计》作者：耳东兔子.txt",
    "《韫色过浓》作者：六盲星.txt",
    "《只为他折腰》作者：六盲星.txt",
    "《如果月亮不抱你》作者：六盲星.txt",
    "一生一世，美人骨.txt",
    "至此终年.txt",
    "春江花月  作者：蓬莱客.txt",
    "《海上华亭》作者：蓬莱客.txt",
]

def unzip_all():
    for zp in DL.glob("*.zip"):
        with zipfile.ZipFile(zp) as zf:
            for info in zf.infolist():
                if info.is_dir(): continue
                try: name = info.filename.encode("cp437").decode("gbk")
                except Exception: name = info.filename
                name = os.path.basename(name)
                out = DL / name
                if out.exists(): continue
                out.write_bytes(zf.read(info))

def read_gbk(fp):
    raw = fp.read_bytes()
    return raw.decode("gbk", errors="replace")

def is_garbled(text):
    # 乱码特征：替换字符占比高，或连续乱码符号
    rep = text.count("\ufffd")
    if rep > len(text) * 0.02:
        return True
    return False

def sample(text, head=1800, mid=900, tail=500):
    lines = text.splitlines()
    total = len(lines)
    h = "\n".join(lines[:max(1, head//30)])
    # 中段
    mid_start = total // 2
    m = "\n".join(lines[mid_start: mid_start + max(1, mid//30)])
    t = "\n".join(lines[-max(1, tail//30):])
    return h, m, t

def main():
    unzip_all()
    parts = []
    ok, bad = [], []
    for name in NEW:
        fp = DL / name
        if not fp.exists():
            parts.append(f"\n########## {name}\n[缺失文件]\n")
            bad.append(name); continue
        try:
            text = read_gbk(fp)
        except Exception as e:
            parts.append(f"\n########## {name}\n[解码失败 {e}]\n"); bad.append(name); continue
        if is_garbled(text):
            parts.append(f"\n########## {name}\n[疑似乱码，跳过]\n"); bad.append(name); continue
        h, m, t = sample(text)
        parts.append(f"\n{'='*70}\n########## {name}  (全文约 {len(text)} 字)\n{'='*70}\n【开头】\n{h}\n\n【中段】\n{m}\n\n【结尾】\n{t}\n")
        ok.append(name)
    OUT.write_text("\n".join(parts), encoding="utf-8")
    print(f"✅ 正常 {len(ok)} 本: {ok}")
    if bad: print(f"❌ 问题 {len(bad)} 本: {bad}")
    print(f"样本已写入: {OUT}  ({OUT.stat().st_size/1024:.0f} KB)")

if __name__ == "__main__":
    main()
