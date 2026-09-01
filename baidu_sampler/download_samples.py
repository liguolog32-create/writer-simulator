#!/usr/bin/env python3
"""
百度网盘抽样下载器 —— 复用牵牛花 CDP 模式

前提：Chrome 已用 --remote-debugging-port=9223 --user-data-dir=~/.baidu_pan_profile
      启动，且已在其中登录百度网盘。

用法:
    python download_samples.py --explore   # 先看目录页 DOM 结构
    python download_samples.py             # 执行下载
"""
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
DOWNLOAD_DIR = Path.home() / "Downloads" / "小说样本"

# 抽样目标：第一阶段先下仙侠 3 本验证效果
# (网盘目录, 文件名)
SAMPLES = [
    ("/小说合集/5300本小说（一）/高质量仙侠文", "《上膳书》作者：三水小草.txt"),
    ("/小说合集/5300本小说（一）/高质量仙侠文", "《本王在此》-九鹭非香.txt"),
    ("/小说合集/5300本小说（一）/高质量仙侠文", "奈何by君子以泽.txt"),
]


def pan_dir_url(pan_path: str) -> str:
    import urllib.parse

    enc = urllib.parse.quote(pan_path)
    return f"https://pan.baidu.com/disk/home#/all?path={enc}&vmode=list"


def connect(p):
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0] if b.contexts else None
    if ctx is None:
        raise RuntimeError("没有浏览器 context")
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    return b, pg


def explore():
    """进入第一个目标目录，dump DOM 关键结构，供后续写选择器"""
    with sync_playwright() as p:
        b, pg = connect(p)
        try:
            pan_path = SAMPLES[0][0]
            url = pan_dir_url(pan_path)
            print(f"导航到: {url}")
            pg.goto(url, wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_timeout(6000)
            print(f"当前 URL: {pg.url}")
            print(f"标题: {pg.title()}")
            txt = pg.content()
            print(f"页面长度: {len(txt)}")
            # 看页面里是否出现了目标文件名
            for _, fn in SAMPLES:
                key = fn.replace(".txt", "")
                print(f"  包含「{key}」: {key in txt}")
            # dump 可能的列表容器
            for sel in [
                "li[node-type]",
                ".file-name",
                "[data-id]",
                ".list-view",
                "dd",
            ]:
                n = pg.locator(sel).count()
                if n:
                    print(f"  选择器 {sel} 命中 {n} 个")
            # 存一份 HTML 便于分析
            out = Path("/tmp/pan_dir.html")
            out.write_text(txt, encoding="utf-8")
            print(f"\nHTML 已存: {out}")
        finally:
            b.close()


def download():
    """勾选并下载抽样文件"""
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b, pg = connect(p)
        try:
            # 设置下载行为：直接存到指定目录，不弹保存对话框
            pg.context.set_default_timeout(60000)
            grouped = {}
            for pan_path, fn in SAMPLES:
                grouped.setdefault(pan_path, []).append(fn)

            for pan_path, files in grouped.items():
                url = pan_dir_url(pan_path)
                print(f"\n[目录] {pan_path}")
                pg.goto(url, wait_until="domcontentloaded", timeout=60000)
                pg.wait_for_timeout(6000)

                for fn in files:
                    key = fn.replace(".txt", "")
                    print(f"  找文件: {key}")
                    try:
                        # 百度网盘列表项用文件名做 title/文本
                        item = pg.locator(f"text={key}").first
                        if item.count() == 0:
                            print(f"    ❌ 未找到")
                            continue
                        item.click()
                        pg.wait_for_timeout(800)
                        print(f"    ✅ 已选中")
                    except Exception as e:
                        print(f"    ❌ 选中失败: {e}")
                        continue

                # 点下载按钮
                print("  点击下载…")
                for sel in [
                    "text=下载",
                    "button:has-text('下载')",
                    "[data-key='download']",
                    ".g-button:has-text('下载')",
                ]:
                    try:
                        btn = pg.locator(sel).first
                        if btn.count() > 0:
                            btn.click()
                            print(f"    ✅ 已点击 ({sel})")
                            break
                    except Exception:
                        continue
                pg.wait_for_timeout(8000)
        finally:
            b.close()
    print(f"\n下载目录: {DOWNLOAD_DIR}")


if __name__ == "__main__":
    if "--explore" in sys.argv:
        explore()
    else:
        download()
