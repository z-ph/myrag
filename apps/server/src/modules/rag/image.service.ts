import { z } from 'zod';
import type { ImageUnderstandingResult } from '@myrag/shared';
import type { LlmClient } from '../../llm/client';
import { logger } from '../../lib/util';

/** 图片理解：视觉模型输出 OCR + 摘要 + 实体 + 聚焦总结 */
export interface ImageService {
  understand(question: string, imageBase64: string): Promise<ImageUnderstandingResult>;
}

/**
 * 视觉结构化输出 schema（langchain withStructuredOutput）。
 * 不含 rawAnalysis（由服务层根据成功路径写入）。
 */
export const imageAnalysisSchema = z.object({
  ocrText: z.string().describe('图片中全部文字的逐字提取'),
  imageSummary: z.string().describe('图片内容一句话摘要'),
  keyEntities: z.array(z.string()).describe('关键实体，如单据编号、金额、日期、单位名称'),
  questionFocusedSummary: z.string().describe('针对用户问题的聚焦回答'),
});

export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;

const SYSTEM_PROMPT = `你是财务单据与文档的图片理解引擎。请仔细观察图片，提取文字与关键信息。`;

const STRUCTURED_USER_PROMPT = (question: string) =>
  `用户问题：${question}\n请分析图片并按约定字段返回结构化结果。`;

const FALLBACK_USER_PROMPT = (question: string) =>
  `用户问题：${question}\n请输出严格 JSON（不要 Markdown 代码块），字段：
{
  "ocrText": "图片中全部文字的逐字提取",
  "imageSummary": "图片内容一句话摘要",
  "keyEntities": ["关键实体列表，如单据编号、金额、日期、单位名称"],
  "questionFocusedSummary": "针对用户问题的聚焦回答"
}`;

/** 将结构化分析结果归一为 API 契约 ImageUnderstandingResult */
export function toImageUnderstanding(analysis: ImageAnalysis, rawAnalysis?: string): ImageUnderstandingResult {
  return {
    rawAnalysis: rawAnalysis ?? JSON.stringify(analysis),
    ocrText: analysis.ocrText || undefined,
    imageSummary: analysis.imageSummary || undefined,
    keyEntities: analysis.keyEntities.filter((e) => typeof e === 'string' && e.length > 0),
    questionFocusedSummary: analysis.questionFocusedSummary || undefined,
  };
}

/**
 * 自由文本 JSON 回退解析（网关不支持 function calling / structured output 时使用）。
 * 兼容：纯 JSON、Markdown 代码块包裹、前后杂文。
 */
export function parseImageAnalysisText(rawAnalysis: string): ImageUnderstandingResult {
  const cleaned = rawAnalysis.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? safeParseJson(jsonMatch[0]) : null;
  if (!parsed) {
    return {
      rawAnalysis,
      ocrText: rawAnalysis,
      imageSummary: undefined,
      keyEntities: [],
      questionFocusedSummary: undefined,
    };
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const entities = Array.isArray(parsed.keyEntities) ? parsed.keyEntities : [];
  return {
    rawAnalysis,
    ocrText: str(parsed.ocrText) ?? rawAnalysis,
    imageSummary: str(parsed.imageSummary),
    keyEntities: entities.filter((e): e is string => typeof e === 'string'),
    questionFocusedSummary: str(parsed.questionFocusedSummary),
  };
}

export function createImageService(llm: LlmClient): ImageService {
  return {
    async understand(question, imageBase64) {
      // 1) 优先 langchain withStructuredOutput（类型安全、字段校验）
      try {
        const analysis = await llm.visionStructured(imageAnalysisSchema, {
          system: SYSTEM_PROMPT,
          prompt: STRUCTURED_USER_PROMPT(question),
          imageBase64,
        });
        return toImageUnderstanding(analysis);
      } catch (err) {
        logger.warn(
          `[image] structured vision 失败，回退自由文本 JSON：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 2) 回退：自由文本 + 本地 JSON 解析（兼容不完整 OpenAI 网关 / mock-llm）
      const rawAnalysis = await llm.visionChat(SYSTEM_PROMPT, FALLBACK_USER_PROMPT(question), imageBase64);
      return parseImageAnalysisText(rawAnalysis);
    },
  };
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
