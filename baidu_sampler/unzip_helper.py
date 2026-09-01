#!/usr/bin/env python3
"""解压 小说样本 目录下所有 .zip（GBK 文件名 + 正文 GBK），提取到同目录。
跳过已存在的 txt。"""
import zipfile, os
from pathlib import Path

DL = Path.home() / "Downloads" / "小说样本"

def main():
    zips = sorted(DL.glob("*.zip"))
    print(f"发现 {len(zips)} 个 zip")
    for zp in zips:
        print(f"\n📦 {zp.name}")
        try:
            with zipfile.ZipFile(zp) as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    try:
                        name = info.filename.encode("cp437").decode("gbk")
                    except Exception:
                        name = info.filename
                    name = os.path.basename(name)
                    if not name:
                        continue
                    out = DL / name
                    if out.exists():
                        print(f"   ⏭ 已存在: {name}")
                        continue
                    data = zf.read(info)
                    out.write_bytes(data)
                    print(f"   ✅ {name} ({len(data)/1024:.0f} KB)")
        except Exception as e:
            print(f"   ❌ 解压失败: {e}")

if __name__ == "__main__":
    main()
