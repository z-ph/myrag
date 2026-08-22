---
target: 文档库 DocumentsPage
total_score: 15
p0_count: 2
p1_count: 3
timestamp: 2026-08-19T07-26-35Z
slug: apps-web-src-pages-documentspage-tsx
---
# Critique: 文档库 DocumentsPage

Target: `apps/web/src/pages/DocumentsPage.tsx` + live `http://localhost:5180/documents`

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | 首屏 auth loading 整页空白；批量任务/下载/详情无进度 |
| 2 | Match System / Real World | 1 | 分块/向量/FULL_INDEX/DOCUMENT；眼睛打开的是向量控制台 |
| 3 | User Control and Freedom | 2 | 能关抽屉、能清搜索；删除无撤销，上传中无法取消 |
| 4 | Consistency and Standards | 2 | 问答页有正文预览，文档库却给向量详情；访客可见上传 |
| 5 | Error Prevention | 1 | 访客主 CTA 就是会失败的上传 |
| 6 | Recognition Rather Than Recall | 2 | 只能靠记文件名搜索；图标按钮无可见标签 |
| 7 | Flexibility and Efficiency | 1 | 无排序/筛选/批量/快捷键；搜索要回车 |
| 8 | Aesthetic and Minimalist Design | 2 | 桌面还算干净，但 8 列里文件名最窄；手机乱 |
| 9 | Error Recovery | 1 | 「权限不足」「暂无数据」没有下一步 |
| 10 | Help and Documentation | 1 | 不说明格式/权限/分块含义；页头还教访客去上传 |
| **Total** | | **15/40** | **Poor** |

## Anti-Patterns Verdict

**LLM assessment**: 不像营销站那种 AI slop。问题是「antd 后台 CRUD 直接摊给财务处师生」——熟悉得令人不信任。工程师把检索基础设施（集合名、维度、FULL_INDEX、分块/向量）当成了产品界面。

**Deterministic scan**: `detect.mjs` 对 DocumentsPage / styles / App 返回 0 条。这是 false clean：检测器抓的是渐变字、描边卡、eyebrow，抓不到权限错位和信息架构。

**Visual overlays**: 未注入。页面已在 :5180 运行；检测器无命中，叠加层即使注入也是空的。

## Overall Impression

桌面第一眼像能用的公文库，用 10 秒就露馅：访客被邀请上传然后被打脸；文件名全是省略号；点眼睛看到 `knowledge-base · 维度 2048`。最大机会：按角色拆成「找文件/看原文」和「管索引」，不要让一张表同时服务两种人。

## What's Working

- 顶栏印泥章 + 宋体标题有机关气质，不是又一套 Inter 后台。
- 删除/全量重建有确认，下载对访客公开，符合「制度可查」。
- 桌面表格密度和分页对 41 篇文档勉强能扫。

## Priority Issues

### [P0] 访客的主按钮是会失败的「上传文档」
- **Why**: 业务口径写明访客/USER 只读。页面却把上传做成 primary，点完 Toast「权限不足」，没有去登录。
- **Fix**: `isManager` 才渲染上传/批量；访客改成「按文件名或文号查找」；权限错误带「去登录」。
- **Suggested command**: `$impeccable onboard 文档库角色可见性`

### [P0] 手机端不可用
- **Why**: 顶栏汉字竖排，上传按钮溢出，表格把文件名滚出视口，只剩 DOCUMENT/分块/向量。
- **Fix**: 顶栏收成菜单；文档改卡片列表；文件名永远可见。
- **Suggested command**: `$impeccable adapt 文档库移动端`

### [P1] 眼睛不是预览，是向量控制台
- **Why**: 师生要点开「关于规范福利费使用的通知」，看到的是集合名、2048 维、FULL_INDEX。问答页已经有 `documentsApi.content` 正文预览。
- **Fix**: 默认打开正文/下载；向量详情仅管理员，放进「更多」。
- **Suggested command**: `$impeccable distill 文档详情`

### [P1] 找不到文件：文件名被裁、只能搜文件名、没有分类
- **Why**: 公文名 40–80 字，列宽约 192px。搜索不搜正文/文号，不进 URL，无类型/年度筛选。
- **Fix**: 文件名换行或主力列；搜索提示「文件名或文号」；按文号前缀分组；加「问这篇」。
- **Suggested command**: `$impeccable shape 文档库检索与浏览`

### [P1] 表格在展示基础设施，不是文档
- **Why**: 分块/向量几乎总相同；类型是 DOCUMENT 枚举；状态全表「已入库」。
- **Fix**: 默认列：文件名、类型（PDF/Word）、大小、状态（仅非成功时）、操作。分块/向量进管理员详情。
- **Suggested command**: `$impeccable layout 文档表格`

## Persona Red Flags

**Jordan（第一次来查报销）**: 页头让他上传；主按钮上传；搜「差旅费」若文件名不含这三个字就「暂无数据」；点眼睛看到维度 2048。第二步就会去问同事。

**Alex（文档管理员）**: 没有批量删除、没有失败重试、没有任务进度、大文件没用上已写好的分片上传。两个上传按钮还要他猜。

**Sam（键盘/读屏）**: 下载/详情 32×32、无 aria-label；搜索只有 placeholder；品牌按钮读成「财财务处知识库」。

**Casey（手机）**: 导航竖排，文件名看不见，上传按钮半截在屏外。

**财务处职工 Ming**: 41 份「广工大规字〔202x〕」文件，没有文号/年度/主题导航，只能靠记文件名。

## Cognitive Load

Checklist 失败 6/8：单一焦点、分组决策、视觉层次（手机）、一次一件事、选项≤4、工作记忆、渐进披露。高认知负荷。

决策点超载：搜索 + 上传 + 批量上传 + 8 列表头同时在场。

## Emotional Journey

进页（还行）→ 想找一份制度（文件名全省略，开始烦）→ 点眼睛（被技术名词砸到，信任下降）→ 访客点上传（被「权限不足」打脸，结束在尴尬）。Peak-end 是负的。

## Minor Observations

见对话里的完整 52 点清单。源码比线上更糟：SUCCESS 文案是「已分片向量入库」；`batchTaskId` 只 set 不渲染；`content` / chunked upload API 已实现未接线；列表 `total` 被丢弃。

## Questions to Consider

- 文档库的第一任务是「找到并能打开这份制度」，还是「看索引健不健康」？
- 如果访客根本不该上传，为什么上传是唯一的实心按钮？
- 眼睛按钮如果改成问答里那个正文预览，还需要「向量详情」这个产品概念吗？
