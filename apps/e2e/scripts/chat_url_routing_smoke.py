#!/usr/bin/env python3
"""真实浏览器验收：验证 URL 驱动聊天的关键用户路径。

用法示例：
  python3 apps/e2e/scripts/chat_url_routing_smoke.py --base-url http://127.0.0.1:5174

脚本默认会发送一个最小问题并等待真实回答；外部模型不可用时可用
--skip-answer 只验证页面、路由、API 错误页和新会话 URL 跳转。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5174")
    parser.add_argument("--question", default="请用一句话回复：URL 路由验收通过。")
    parser.add_argument("--answer-timeout-ms", type=int, default=120_000)
    parser.add_argument("--skip-answer", action="store_true")
    parser.add_argument(
        "--artifacts-dir",
        default=".superpowers/manual-tests/chat-url-routing",
        help="截图和结果文件目录（相对当前工作树）",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    base_url = args.base_url.rstrip("/") + "/"
    artifacts_dir = Path(args.artifacts_dir)
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    checks: list[dict[str, str]] = []
    warnings: list[str] = []
    browser_errors: list[str] = []

    def url_for(path: str) -> str:
        return urljoin(base_url, path.lstrip("/"))

    def settle(page) -> None:
        page.wait_for_load_state("domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=15_000)
        except PlaywrightTimeoutError:
            warnings.append(f"networkidle 超时，继续使用已渲染 DOM：{page.url}")

    def check(name: str, action) -> None:
        try:
            action()
            checks.append({"name": name, "status": "passed"})
            print(f"PASS  {name}")
        except Exception as exc:  # noqa: BLE001 - 保留全部失败证据后再退出
            message = f"{type(exc).__name__}: {exc}"
            checks.append({"name": name, "status": "failed", "error": message})
            print(f"FAIL  {name}: {message}", file=sys.stderr)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on(
            "console",
            lambda message: browser_errors.append(f"console.{message.type}: {message.text}")
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: browser_errors.append(f"pageerror: {error}"))

        check(
            "根路径规范化到 /chat/new",
            lambda: (
                page.goto(url_for("/")),
                settle(page),
                page.wait_for_url(re.compile(r"/chat/new/?$"), timeout=15_000),
            ),
        )
        check(
            "旧 /chat 路径规范化到 /chat/new",
            lambda: (
                page.goto(url_for("/chat")),
                settle(page),
                page.wait_for_url(re.compile(r"/chat/new/?$"), timeout=15_000),
            ),
        )
        check(
            "新会话页面可见且有输入框",
            lambda: page.get_by_placeholder(re.compile("输入问题")).wait_for(
                state="visible", timeout=15_000
            ),
        )

        unknown_path = "/unknown-manual-smoke-path"

        def check_unknown_route() -> None:
            page.goto(url_for(unknown_path))
            settle(page)
            page.get_by_text("页面不存在", exact=True).wait_for(state="visible", timeout=15_000)
            page.get_by_text("404", exact=True).wait_for(state="visible", timeout=15_000)
            page.get_by_role("button", name="返回首页", exact=True).wait_for(
                state="visible", timeout=15_000
            )
            if not page.url.endswith(unknown_path):
                raise AssertionError(f"未知路径被改写：{page.url}")

        check(
            "未知路径停留并显示通用 404",
            check_unknown_route,
        )
        check(
            "通用 404 操作返回新会话",
            lambda: (
                page.get_by_role("button", name="返回首页", exact=True).click(),
                page.wait_for_url(re.compile(r"/chat/new/?$"), timeout=15_000),
            ),
        )

        missing_id = f"conv-manual-missing-{int(time.time())}"
        check(
            "不存在会话显示会话 404",
            lambda: (
                page.goto(url_for(f"/chat/{missing_id}")),
                settle(page),
                page.get_by_text("会话不存在", exact=True).wait_for(state="visible", timeout=20_000),
                page.get_by_text("未找到对应会话，或当前账号无权访问。", exact=True).wait_for(
                    state="visible", timeout=15_000
                ),
            ),
        )

        if not args.skip_answer:
            def send_and_check() -> None:
                page.goto(url_for("/chat/new"))
                settle(page)
                input_box = page.get_by_placeholder(re.compile("输入问题"))
                input_box.wait_for(state="visible", timeout=15_000)
                input_box.fill(args.question)
                # Ant Design 图标会参与部分浏览器的 accessible-name 计算；
                # composer-send 是产品组件的稳定语义钩子，先确认可见且可用。
                send_button = page.locator("button.composer-send")
                send_button.wait_for(state="visible", timeout=15_000)
                if not send_button.is_enabled():
                    raise AssertionError("发送按钮在输入问题后仍处于 disabled")
                send_button.click()
                page.wait_for_url(re.compile(r"/chat/conv-[^/]+/?$"), timeout=20_000)
                created_url = page.url
                page.locator(".msg-user .user-bubble").wait_for(state="visible", timeout=15_000)
                page.locator(".msg-assistant .answer").wait_for(
                    state="visible", timeout=args.answer_timeout_ms
                )
                old_key = page.evaluate("() => localStorage.getItem('myrag-current-conv')")
                if old_key is not None:
                    raise AssertionError(f"发现已废弃的 localStorage key: {old_key!r}")
                page.reload()
                settle(page)
                if page.url != created_url:
                    raise AssertionError(f"刷新后 URL 改变：{page.url} != {created_url}")
                page.locator(".msg-user .user-bubble").wait_for(state="visible", timeout=20_000)
                page.locator(".msg-assistant .answer").wait_for(state="visible", timeout=20_000)

            check("真实发送、URL 持久化与刷新恢复", send_and_check)

        page.screenshot(path=str(artifacts_dir / "final.png"), full_page=True)
        browser.close()

    result = {
        "base_url": base_url,
        "checks": checks,
        "warnings": warnings,
        "browser_errors": browser_errors,
        "artifacts_dir": str(artifacts_dir),
    }
    result_path = artifacts_dir / "result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(item["status"] == "failed" for item in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
