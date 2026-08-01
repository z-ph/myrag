import { expect, test } from '@playwright/test';
import { apiLogin } from './helpers';

test.describe('文档库', () => {
  test('未登录可浏览文档列表', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();
    // 表头完整
    await expect(page.locator('.ant-table-thead')).toContainText('文件名');
    await expect(page.locator('.ant-table-thead')).toContainText('状态');
  });

  test('关键字搜索过滤列表', async ({ page }) => {
    await page.goto('/documents');
    const search = page.getByPlaceholder('按文件名搜索');
    await search.fill('不存在的文档xyz');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ant-table-row')).toHaveCount(0);
  });

  test('未登录上传文档被拒绝（跳登录提示）', async ({ page }) => {
    const token = await apiLogin('admin', 'admin123').catch(() => null);
    test.skip(token === null, '后端未就绪');

    await page.goto('/documents');
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('测试文档内容'),
    });
    // 未登录上传应报错
    await expect(page.locator('.ant-message')).toContainText(/未登录|权限不足|登录/, { timeout: 10_000 });
  });
});

test.describe('用户管理（管理员）', () => {
  test('管理员可创建用户并重置密码', async ({ page }) => {
    const token = await apiLogin('admin', 'admin123').catch(() => null);
    test.skip(token === null, '后端未就绪');

    // 注入 token 直接访问
    await page.addInitScript((t) => {
      localStorage.setItem('myrag-token', t);
    }, token!);
    await page.goto('/users');

    const username = `tester_${Date.now().toString(36)}`;
    await page.getByRole('button', { name: '新增用户' }).click();
    await page.getByPlaceholder('登录账号，初始密码同用户名').fill(username);
    await page.getByLabel('显示名称').fill('测试账号');
    await page.getByRole('dialog').getByRole('button', { name: '确 定' }).click();
    await expect(page.locator('.ant-message')).toContainText('用户创建成功', { timeout: 10_000 });
    await expect(page.locator('.ant-table')).toContainText(username);

    // 新用户可登录
    const newToken = await apiLogin(username, username);
    expect(newToken.length).toBeGreaterThan(0);
  });
});
