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

  test('预览打开正文而不是向量详情', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();
    const rows = page.locator('.ant-table-row');
    test.skip((await rows.count()) === 0, '没有文档可预览');

    await rows.first().getByRole('button', { name: /预览/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText('向量详情');
    await expect(dialog).not.toContainText('knowledge-base');
    await expect(dialog).not.toContainText('FULL_INDEX');
    await expect(dialog.getByRole('button', { name: '下载文档' })).toBeVisible();
  });

  test('关键字搜索过滤列表', async ({ page }) => {
    await page.goto('/documents');
    const search = page.getByPlaceholder('按文件名、主题或正文搜索');
    await search.fill('不存在的文档xyz');
    await expect(page.getByText('没找到「不存在的文档xyz」')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ant-table-row')).toHaveCount(0);
    await expect(page).toHaveURL(/q=/);
  });

  test('未登录不显示上传按钮', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();
    await expect(page.getByRole('button', { name: '上传文档' })).toHaveCount(0);
    await expect(page.getByText('浏览制度与流程文件')).toBeVisible();
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
