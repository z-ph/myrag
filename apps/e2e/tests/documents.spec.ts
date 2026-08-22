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

  test('工具栏提供类型、状态、上传年份筛选', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.getByLabel('按类型筛选')).toBeVisible();
    await expect(page.getByLabel('按状态筛选')).toBeVisible();
    await expect(page.getByLabel('按上传年份筛选')).toBeVisible();
  });

  test('关键字搜索过滤列表', async ({ page }) => {
    await page.goto('/documents');
    const search = page.getByPlaceholder('按文件名或正文搜索');
    await search.fill('不存在的文档xyz');
    await expect(page.getByText('没找到「不存在的文档xyz」')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ant-table-row')).toHaveCount(0);
    await expect(page).toHaveURL(/q=/);
  });

  test('未登录不显示上传按钮', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();
    await expect(page.getByRole('button', { name: '上传文档' })).toHaveCount(0);
    await expect(page.getByText('拖入文件或文件夹，或点击选择文件夹')).toHaveCount(0);
    await expect(page.getByText('浏览制度与流程文件')).toBeVisible();
  });
});

test('未登录不显示批量选择', async ({ page }) => {
  await page.goto('/documents');
  await expect(page.locator('.ant-table')).toBeVisible();
  await expect(page.locator('.ant-table-thead .ant-checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批量删除' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批量重建' })).toHaveCount(0);
});


test.describe('文档库批量选择（管理员）', () => {
  test('可勾选多篇并取消选择', async ({ page }) => {
    const token = await apiLogin('admin', 'admin123').catch(() => null);
    test.skip(token === null, '后端未就绪');

    await page.addInitScript((t) => {
      localStorage.setItem('myrag-token', t);
    }, token!);
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();

    const rows = page.locator('.ant-table-row');
    test.skip((await rows.count()) < 2, '文档不足 2 篇');

    await rows.nth(0).locator('.ant-checkbox-input').check();
    await rows.nth(1).locator('.ant-checkbox-input').check();
    await expect(page.getByText('已选 2 篇')).toBeVisible();
    await page.getByRole('button', { name: '取消选择' }).click();
    await expect(page.getByText('已选 2 篇')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '批量删除' })).toHaveCount(0);
  });

  test('表头全选覆盖当前筛选全部结果', async ({ page }) => {
    const token = await apiLogin('admin', 'admin123').catch(() => null);
    test.skip(token === null, '后端未就绪');

    await page.addInitScript((t) => {
      localStorage.setItem('myrag-token', t);
    }, token!);
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();

    const totalText = await page.locator('.ant-pagination-total-text').textContent();
    const total = Number(totalText?.match(/共\s*(\d+)\s*篇/)?.[1] ?? 0);
    test.skip(total < 1, '没有文档');

    await page.locator('.ant-table-thead .ant-checkbox-input').check();
    await expect(page.getByText(`已选 ${total} 篇`)).toBeVisible();
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
