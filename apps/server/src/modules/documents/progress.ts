/**
 * 单文件处理进度模型（真实进度）。
 *
 * 处理管线固定四阶段：parse（解析/OCR）→ chunk（分块）→ embed（向量化）→ write（写入）。
 * 整体进度 = Σ 阶段权重 × 阶段内完成度。阶段内完成度由真实工作单元驱动：
 * - parse：扫描件 OCR 按「已完成页 / 总页数」推进；非 OCR 解析完成即到 100%
 * - chunk：纯 CPU 快速操作，完成即到 100%
 * - embed：按「已向量化块 / 总块数」推进（LLM 主成本）
 * - write：按「已写入点 / 总点数」分批推进
 *
 * 进度单调不减；不再使用 5/30/35/88/95 这类固定里程碑伪进度。
 */

export type ProcessStage = 'parse' | 'chunk' | 'embed' | 'write';

export interface ProgressEvent {
  /** 当前阶段 */
  stage: ProcessStage;
  /** 该阶段内部完成度 0..1 */
  fraction: number;
  /** 加权后的整体完成度 0..100（整数） */
  percent: number;
  /** 当前阶段真实单元：已完成数（OCR 页数 / 向量化块数 / 写入点数） */
  done?: number;
  /** 当前阶段真实单元：总数 */
  total?: number;
}

export type ProgressReporter = (event: ProgressEvent) => void | Promise<void>;

/**
 * 阶段权重：反映各阶段在单文件处理中的相对成本占比。
 * embed 是 LLM 调用主成本；parse 在扫描件 OCR 场景同样昂贵；
 * chunk 是纯 CPU 快速操作；write 随向量点数增长。
 */
export const STAGE_WEIGHTS: Record<ProcessStage, number> = {
  parse: 0.2,
  chunk: 0.08,
  embed: 0.52,
  write: 0.2,
};

export type ProgressSink = (event: ProgressEvent) => void | Promise<void>;

/** 阶段内部进度上报器：stage + 完成度 + 可选真实单元计数 */
export type StageReporter = (
  stage: ProcessStage,
  fraction: number,
  done?: number,
  total?: number,
) => void | Promise<void>;

/**
 * 创建进度追踪器：把各阶段内部完成度按权重折合成整体进度。
 * 每个阶段 fraction 只增不减，保证整体进度单调；单元计数（done/total）原样透传。
 */
export function createProgressTracker(sink: ProgressSink): StageReporter {
  const fractions: Record<ProcessStage, number> = { parse: 0, chunk: 0, embed: 0, write: 0 };
  return (stage, fraction, done, total) => {
    const f = Math.min(1, Math.max(0, fraction));
    if (f > fractions[stage]) fractions[stage] = f;
    const raw = (Object.keys(STAGE_WEIGHTS) as ProcessStage[]).reduce(
      (sum, s) => sum + STAGE_WEIGHTS[s] * fractions[s],
      0,
    );
    const percent = Math.round(Math.min(1, raw) * 100);
    return sink({ stage, fraction: fractions[stage], percent, done, total });
  };
}

/** 阶段展示名（供前端与日志共用） */
export const STAGE_LABEL: Record<ProcessStage, string> = {
  parse: '解析',
  chunk: '分块',
  embed: '向量化',
  write: '写入',
};
