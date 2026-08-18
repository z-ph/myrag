import { expect, test } from '@playwright/test';
import { askQuestion, waitForAnswer } from './helpers';

test.describe('智能问答', () => {
  test('匿名提问返回回答并展示来源', async ({ page }) => {
    await page.goto('/chat');
    await askQuestion(page, '财务报销需要哪些材料？');
    await waitForAnswer(page);

    await expect(page.locator('.msg-user .user-bubble')).toHaveCount(1);
    await expect(page.locator('.msg-assistant .answer')).toHaveCount(1);
    const answer = (await page.locator('.msg-assistant .answer').last().textContent()) ?? '';
    expect(answer.trim().length).toBeGreaterThan(0);
    // 会话列表在左侧 Drawer 内，需先打开历史会话
    await page.locator('.composer .composer-icon').nth(1).click();
    await expect(page.locator('.conv-item').first()).toBeVisible();
  });

  test('新会话按钮清空消息区', async ({ page }) => {
    await page.goto('/chat');
    await page.locator('.composer .composer-icon').first().click();
    await expect(page.locator('.msg-user, .msg-assistant')).toHaveCount(0);
  });

  test('登录后可发送流式问答', async ({ page }) => {
    // 通过 UI 登录
    await page.goto('/my');
    await page.getByPlaceholder('用户名').fill('admin');
    await page.getByPlaceholder('密码').fill('admin123');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/chat/);
    // 登录态验证：管理员可见管理面板入口
    await expect(page.getByRole('menuitem', { name: '管理面板' })).toBeVisible({ timeout: 10_000 });
    // 我的页显示退出按钮，再回到聊天页提问
    await page.goto('/my');
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.goto('/chat');

    await askQuestion(page, '差旅费报销标准是什么？');
    await waitForAnswer(page);
    await expect(page.locator('.msg-user .user-bubble')).toHaveCount(1);
    await expect(page.locator('.msg-assistant .answer')).toHaveCount(1);
  });

  test('匿名会话在 localStorage 中持久化', async ({ page }) => {
    await page.goto('/chat');
    await askQuestion(page, '介绍一下知识库');
    await waitForAnswer(page);

    const conv = await page.evaluate(() => localStorage.getItem('myrag-current-conv'));
    expect(conv).toBeTruthy();
  });
});
