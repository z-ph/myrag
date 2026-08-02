import { expect, type Page } from '@playwright/test';
import type { LoginResponse } from '@myrag/shared';

const BACK_END_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

/** 通过 API 登录获取 token（创建会话资源） */
export async function apiLogin(username: string, password: string): Promise<string> {
  const res = await fetch(`${BACK_END_URL}/auth/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.ok).toBeTruthy();
  const body = (await res.json()) as LoginResponse;
  return body.token;
}

/** 等待聊天页出现非空 AI 回复（流式完成） */
export async function waitForAnswer(page: Page, timeout = 30_000): Promise<void> {
  const bubble = page.locator('.msg-assistant .msg-bubble').last();
  await expect(bubble).not.toHaveText('…', { timeout: 5_000 });
  // 等待生成结束（发送按钮恢复）
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout });
  const text = (await bubble.textContent()) ?? '';
  expect(text.trim().length).toBeGreaterThan(0);
}

/** 在聊天输入框提问并发送 */
export async function askQuestion(page: Page, question: string): Promise<void> {
  const textarea = page.locator('.chat-input-row textarea');
  await textarea.fill(question);
  await page.getByRole('button', { name: '发送' }).click();
}

/** 上传文件到文档库（若存在） */
export async function uploadFile(page: Page, filePath: string): Promise<void> {
  await page.goto('/documents');
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(filePath);
  await expect(page.locator('.ant-message')).toContainText('已入库', { timeout: 30_000 });
}

export const TEST_USER = {
  username: 'e2euser',
  password: 'e2euser',
  displayName: 'E2E 测试用户',
};
