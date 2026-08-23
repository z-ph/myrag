# 将 infra 独立为 cwc-infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 myrag 已提交的 `infra/` 干净快照到并列仓 `school/cwc-infra`，myrag 删除该目录后只通过外部网络 `cwc-infra_default` 使用底座。

**Architecture:** 新仓无 myrag 历史。compose `name:` / 网络名 / 服务名保持 HEAD 原样，以便复用已有 Docker volume。myrag 不 submodule。`db-init` 与迁移留在 myrag。

**Tech Stack:** Docker Compose、Git、Gitea（`cwc-admin/cwc-infra`）。

**Spec:** `docs/superpowers/specs/2026-08-23-extract-infra-design.md`

## Global Constraints

- 快照来源是 myrag `HEAD` 的 `infra/`，不是 working tree（working tree 里 `infra/llm` 有其它 session 未提交改动）
- 本地新仓路径：`/Users/zph/Desktop/school/cwc-infra`（与 myrag 并列；禁止写入 `school/infra`）
- 远程：`https://gdutsyjx.gdut.edu.cn/cwc/git/cwc-admin/cwc-infra.git`；空仓未就绪则不 push
- 不提交任何 `.env` / `llm/.env`
- 不改 compose `name:`、网络名、服务名、容器名、volume 名、镜像 tag、环境变量名
- 不打开 myrag 里已注释的 `cwc-infra_llm`
- 不并入 `school/infra`，不加 submodule
- 不把 `db-init` / 迁移 / 种子搬进新仓
- 不 `docker compose up`（验收只跑 `config`）
- 删除 myrag `infra/` 前，把 working tree 相对 HEAD 的 llm 草稿备份到 `docs/.session/infra-llm-wip/`（不入库）
- 每个仓各自 commit；不要把 cwc-infra 文件加进 myrag

## File Structure

- Create: `/Users/zph/Desktop/school/cwc-infra/` — 独立 git 仓
- Create: `/Users/zph/Desktop/school/cwc-infra/.gitignore`
- Create: `/Users/zph/Desktop/school/cwc-infra/README.md`
- Create: `/Users/zph/Desktop/school/cwc-infra/.env.example` — 从 `HEAD:infra/.env.example` 拷
- Create: `/Users/zph/Desktop/school/cwc-infra/docker-compose.yml` — 从 `HEAD:infra/docker-compose.yml` 拷
- Create: `/Users/zph/Desktop/school/cwc-infra/llm/.env.example` — 从 `HEAD:infra/llm/.env.example` 拷
- Create: `/Users/zph/Desktop/school/cwc-infra/llm/docker-compose.yml` — 从 `HEAD:infra/llm/docker-compose.yml` 拷
- Create: `/Users/zph/Desktop/school/cwc-infra/llm/lite-llm.yaml` — 从 `HEAD:infra/llm/lite-llm.yaml` 拷
- Create: `docs/.session/infra-llm-wip/` — 其它 session 的 llm 草稿备份，不 commit
- Modify: `README.md` — 启动前置改为独立 cwc-infra
- Modify: `.env.example` — 注释改为 cwc-infra 仓路径
- Modify: `docs/superpowers/specs/2026-08-23-extract-infra-design.md` — 状态改为已批准
- Delete: `infra/`

---

### Task 1: 建立本地 cwc-infra 快照

**Files:**
- Create: `/Users/zph/Desktop/school/cwc-infra/.gitignore`
- Create: `/Users/zph/Desktop/school/cwc-infra/README.md`
- Create: `/Users/zph/Desktop/school/cwc-infra/.env.example`
- Create: `/Users/zph/Desktop/school/cwc-infra/docker-compose.yml`
- Create: `/Users/zph/Desktop/school/cwc-infra/llm/.env.example`
- Create: `/Users/zph/Desktop/school/cwc-infra/llm/docker-compose.yml`
- Create: `/Users/zph/Desktop/school/cwc-infra/llm/lite-llm.yaml`

**Interfaces:**
- Consumes: myrag `HEAD` 中 `infra/` 六个已跟踪文件
- Produces: 并列目录 `school/cwc-infra`，尚未 `git init`

- [ ] **Step 1: 确认目标目录不存在，且不是 school/infra**

Run:

```bash
test ! -e /Users/zph/Desktop/school/cwc-infra
test -d /Users/zph/Desktop/school/infra
test -d /Users/zph/Desktop/school/myrag
```

Expected: 三条都成功（`cwc-infra` 尚未创建；`school/infra` 与 `myrag` 仍在，不要动它们）。

- [ ] **Step 2: 从 HEAD 拷贝 compose 文件**

在 myrag 仓根目录执行（不要 `cp infra/`，那会带上 working tree 脏文件）：

```bash
DEST=/Users/zph/Desktop/school/cwc-infra
mkdir -p "$DEST/llm"
git show HEAD:infra/.env.example > "$DEST/.env.example"
git show HEAD:infra/docker-compose.yml > "$DEST/docker-compose.yml"
git show HEAD:infra/llm/.env.example > "$DEST/llm/.env.example"
git show HEAD:infra/llm/docker-compose.yml > "$DEST/llm/docker-compose.yml"
git show HEAD:infra/llm/lite-llm.yaml > "$DEST/llm/lite-llm.yaml"
```

Expected: 五个文件非空。`llm/docker-compose.yml` **没有** `split_think.py`。

- [ ] **Step 3: 写 .gitignore 与 README**

Create `/Users/zph/Desktop/school/cwc-infra/.gitignore`:

```
.env
llm/.env
```

Create `/Users/zph/Desktop/school/cwc-infra/README.md`:

````markdown
# cwc-infra

财务处共享底座：PostgreSQL、Qdrant、Redis、MinIO，以及可选的 vLLM / LiteLLM。

应用仓通过 Docker 外部网络接入。本仓不是任何应用仓的子目录。

远程：`https://gdutsyjx.gdut.edu.cn/cwc/git/cwc-admin/cwc-infra.git`

## 网络

| 栈 | compose `name` | 网络 |
|---|---|---|
| data | `cwc-infra` | `cwc-infra_default` |
| LLM | `cwc-infra-llm` | `cwc-infra_llm` |

应用 compose 声明：

```yaml
networks:
  data:
    name: cwc-infra_default
    external: true
```

先起 data 栈，再起应用。需要本地模型时再起 LLM 栈。

## 启动

```bash
cp .env.example .env
docker compose up -d

# 可选
cp llm/.env.example llm/.env
docker compose -f llm/docker-compose.yml up -d
```

`.env` 与 `llm/.env` 不入库。凭证与应用仓对应变量人工保持一致：

- `DB_USER` / `DB_PASSWORD`
- `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`
- `LITELLM_MASTER_KEY` 对应应用仓 `LLM_API_KEY`

本仓不创建业务数据库，不跑迁移。
````

- [ ] **Step 4: 核对目录正好七个文件**

Run:

```bash
find /Users/zph/Desktop/school/cwc-infra -type f | sort
```

Expected 恰好：

```
/Users/zph/Desktop/school/cwc-infra/.env.example
/Users/zph/Desktop/school/cwc-infra/.gitignore
/Users/zph/Desktop/school/cwc-infra/README.md
/Users/zph/Desktop/school/cwc-infra/docker-compose.yml
/Users/zph/Desktop/school/cwc-infra/llm/.env.example
/Users/zph/Desktop/school/cwc-infra/llm/docker-compose.yml
/Users/zph/Desktop/school/cwc-infra/llm/lite-llm.yaml
```

无 `.env`、无 `split_think.py`、无 `myrag` 应用文件。

---

### Task 2: 验收新仓 compose config

**Files:**
- Test: `/Users/zph/Desktop/school/cwc-infra` 上的 `docker compose config`（不写文件）

**Interfaces:**
- Consumes: Task 1 的两个 compose 与两份 `.env.example`
- Produces: 可解析的项目名 `cwc-infra` / `cwc-infra-llm`，网络名 `cwc-infra_default` / `cwc-infra_llm`

- [ ] **Step 1: 解析 data 栈**

```bash
docker compose --project-directory /Users/zph/Desktop/school/cwc-infra --env-file /Users/zph/Desktop/school/cwc-infra/.env.example -f /Users/zph/Desktop/school/cwc-infra/docker-compose.yml config
```

Expected: 退出码 0。输出含 `name: cwc-infra`、`cwc-infra_default`、服务 `postgres` `qdrant` `redis` `minio`。

- [ ] **Step 2: 解析 LLM 栈**

```bash
docker compose --project-directory /Users/zph/Desktop/school/cwc-infra/llm --env-file /Users/zph/Desktop/school/cwc-infra/llm/.env.example -f /Users/zph/Desktop/school/cwc-infra/llm/docker-compose.yml config
```

Expected: 退出码 0。输出含 `name: cwc-infra-llm`、`cwc-infra_llm`、服务 `vllm-chat` `vllm-embedding` `vllm-ocr` `litellm`。

- [ ] **Step 3: 确认未写密钥文件**

```bash
test ! -e /Users/zph/Desktop/school/cwc-infra/.env
test ! -e /Users/zph/Desktop/school/cwc-infra/llm/.env
```

Expected: 两条成功。

---

### Task 3: 初始化 cwc-infra git 仓

**Files:**
- Create: `/Users/zph/Desktop/school/cwc-infra/.git/`

**Interfaces:**
- Consumes: Task 1 的七个文件
- Produces: 独立仓初始提交；remote 仅在 `ls-remote` 成功时添加并 push

- [ ] **Step 1: git init 并做初始提交**

```bash
cd /Users/zph/Desktop/school/cwc-infra
git init
git add .gitignore README.md .env.example docker-compose.yml llm/.env.example llm/docker-compose.yml llm/lite-llm.yaml
git status
git commit -m "$(cat <<'EOF'
feat: snapshot CWC data and LLM compose stack

EOF
)"
```

Expected: `git status` 在 commit 前只暂存上述七个文件。commit 后 `git ls-files` 恰好这七个。working tree 干净。

- [ ] **Step 2: 尝试配置远程并 push**

```bash
cd /Users/zph/Desktop/school/cwc-infra
if git ls-remote https://gdutsyjx.gdut.edu.cn/cwc/git/cwc-admin/cwc-infra.git HEAD >/dev/null 2>&1; then
  git remote add origin https://gdutsyjx.gdut.edu.cn/cwc/git/cwc-admin/cwc-infra.git
  git push -u origin HEAD
else
  echo "REMOTE_NOT_READY skip push"
fi
```

Expected: 远程已建则 push 成功；否则打印 `REMOTE_NOT_READY skip push`，本地仓保留。不要因此失败整个计划。

---

### Task 4: 改 myrag 文档指针

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-08-23-extract-infra-design.md`

**Interfaces:**
- Consumes: 远程 URL `https://gdutsyjx.gdut.edu.cn/cwc/git/cwc-admin/cwc-infra.git`
- Produces: myrag 文档不再把 `infra/` 写成本仓子目录

- [ ] **Step 1: 改 README 目录结构与启动**

`README.md` 目录结构代码块改为：

```
packages/shared/  契约单一真源（zod schema + 常量 + 配置）
apps/server/      Hono + Drizzle + PostgreSQL + Qdrant + Redis（无状态化任务/取消）
apps/web/         React + antd + zustand + react-query（Vite）
apps/e2e/         Playwright 端到端
scripts/          mock-llm（本地 OpenAI 兼容模拟）、smoke.ts（接口冒烟）
docker-compose.yml  server + web + db-init（须先起独立仓 cwc-infra）
```

`## 快速启动` 整段替换为：

````markdown
## 快速启动

底座在独立仓 [cwc-infra](https://gdutsyjx.gdut.edu.cn/cwc/git/cwc-admin/cwc-infra.git)，不在本仓。

```bash
# 1. 先起 data 栈（在 cwc-infra 仓目录）
cp .env.example .env
docker compose up -d

# 2. 再起本仓
cp .env.example .env        # DB / MinIO / LLM 密钥须与 cwc-infra 对应变量一致
docker compose up -d --build
前端 http://localhost:5173（nginx 反代：/api/* → 后端，反代统一加前缀）
后端 http://localhost:8080（无 /api 前缀） API 文档 http://localhost:8080/docs
```

首次启动自动执行数据库迁移并种子内置超级管理员（`admin` / `ADMIN_PASSWORD`，默认 `admin123`）。
````

`### 本地开发` 代码块替换为：

```bash
# 先在 cwc-infra 仓把 data 栈拉起（redis 映射 6380；minio 为必需）
pnpm dev                                  # server :8080 + web :5174
node scripts/mock-llm.ts                  # 无真实 LLM 时冒烟用（:9999）
```

不要再写 `docker compose up -d postgres qdrant redis minio`。

- [ ] **Step 2: 改根 .env.example 注释**

将

```
# 须与 infra/.env 的 DB_USER / DB_PASSWORD 一致
```

改为：

```
# 须与 cwc-infra 仓 .env 的 DB_USER / DB_PASSWORD 一致
# https://gdutsyjx.gdut.edu.cn/cwc/git/cwc-admin/cwc-infra.git
```

将

```
# 须与 infra/llm/.env 的 LITELLM_MASTER_KEY 一致
```

改为：

```
# 须与 cwc-infra 仓 llm/.env 的 LITELLM_MASTER_KEY 一致
```

其它键值不动。

- [ ] **Step 3: spec 状态改为已批准**

`docs/superpowers/specs/2026-08-23-extract-infra-design.md` 第 4 行：

```
状态：已批准
```

- [ ] **Step 4: 文档自检（此时 infra/ 仍在，下一步才删）**

在 myrag 根目录：

```bash
# 启动说明不得再把 postgres/qdrant 当本仓 compose 服务拉起
! grep -n 'docker compose up -d postgres' README.md
grep -n 'cwc-infra' README.md .env.example
```

Expected: 第一条无匹配（退出码 0，因 `!`）。第二条两处文件都能搜到 `cwc-infra`。

---

### Task 5: 删除 myrag/infra 并验收边界

**Files:**
- Create: `docs/.session/infra-llm-wip/`（备份，不 commit）
- Delete: `infra/`
- Modify: 无应用代码

**Interfaces:**
- Consumes: Task 3 已有独立仓；Task 4 文档已改完
- Produces: myrag 树内无 `infra/`；compose 仍声明 external `cwc-infra_default`

- [ ] **Step 1: 备份其它 session 的 llm 草稿**

```bash
mkdir -p docs/.session/infra-llm-wip
git diff HEAD -- infra/ > docs/.session/infra-llm-wip/infra.patch || true
if [ -f infra/llm/split_think.py ]; then
  cp infra/llm/split_think.py docs/.session/infra-llm-wip/split_think.py
fi
ls -la docs/.session/infra-llm-wip
```

Expected: `infra.patch` 存在。若 working tree 有 `split_think.py`，备份里也有。不要 `git add` 这个目录。

- [ ] **Step 2: 从 myrag 删除 infra/**

```bash
git rm -r infra
rm -rf infra
test ! -e infra
```

Expected: `infra/` 不存在。`git status` 显示 `infra/` 下已跟踪文件为 deleted。

- [ ] **Step 3: myrag compose 仍声明外部网络**

需要根 `.env.example` 里全部 `:?` 变量（`SERVER_HOST_PORT` `WEB_HOST_PORT` `VITE_BASE` `DB_USER` `DB_PASSWORD` `DB_NAME` `LLM_BASE_URL` `LLM_API_KEY`）。用 `--env-file .env.example`：

```bash
docker compose --env-file .env.example config
```

Expected: 退出码 0。输出含 `cwc-infra_default` 与 `external: true`。**没有** `cwc-infra_llm` 作为已启用网络（注释保持）。输出服务只有 `db-init` `server` `web`，没有 `postgres` `qdrant` `redis` `minio`。

- [ ] **Step 4: 残留引用检查**

```bash
# 允许：本 spec/plan、历史升级笔记、.session 备份
```

在 myrag 内搜索路径字面量 `infra/`。允许命中：

- `docs/superpowers/specs/2026-08-23-extract-infra-design.md`
- `docs/superpowers/plans/2026-08-23-extract-infra.md`
- `docs/infrastructure-upgrade.md`（历史记录，按 spec 不改）
- `docs/.session/`

不允许命中：`README.md`、`.env.example`、`docker-compose.yml`、`apps/`、`packages/`、`scripts/`、`deploy/`。

- [ ] **Step 5: 提交 myrag**

只暂存本任务与 Task 4 的文件，不要加 `.session/`、不要加其它 session 的未跟踪文件。

```bash
git add README.md .env.example docs/superpowers/specs/2026-08-23-extract-infra-design.md
git add -u infra
git status
git commit -m "$(cat <<'EOF'
chore: extract infra directory into standalone cwc-infra repo

EOF
)"
```

Expected: commit 含 README、`.env.example`、spec 状态、`infra/` 删除。不含 `docs/.session/`。

---

## Self-Review

1. Spec coverage:
   - 新仓干净快照、七文件清单 → Task 1 / 3
   - compose name/网络不变、`config` 验收、不 `up` → Task 2 / 5
   - 不带 `.env` → Task 1 / 2 / 3
   - myrag 删 `infra/`、只留外部网络、不打开 llm 网 → Task 5
   - README / `.env.example` 指针 → Task 4
   - 不改 `docs/infrastructure-upgrade.md`、不改 `deploy/auto-deploy.sh` → 无对应改动任务
   - 远程未就绪跳过 push → Task 3 Step 2
   - 其它 session 草稿不丢 → Task 5 Step 1
2. Placeholder scan: 无 TBD /「类似 Task N」/ 空测试。
3. Type consistency: 网络名全程 `cwc-infra_default` / `cwc-infra_llm`；远程 URL 全程同一条；本地路径全程 `school/cwc-infra`。
