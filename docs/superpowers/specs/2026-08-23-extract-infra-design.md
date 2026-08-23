# 将 infra 从 myrag 独立为 CWC 仓库

日期：2026-08-23
状态：已批准
范围：把 `infra/` 干净快照到独立仓，myrag 只通过外部 Docker 网络使用底座

## 1. 目标

财务处应用与底座分仓。`postgres` / `qdrant` / `redis` / `minio` 与 vLLM / LiteLLM 不再随 `zph-rag` 发版。其它 CWC 应用可挂同一网络复用。

myrag 应用仓只保留：

- `server` / `web` / `db-init`
- 对外部网络 `cwc-infra_default` 的声明
- README 中的启动前置条件

## 2. 非目标

- 不并入已有 `school/infra`（`2024-shiliuzi/infra`，MySQL + MinIO，给 newlab 用）
- 不把 data 与 LLM 拆成两个远程仓
- 不在 myrag 里加 git submodule / subtree
- 不打开 myrag compose 里已注释的 `cwc-infra_llm` 网络
- 不迁移 Docker volume、不改 compose `name:`
- 不提交任何 `.env`
- 不把 `db-init`、Drizzle 迁移、种子搬进 infra 仓
- 不改应用代码、端口约定、镜像版本（快照当前 `infra/` 即可）
- 不保留 myrag 的 git 历史

## 3. 目标仓

| 项 | 值 |
|---|---|
| 远程 | `https://gdutsyjx.gdut.edu.cn/cwc/git/cwc/cwc-infra.git` |
| 组织 | `cwc`（2026-08-23 由用户 `cwc-admin` 转入） |
| 历史 | 新仓初始提交，无 filter-repo |
| 本地工作副本 | `school/cwc-infra`（与 `myrag` 并列，不是 `school/infra`） |

远程空仓由仓库管理员在 Gitea 创建。空仓未就绪时：本地仓照建，不 `git push`。`myrag/infra/` 删除与第 6 节文档修改仍执行。

## 4. 新仓内容

从当前 `myrag/infra/` 原样拷贝（不含密钥文件）：

```
cwc-infra/
  README.md
  .gitignore
  .env.example
  docker-compose.yml          # name: cwc-infra
  llm/
    .env.example
    docker-compose.yml        # name: cwc-infra-llm
    lite-llm.yaml
```

`.gitignore` 至少忽略 `.env` 与 `llm/.env`。

compose 契约保持现状：

| 项目 | compose `name` | 默认网络名 | 服务 |
|---|---|---|---|
| data | `cwc-infra` | `cwc-infra_default` | `postgres` `qdrant` `redis` `minio` |
| LLM | `cwc-infra-llm` | `cwc-infra_llm` | `vllm-chat` `vllm-embedding` `vllm-ocr` `litellm` |

不改服务名、容器名、volume 名、健康检查、镜像 tag、环境变量名。`name:` 不变，现有 volume（`cwc-infra_postgres-data` 等）继续挂到同一项目。

## 5. 对接契约

myrag 根目录 `docker-compose.yml` 已按外部网络接入，抽走目录后行为不变：

- `networks.data.name = cwc-infra_default`，`external: true`
- `cwc-infra_llm` 保持注释，不在本次打开
- `server` 容器内 `DB_HOST` / `QDRANT_HOST` / `REDIS_HOST` / `MINIO_ENDPOINT` 仍走 data 网络 DNS
- `LLM_BASE_URL` 仍由 myrag `.env` 提供（当前默认 `http://llm:8080`；未加入 llm 网时，按部署机实际可达地址填写）

启动顺序：

1. `cwc-infra` data 栈
2. 需要本地模型时再起 `cwc-infra-llm`
3. myrag `docker compose up`

凭证不同步、不共享文件。实施人员在两边 `.env` 人工保持一致：

| myrag `.env` | infra `.env` |
|---|---|
| `DB_USER` / `DB_PASSWORD` | `DB_USER` / `DB_PASSWORD` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` |
| `LLM_API_KEY` | `llm/.env` 的 `LITELLM_MASTER_KEY` |

`DB_NAME`、`QDRANT_COLLECTION`、`MINIO_BUCKET`、JWT、管理员口令属于应用，只存在 myrag `.env`。

应用库初始化仍由 myrag 的 `db-init` 执行 `apps/server/src/db/init-database.sql`。infra 的 PostgreSQL 只提供实例与角色，不创建业务库。

## 6. myrag 仓改动

- 删除目录 `infra/`（含 `llm/`）
- `README.md`：快速启动改为「先起独立 `cwc-infra`，再起本仓 compose」；目录结构去掉 `infra/`
- 根 `.env.example`：注释从「须与 `infra/.env` 一致」改为「须与 `cwc-infra` 仓对应变量一致」，并写上远程仓库路径
- `docs/infrastructure-upgrade.md` 不改历史记录正文；不把旧升级笔记搬进新仓

`deploy/auto-deploy.sh` 只构建 myrag compose，不拉 infra 仓，本次不改。infra 变更走独立部署。

## 7. 新仓 README 最低内容

- 两个 compose 的启动命令与目录
- 网络名：`cwc-infra_default`、`cwc-infra_llm`
- 应用仓须 `external: true` 挂入，且 data 栈先于应用启动
- 凭证与应用仓人工一致，不提交 `.env`
- 不解释 myrag 业务

## 8. 验证

无应用单测。以 compose 配置与目录边界为准。

- 新仓：`docker compose -f docker-compose.yml config` 与 `docker compose -f llm/docker-compose.yml config` 在提供示例变量后能解析（可用一次性 env，不写真实密钥）
- 新仓工作区无 `.env` / `llm/.env`
- myrag 树内不再存在 `infra/`
- myrag `docker compose config` 仍声明 `cwc-infra_default` 为 external
- myrag 文档不再把 `infra/` 写成本仓子目录
- git 不包含密钥；新仓初始提交只有第 4 节列出的文件

不在本次把 data / LLM 容器真正拉起作为验收（GPU 与已有 volume 在部署机，不在开发机重复 `up`）。

## 9. 明确不做的歧义裁定

| 议题 | 裁定 |
|---|---|
| 独立方式 | 新 CWC 仓，干净快照 |
| 仓名 | `cwc/cwc-infra` |
| data 与 LLM | 同一仓两个 compose |
| myrag 引用 | 只留外部网络，无 submodule |
| llm 网 | 保持注释 |
| 与 `school/infra` | 无关，不合并 |
| 历史 | 不保留 |
| 远程未建好 | 本地仓可先建；myrag 仍删除 `infra/` |
| volume | 靠不变的 compose `name:` 复用 |
| 凭证 | 人工一致，无同步机制 |

## 10. 实施时改动的位置

- 新建：`cwc/cwc-infra`（myrag 仓库外）
- 删除：`infra/`
- 修改：`README.md`、`.env.example`
