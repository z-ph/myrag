# 上传进度条走完仍显示「等待处理」

日期：2026-08-22

## 现象

- 每个文件的分片上传进度条正常，能跑到 100%。
- 进度条结束后，文件文案停在「等待处理」。
- 底部总进度不对：多文件时几乎只反映最后一个文件，常见 0% 或 100%。

## 根因

上传和处理是两段，前端却按「一个批次」来读状态。

1. `chunkedComplete` 每个文件单独 `createTask([{ filename, buffer }])`，一文件一任务。
2. 面板只把最后一个 `taskId` 交给 `GET /documents/uploads/:taskId`。
3. 文件状态用 `result.documentId === state.taskId || result.originalFilename === file.name` 去对。
   - `state.taskId` 是批次任务 ID，不是 `documentId`，第一段永远对不上。
   - 文件名只在「当前正在轮询的那个任务」里找。前面的文件不在最后一个任务里，只能落到「等待处理…」。
4. 总进度用这一个任务的 `successCount / totalFiles`。一文件任务的 `totalFiles` 恒为 1，所以总条是 0/1 或 1/1，不是 N 个文件的汇总。

单文件时：进度条 100% 后进入真实 `PENDING`，文案也是「等待处理」，等 worker 才变「处理中」。多文件时这个文案被错误复用到已经成功的文件上，看起来像全卡死。

## 为什么现在才发现

- 单文件主路径：条走完 → 等一会儿 → 入库。中间那句「等待处理」会被当成排队，不容易当 bug。
- 多文件才爆：前面的文件可能已经 `SUCCESS`，UI 仍写「等待处理…」，总进度还停在最后一个任务的 0/1。
- 现有测试只覆盖选文件夹 / 拖入列表，没有「上传完成 → 轮询任务 → 画状态 / 总进度」。
- e2e 若只传一个小文件，也打不到「N 个独立 task、只 poll 最后一个」。

## 为什么设计和测试当初没拦住

- 后端已有真正的批量口 `POST /documents/uploads`（一次一个 task）。大文件要分片进度，前端改成「每文件一条分片会话」。`complete()` 为了复用处理队列，随手给每个文件开了一个 task。
- UI 仍按「一个 batchTaskId」建模，没有「N 个 taskId 要汇总」这条契约。
- 进度条测的是分片字节（`i / totalChunks`），状态测的是另一条异步入库链。两条链没有对在一起的测试。
- 状态匹配把 `taskId` 和 `documentId` 写在同一个 `===` 里。这种错在单测里一眼能红，但匹配逻辑当初内嵌在 JSX，没有可测缝。

## 修复

- 每个文件记住自己的 `taskId`，轮询全部任务。
- 按 `taskId` 取该文件结果；单文件任务可回退到 `results[0]`。
- 总进度对全部任务的 `successCount + failureCount` / `totalFiles` 求和。

实现：`apps/web/src/pages/uploadTaskProgress.ts`。回归：`apps/web/tests/uploadTaskProgress.test.ts`。
