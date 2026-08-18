/**
 * 检索质量评估：对数据集逐条调用 RagRetriever，输出 recall@5 / MRR / keyword hit rate。
 * 前置：基础设施（postgres / qdrant / redis）+ LLM 端点可用；不启动 HTTP server。
 * 用法：pnpm --filter @myrag/server exec tsx ../../scripts/eval.ts
 * 需自行导出 DB/Qdrant/Redis/LLM 环境变量（项目无 dotenv）。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from '../packages/shared/src/index';
import { createDb } from '../apps/server/src/db/index';
import { createLlmClient } from '../apps/server/src/llm/client';
import { createRagRetriever } from '../apps/server/src/modules/rag/retrieval.service';
import { createSettingsService } from '../apps/server/src/modules/settings/settings.service';
import { createRedisStore } from '../apps/server/src/store/redis';
import { createQdrantStore } from '../apps/server/src/vector/qdrant';

const TOP_K = 5;
const DATASET_PATH = join(dirname(fileURLToPath(import.meta.url)), 'eval-dataset.json');

interface EvalCase {
  question: string;
  expectedDocumentIds: string[];
  expectedKeywords: string[];
  notes?: string;
}

interface RetrievedHit {
  documentId: string;
  filename: string;
  score: number;
  chunkIndex: number;
  text: string;
}

interface CaseMetrics {
  question: string;
  hitCount: number;
  expectedCount: number;
  recallAt5: number;
  mrr: number;
  firstHitRank: number | null;
  keywordHitRate: number;
  hits: RetrievedHit[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseDataset(raw: unknown): EvalCase[] {
  if (!Array.isArray(raw)) {
    throw new Error('eval-dataset.json 必须是数组');
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`数据集第 ${index + 1} 条不是对象`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.question !== 'string' || row.question.trim() === '') {
      throw new Error(`数据集第 ${index + 1} 条缺少 question`);
    }
    if (!isStringArray(row.expectedDocumentIds)) {
      throw new Error(`数据集第 ${index + 1} 条 expectedDocumentIds 必须是字符串数组`);
    }
    if (!isStringArray(row.expectedKeywords)) {
      throw new Error(`数据集第 ${index + 1} 条 expectedKeywords 必须是字符串数组`);
    }
    return {
      question: row.question,
      expectedDocumentIds: row.expectedDocumentIds,
      expectedKeywords: row.expectedKeywords,
      notes: typeof row.notes === 'string' ? row.notes : undefined,
    };
  });
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** recall@5 = 命中的期望文档数 / 期望文档数；无标注时记 0 */
function recallAtK(retrievedIds: string[], expectedIds: string[], k: number): number {
  if (expectedIds.length === 0) return 0;
  const top = new Set(retrievedIds.slice(0, k));
  const hits = unique(expectedIds).filter((id) => top.has(id)).length;
  return hits / unique(expectedIds).length;
}

/** MRR = 第一个命中期望文档的排名倒数；无命中或无标注为 0 */
function meanReciprocalRank(retrievedIds: string[], expectedIds: string[]): { mrr: number; rank: number | null } {
  if (expectedIds.length === 0) return { mrr: 0, rank: null };
  const expected = new Set(expectedIds);
  const index = retrievedIds.findIndex((id) => expected.has(id));
  if (index === -1) return { mrr: 0, rank: null };
  const rank = index + 1;
  return { mrr: 1 / rank, rank };
}

/** 关键词命中率 = top-k 文本中出现的期望关键词数 / 期望关键词数；无标注时记 0 */
function keywordHitRate(texts: string[], keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const blob = texts.join('\n');
  const hit = keywords.filter((kw) => kw !== '' && blob.includes(kw)).length;
  return hit / keywords.length;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function printCase(item: CaseMetrics, index: number): void {
  console.log(`\n[${index + 1}] ${item.question}`);
  if (item.hits.length === 0) {
    console.log('    （无检索结果）');
  } else {
    for (const [i, hit] of item.hits.entries()) {
      console.log(
        `    #${i + 1}  score=${hit.score.toFixed(4)}  chunk=${hit.chunkIndex}  ${hit.filename}  ${hit.documentId}`,
      );
    }
  }
  const rankLabel = item.firstHitRank === null ? '—' : String(item.firstHitRank);
  console.log(
    `    命中 ${item.hitCount}/${item.expectedCount}  recall@5=${fmt(item.recallAt5)}  MRR=${fmt(item.mrr)}  关键词命中率=${fmt(item.keywordHitRate)}  首个命中排名=${rankLabel}`,
  );
}

function printSummary(items: CaseMetrics[]): void {
  console.log('\n—— 明细表 ——');
  console.log(`${pad('问题', 28)}  ${pad('命中', 8)}  ${pad('MRR', 7)}  首个命中排名`);
  for (const item of items) {
    const q = item.question.length > 26 ? `${item.question.slice(0, 25)}…` : item.question;
    const rankLabel = item.firstHitRank === null ? '—' : String(item.firstHitRank);
    console.log(
      `${pad(q, 28)}  ${pad(`${item.hitCount}/${item.expectedCount}`, 8)}  ${pad(fmt(item.mrr), 7)}  ${rankLabel}`,
    );
  }

  const avgRecall = average(items.map((i) => i.recallAt5));
  const avgMrr = average(items.map((i) => i.mrr));
  const avgKw = average(items.map((i) => i.keywordHitRate));
  console.log('\n—— 整体汇总 ——');
  console.log(`用例数               ${items.length}`);
  console.log(`平均 recall@5        ${fmt(avgRecall)}`);
  console.log(`平均 MRR             ${fmt(avgMrr)}`);
  console.log(`平均 keyword hit rate ${fmt(avgKw)}`);
}

async function loadDataset(): Promise<EvalCase[]> {
  const raw = await readFile(DATASET_PATH, 'utf8');
  return parseDataset(JSON.parse(raw) as unknown);
}

async function main(): Promise<void> {
  const dataset = await loadDataset();
  if (dataset.length === 0) {
    console.log('数据集为空，请在 eval-dataset.json 中填充测试用例');
    return;
  }

  const cfg = loadServerConfig();
  const dbHandle = createDb(cfg);
  const redis = createRedisStore(cfg);
  const qdrant = createQdrantStore(cfg);
  const settings = createSettingsService(dbHandle.db, redis);
  const llm = createLlmClient(cfg, settings);
  const retriever = createRagRetriever({ db: dbHandle.db, qdrant, llm, settings });

  try {
    await settings.init();
    await qdrant.ensureCollection();

    const results: CaseMetrics[] = [];
    for (const item of dataset) {
      const docs = await retriever.retrieve(item.question, TOP_K);
      const hits: RetrievedHit[] = docs.map((doc) => ({
        documentId: doc.metadata.documentId,
        filename: doc.metadata.filename,
        score: doc.metadata.score,
        chunkIndex: doc.metadata.chunkIndex,
        text: doc.pageContent,
      }));
      const retrievedIds = hits.map((h) => h.documentId);
      const expected = unique(item.expectedDocumentIds);
      const topIds = new Set(retrievedIds.slice(0, TOP_K));
      const hitCount = expected.filter((id) => topIds.has(id)).length;
      const { mrr, rank } = meanReciprocalRank(retrievedIds, expected);
      results.push({
        question: item.question,
        hitCount,
        expectedCount: expected.length,
        recallAt5: recallAtK(retrievedIds, expected, TOP_K),
        mrr,
        firstHitRank: rank,
        keywordHitRate: keywordHitRate(
          hits.slice(0, TOP_K).map((h) => h.text),
          item.expectedKeywords,
        ),
        hits,
      });
    }

    console.log(`检索评估  top-k=${TOP_K}  数据集=${DATASET_PATH}`);
    results.forEach(printCase);
    printSummary(results);
  } finally {
    settings.close();
    await dbHandle.close();
    await redis.close();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('评估脚本异常:', err);
    process.exit(1);
  });
