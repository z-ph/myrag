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
    parser.add_argument(
        "--api-prefix",
        default="/api",
        help="同源 API 前缀；VITE_BASE=/cwc/rag/ 时传 /cwc/rag/api",
    )
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
    http_errors: list[str] = []
    sse_events: list[str] = []
    sse_response_statuses: list[int] = []
    message_responses = []
    conversation_id: str | None = None
    persisted_statuses: list[str] = []

    def url_for(path: str) -> str:
        return urljoin(base_url, path.lstrip("/"))

    def settle(page) -> None:
        page.wait_for_load_state("domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=15_000)
        except PlaywrightTimeoutError:
            warnings.append(f"networkidle 超时，继续使用已渲染 DOM：{page.url}")

    def record_console(message) -> None:
        if message.type == "error":
            location = message.location.get("url") if message.location else ""
            suffix = f" [{location}]" if location else ""
            browser_errors.append(f"console.{message.type}: {message.text}{suffix} [page={page.url}]")

    def record_response(response) -> None:
        if response.status >= 400:
            http_errors.append(f"HTTP {response.status} {response.request.method} {response.url}")
        if response.request.method == "POST" and re.search(r"/conversations/[^/]+/messages/?$", response.url):
            message_responses.append(response)
            sse_response_statuses.append(response.status)

    def wait_for_non_empty_text(page, locator, timeout_ms: int) -> str:
        deadline = time.monotonic() + timeout_ms / 1000
        last_text = ""
        while time.monotonic() < deadline:
            last_text = (locator.text_content() or "").strip()
            if last_text and last_text != "正在思考…":
                return last_text
            page.wait_for_timeout(250)
        raise AssertionError(f"回答在 {timeout_ms}ms 内仍为空或仍在生成：{last_text!r}")

    def parse_sse_body(response) -> list[str]:
        if response.status != 200:
            raise AssertionError(f"问答 SSE 返回 HTTP {response.status}")
        try:
            body = response.body().decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001 - 保留响应读取证据
            raise AssertionError(f"无法读取问答 SSE 响应：{exc}") from exc
        events = re.findall(r"^event:\s*([^\r\n]+)", body, flags=re.MULTILINE)
        if "error" in events:
            raise AssertionError(f"问答 SSE 包含 error 事件：{events}")
        required = {"start", "complete"}
        missing = required.difference(events)
        if missing:
            raise AssertionError(f"问答 SSE 缺少终态事件 {sorted(missing)}：{events}")
        if not ({"delta", "reasoning"} & set(events)):
            raise AssertionError(f"问答 SSE 没有任何模型输出增量：{events}")
        return events

    def read_persisted_detail(page, current_conversation_id: str) -> dict:
        result = page.evaluate(
            """
            async ({apiPrefix, conversationId}) => {
              const token = localStorage.getItem('myrag-token') ?? localStorage.getItem('myrag-guest-token');
              const response = await fetch(
                `${apiPrefix}/conversations/${encodeURIComponent(conversationId)}`,
                { headers: token ? { Authorization: `Bearer ${token}` } : {} },
              );
              let body = null;
              try { body = await response.json(); } catch { /* 保留非 JSON 错误状态 */ }
              return { status: response.status, body };
            }
            """,
            {"apiPrefix": args.api_prefix.rstrip("/"), "conversationId": current_conversation_id},
        )
        if result["status"] != 200:
            raise AssertionError(f"刷新前读取会话详情失败：HTTP {result['status']} {result['body']!r}")
        messages = result["body"].get("recentMessages", [])
        assistant_messages = [message for message in messages if message.get("role") == "ASSISTANT"]
        if not assistant_messages:
            raise AssertionError(f"会话详情没有 ASSISTANT 消息：{messages!r}")
        latest = assistant_messages[-1]
        statuses = [str(message.get("status")) for message in assistant_messages]
        persisted_statuses[:] = statuses
        if any(status == "GENERATING" for status in statuses):
            raise AssertionError(f"持久化消息仍处于 GENERATING：{statuses}")
        if latest.get("status") != "COMPLETED":
            raise AssertionError(f"最新 ASSISTANT 消息不是 COMPLETED：{latest!r}")
        if not str(latest.get("content") or "").strip():
            raise AssertionError(f"持久化 ASSISTANT 消息内容为空：{latest!r}")
        return result["body"]

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
        page.on("console", record_console)
        page.on("pageerror", lambda error: browser_errors.append(f"pageerror: {error}"))
        page.on("response", record_response)

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
            page.get_by_role("heading", name="页面不存在", exact=True).wait_for(
                state="visible", timeout=15_000
            )
            page.locator(".route-status-code").get_by_text("404", exact=True).wait_for(
                state="visible", timeout=15_000
            )
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
                nonlocal conversation_id
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
                match = re.search(r"/chat/(conv-[^/?#]+)", created_url)
                if not match:
                    raise AssertionError(f"无法从 URL 提取新会话 ID：{created_url}")
                conversation_id = match.group(1)
                page.locator(".msg-user .user-bubble").wait_for(state="visible", timeout=15_000)
                answer_locator = page.locator(".msg-assistant .answer").last
                answer_locator.wait_for(state="attached", timeout=15_000)
                answer = wait_for_non_empty_text(page, answer_locator, args.answer_timeout_ms)
                if not answer:
                    raise AssertionError("回答文本为空")
                if not message_responses:
                    raise AssertionError("没有捕获到问答 POST 响应")
                sse_events[:] = parse_sse_body(message_responses[-1])
                read_persisted_detail(page, conversation_id)
                old_key = page.evaluate("() => localStorage.getItem('myrag-current-conv')")
                if old_key is not None:
                    raise AssertionError(f"发现已废弃的 localStorage key: {old_key!r}")
                page.reload()
                settle(page)
                if page.url != created_url:
                    raise AssertionError(f"刷新后 URL 改变：{page.url} != {created_url}")
                page.locator(".msg-user .user-bubble").wait_for(state="visible", timeout=20_000)
                restored_locator = page.locator(".msg-assistant .answer").last
                restored_locator.wait_for(state="attached", timeout=20_000)
                restored_answer = wait_for_non_empty_text(page, restored_locator, 20_000)
                if not restored_answer:
                    raise AssertionError("刷新后回答文本为空")
                read_persisted_detail(page, conversation_id)

            check("真实发送、URL 持久化与刷新恢复", send_and_check)

        def check_browser_errors() -> None:
            # 当前页面故意访问一个不存在会话，开发服务器会在控制台记录对应的 404；
            # 其余 pageerror、HTTP 错误和控制台 error 都必须显式暴露出来。
            unexpected_http = [
                error
                for error in http_errors
                if not (missing_id in error and "HTTP 404" in error)
            ]
            unexpected_console = [
                error
                for error in browser_errors
                if not (
                    "Failed to load resource" in error
                    and "404" in error
                    and missing_id in error
                )
            ]
            if unexpected_http or unexpected_console:
                raise AssertionError(
                    f"发现未解释的浏览器错误：HTTP={unexpected_http!r}, console/pageerror={unexpected_console!r}"
                )
            if http_errors or browser_errors:
                warnings.append(f"已解释浏览器错误：HTTP={http_errors!r}, console={browser_errors!r}")

        check("没有未解释的浏览器错误", check_browser_errors)

        page.screenshot(path=str(artifacts_dir / "final.png"), full_page=True)
        browser.close()

    result = {
        "base_url": base_url,
        "checks": checks,
        "warnings": warnings,
        "browser_errors": browser_errors,
        "http_errors": http_errors,
        "unexpected_browser_errors": [
            error
            for error in browser_errors
            if not (
                "Failed to load resource" in error
                and "404" in error
                and missing_id in error
            )
        ],
        "conversation_id": conversation_id,
        "persisted_assistant_statuses": persisted_statuses,
        "sse_events": sse_events,
        "sse_response_statuses": sse_response_statuses,
        "artifacts_dir": str(artifacts_dir),
    }
    result_path = artifacts_dir / "result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(item["status"] == "failed" for item in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
