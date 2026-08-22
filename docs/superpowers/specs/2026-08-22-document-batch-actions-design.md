# 文档库批量选择与操作

日期：2026-08-22  
状态：待审阅  
范围：`DocumentsPage` 管理员批量删除、批量重建

## 1. 目标

文档管理员（`STAFF` / `SUPER_ADMIN`）在文档列表勾选多篇后，一次触发删除或重建。不新增 HTTP 接口，复用现有单条接口。

访客、`GUEST`、`USER` 仍只读：无复选框、无批量操作条。

## 2. 非目标

- 不提供批量下载、批量预览、批量「问这篇」
- 不新增 `POST /documents/deletions`、`POST /documents/rebuilds` 等集合接口
- 不改 `docs/business.md` 权限矩阵（能力与单条删除 / 重建相同）
- 不把勾选做成跨筛选条件的持久选择
- 不在本需求里改上传任务进度面板

## 3. 可见性

| 身份 | 行首复选框 | 批量操作条 |
|---|---|---|
| 未登录 / `GUEST` / `USER` | 无 | 无 |
| `STAFF` / `SUPER_ADMIN` | 有 | 已选数量大于 0 时出现 |

判断沿用页面已有的 `isManager`。前端隐藏只是体验层，权限仍由现有 `requireStaff` 强制。

## 4. 交互

### 4.1 选择

- 使用 Ant Design `Table.rowSelection`，`rowKey` 仍为 `documentId`
- 表头全选作用于**当前筛选结果的全部行**，不是当前分页的 10 行
- 翻页保留已选 `documentId`
- 关键字、类型、状态、上传年份任一变化：立即清空选择。批量 mutation 进行中时筛选变更被忽略，见 6.1
- 「取消选择」清空选择，不改变筛选

### 4.2 操作条位置与文案

筛选行左侧保持搜索、筛选、「上传文档」。已选数量大于 0 时，同一 `.docs-toolbar` 右侧出现操作条。窄屏换行到筛选下方，不遮挡文件名列。

操作条文案：

- 计数：`已选 N 篇`
- 按钮：`批量重建`、`批量删除`、`取消选择`

### 4.3 删除

点击「批量删除」打开 `Modal.confirm`，文案：

- 标题：`删除这 N 篇文档？`
- 内容：`删除后不可恢复。`
- 确认按钮：`删除`（危险样式）
- 取消按钮：`返回`

确认后执行批量删除。单行删除仍用现有 `Popconfirm`，行为不变。

### 4.4 重建

点击「批量重建」立即执行，无二次确认（与单行「重建向量」一致）。

## 5. 数据流

列表仍一次拉取全量筛选结果，客户端分页。批量操作不改 `GET /documents`。

| 动作 | 调用 | 并发 |
|---|---|---|
| 批量删除 | 对每个 `documentId` 调用现有 `documentsApi.remove` → `DELETE /documents/{documentId}` | 最多 5 路并行 |
| 批量重建 | 对每个 `documentId` 调用现有 `documentsApi.rebuildDocument` → `POST /documents/{documentId}/rebuild` | 最多 5 路并行 |

重建入队语义与单条相同：`batchService.enqueueSingle`，`jobId = documentId`，重复入队为空操作。不检查文档状态，`PENDING` / `PROCESSING` / `SUCCESS` / `FAILED` 均可选、可删、可重建。

全部请求结束后再 `invalidateQueries({ queryKey: ['documents'] })` 一次，中途不逐条刷新。

## 6. 状态与失败处理

### 6.1 进行中

任一批量 mutation 进行中：

- 操作条按钮进入 loading，不可再点
- 复选框与表头全选禁用
- 筛选、搜索提交忽略（避免清空正在操作的选择）
- 单行删除 / 重建同时禁用

### 6.2 结果提示

用已有 `App.useApp().message`：

| 结果 | 删除 | 重建 |
|---|---|---|
| 全部完成 | `已删除 N 篇` | `已触发 N 篇重建` |
| 部分失败 | `已删除 S / N，F 篇失败：{首条错误}` | `已触发 S / N，F 篇失败：{首条错误}` |
| 全部失败 | `删除失败：{首条错误}` | `重建失败：{首条错误}` |

`S` 为成功数，`F` 为失败数，`N` 为发起时的选中数。错误文案取第一个 rejected 的 `Error.message`，未登录 / 权限不足时复用页面现有 `reportError`（带「去登录」）。

### 6.3 选择收敛

- 成功的 `documentId` 从选中集合移除
- 失败的保留，便于重试
- 全部成功则操作条消失
- 进行中不允许取消选择（避免计数与请求集合不一致）

## 7. 组件边界

不新建路由或 API 模块。改动集中在 `apps/web/src/pages/DocumentsPage.tsx`：

- 选择状态：`selectedRowKeys: string[]`
- 两个 mutation：`removeMany(ids)`、`rebuildMany(ids)`，内部有限并发调用现有单条 API
- `rowSelection` 与操作条只在 `isManager` 为真时挂上

有限并发抽成页面内小函数即可，不先抽公共库。样式沿用 `.docs-toolbar` 的 `space-between` + `flex-wrap`，不为操作条新增视觉体系。

## 8. 验证

不新增后端单测。前端以可观察行为为准。

### 8.1 e2e（`apps/e2e/tests/documents.spec.ts`）

- 未登录：表格可见，无行首 checkbox，无「批量删除」「批量重建」
- 管理员登录且列表至少 2 行：可勾选两行，出现「已选 2 篇」；点「取消选择」后操作条消失
- 表头全选后，计数等于当前筛选结果行数（可大于当前页 10 行）

破坏性删除 / 重建不在 e2e 里对真实库执行。并发与部分失败用页面级测试（若已有 `DocumentsPage` 测试文件则补；否则用抽取的并发辅助函数单测：5 路上限、失败计数、成功 ID 剔除）。

### 8.2 手工核对

管理员勾选含 `FAILED` 的文档批量重建后，列表在现有 3 秒轮询内看到状态变化。访客刷新后仍无勾选。

## 9. 明确不做的歧义裁定

| 议题 | 裁定 |
|---|---|
| 全选范围 | 当前筛选结果全部，不是当前页 |
| 筛选变化时的选择 | 立即清空；批量进行中忽略筛选变更 |
| 是否需要批量接口 | 不需要 |
| 重建是否确认 | 不确认 |
| 删除是否确认 | 一次确认整批，不逐篇确认 |
| 进行中的文档能否入选 | 能 |
| 跨筛选保留勾选 | 不保留 |

## 10. 实施时改动的文件

- `apps/web/src/pages/DocumentsPage.tsx`：选择、操作条、批量 mutation
- `apps/web/src/styles.css`：仅当现有 toolbar 换行不够用时补最小规则
- `apps/web/src/pages/` 或 `apps/web/src/` 下测试：并发辅助或页面行为
- `apps/e2e/tests/documents.spec.ts`：可见性与选择计数
