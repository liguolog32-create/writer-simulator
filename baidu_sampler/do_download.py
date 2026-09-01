#!/usr/bin/env python3
"""
百度网盘抽样下载 —— 执行版
1) CDP 设置下载目录（不弹保存框）
2) 进入目标目录
3) 勾选指定文件（点行左侧 checkbox 区域）
4) 点下载按钮
5) 等待并校验落盘文件
"""
import sys
import time
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
DOWNLOAD_DIR = Path.home() / "Downloads" / "小说样本"
TARGET_DIR = "/小说合集/5300本小说（一）/高质量仙侠文"
FILES = [
    "《上膳书》作者：三水小草.txt",
    "《本王在此》-九鹭非香.txt",
    "奈何by君子以泽.txt",
]


def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"


def key_of(fn):
    return fn.replace(".txt", "")


with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()

    # 1) 下载行为：直接落盘，不弹对话框
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    client = ctx.new_cdp_session(pg)
    client.send(
        "Page.setDownloadBehavior",
        {"behavior": "allow", "downloadPath": str(DOWNLOAD_DIR)},
    )
    print(f"下载目录: {DOWNLOAD_DIR}")

    try:
        # 2) 进入目录
        pg.goto(url_for(TARGET_DIR), wait_until="domcontentloaded", timeout=60000)
        try:
            pg.wait_for_selector("text=上膳书", timeout=25000)
        except Exception:
            print("⚠️ 未等到文件行渲染")
        pg.wait_for_timeout(3000)
        print(f"已进入: {pg.url[:90]}")

        # 3) 逐个勾选：点行左侧 checkbox 区域
        for fn in FILES:
            key = key_of(fn)
            try:
                # 找到包含该文件名的行（取最内层，避免选到 body）
                loc = pg.locator(f"text={key}").last
                box = loc.bounding_box()
                if not box:
                    print(f"  ❌ 定位失败: {key}")
                    continue
                # 行左侧 ~20px 是 checkbox；用行所在行的垂直中心
                pg.mouse.click(box["x"] - 250, box["y"] + box["height"] / 2)
                pg.wait_for_timeout(1200)
                print(f"  ☑️  勾选: {key}")
            except Exception as e:
                print(f"  ❌ 勾选失败 {key}: {e}")

        pg.wait_for_timeout(1500)
        pg.screenshot(path="/tmp/pan_selected.png")
        print("选中状态截图: /tmp/pan_selected.png")

        # 4) 点下载
        clicked = False
        for sel in [
            "button:has-text('下载')",
            "text=下载",
            "[data-key='download']",
            ".g-button:has-text('下载')",
        ]:
            try:
                btn = pg.locator(sel).first
                if btn.count() > 0 and btn.is_visible():
                    btn.click()
                    print(f"  ✅ 点击下载按钮 ({sel})")
                    clicked = True
                    break
            except Exception:
                continue
        if not clicked:
            print("  ❌ 未找到下载按钮")

        # 5) 等下载落盘
        print("\n等待下载（30s）…")
        for i in range(30):
            time.sleep(1)
            got = list(DOWNLOAD_DIR.glob("*.txt")) + list(DOWNLOAD_DIR.glob("*.crdownload"))
            if got:
                print(f"  [{i+1}s] 检测到 {len(got)} 个文件")
        pg.wait_for_timeout(5000)
    finally:
        b.close()

print("\n=== 下载目录内容 ===")
for f in sorted(DOWNLOAD_DIR.iterdir()):
    print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")
