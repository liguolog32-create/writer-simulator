#!/usr/bin/env python3
"""
百度网盘抽样下载器 —— 复用牵牛花的 CDP 模式
通过 CDP 连接已登录的 Chrome，自动进入指定目录、勾选文件、点下载。

用法:
    python check_login.py          # 检查登录状态
    python check_login.py --wait   # 阻塞等待，直到检测到登录成功（最多 5 分钟）
"""
import sys
import time
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9223"
PAN_HOME = "https://pan.baidu.com/disk/home"


def probe():
    """返回 (ok, url, title, logged_in)"""
    with sync_playwright() as p:
        try:
            b = p.chromium.connect_over_cdp(CDP)
        except Exception as e:
            return False, "", f"CDP 连接失败: {e}", False
        try:
            ctx = b.contexts[0] if b.contexts else None
            if ctx is None:
                return False, "", "没有浏览器 context", False
            pg = ctx.pages[0] if ctx.pages else ctx.new_page()
            pg.goto(PAN_HOME, wait_until="domcontentloaded", timeout=45000)
            pg.wait_for_timeout(4000)
            url = pg.url
            title = pg.title()
            txt = pg.content()
            # 未登录会跳到 passport 登录页 / 出现登录按钮
            logged_in = (
                "passport" not in url.lower()
                and "login" not in url.lower()
                and ("登录" not in title or "网盘" in title)
                and ("请登录" not in txt)
                and ("立即登录" not in txt)
            )
            return True, url, title, logged_in
        finally:
            b.close()


if __name__ == "__main__":
    wait_mode = "--wait" in sys.argv
    deadline = time.time() + 300  # 最多等 5 分钟

    if wait_mode:
        print("⏳ 等待登录百度网盘（最多 5 分钟）…")
        while time.time() < deadline:
            ok, url, title, logged = probe()
            if ok and logged:
                print(f"✅ 已登录！标题: {title}")
                print(f"   URL: {url}")
                sys.exit(0)
            print(f"   未登录（{title}），3 秒后重试…")
            time.sleep(3)
        print("❌ 超时仍未检测到登录")
        sys.exit(1)

    ok, url, title, logged = probe()
    print(f"CDP 连接: {'✅' if ok else '❌'}")
    print(f"当前页: {title}")
    print(f"URL: {url}")
    print(f"登录状态: {'✅ 已登录' if logged else '❌ 未登录'}")
    sys.exit(0 if logged else 2)
