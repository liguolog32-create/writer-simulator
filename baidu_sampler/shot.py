#!/usr/bin/env python3
"""探测百度网盘目录页：导航 → 等待列表加载 → 截图 + 导出可见文本"""
import sys
import urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
TARGET = "/小说合集/5300本小说（一）/高质量仙侠文"


def url_for(path):
    return f"https://pan.baidu.com/disk/main#/index?category=all&path={urllib.parse.quote(path)}"


with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    try:
        u = url_for(TARGET)
        print("导航:", u)
        pg.goto(u, wait_until="domcontentloaded", timeout=60000)
        # 等列表真正渲染（文件行出现）
        try:
            pg.wait_for_selector("text=上膳书", timeout=25000)
            print("✅ 检测到目标文件已渲染")
        except Exception:
            print("⚠️ 25s 内未检测到『上膳书』，继续截图看实际状态")
        pg.wait_for_timeout(3000)

        print("当前 URL:", pg.url)
        pg.screenshot(path="/tmp/pan_shot.png", full_page=False)
        print("截图: /tmp/pan_shot.png")

        # 导出页面上所有可见文本（截断）
        txt = pg.inner_text("body")
        lines = [l.strip() for l in txt.split("\n") if l.strip()]
        print(f"\n=== 页面可见文本（前 60 行，共 {len(lines)}）===")
        for l in lines[:60]:
            print("  ", l[:70])
        Path("/tmp/pan_text.txt").write_text("\n".join(lines), encoding="utf-8")
        print("\n全文: /tmp/pan_text.txt")
    finally:
        b.close()
