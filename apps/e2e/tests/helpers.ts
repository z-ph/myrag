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
  const answer = page.locator('.msg-assistant .answer').last();
  // 生成结束后「停止」换回「发送」
  await expect(page.locator('button.composer-send')).toBeVisible({ timeout });
  await expect(page.locator('.answer-typing')).toHaveCount(0);
  const text = (await answer.textContent()) ?? '';
  expect(text.trim().length).toBeGreaterThan(0);
  expect(text.trim()).not.toBe('正在思考…');
}

/** 在聊天输入框提问并发送 */
export async function askQuestion(page: Page, question: string): Promise<void> {
  const textarea = page.getByPlaceholder('输入问题').or(page.locator('.composer-input'));
  await textarea.fill(question);
  const sendButton = page.locator('button.composer-send');
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
}

/** 上传文件到文档库（若存在） */
export async function uploadFile(page: Page, filePath: string): Promise<void> {
  await page.goto('/documents');
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(filePath);
  await expect(page.locator('.ant-message')).toContainText('已提交', { timeout: 30_000 });
}

export const TEST_USER = {
  username: 'e2euser',
  password: 'e2euser',
  displayName: 'E2E 测试用户',
};
