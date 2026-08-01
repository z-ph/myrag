import type { ImageUnderstandingResult } from '@myrag/shared';
import type { LlmClient } from '../../llm/client';
import type { ServerConfig } from '@myrag/shared';

/** 图片理解：视觉模型输出 JSON（OCR + 摘要 + 实体 + 聚焦总结） */
export interface ImageService {
  understand(question: string, imageBase64: string): Promise<ImageUnderstandingResult>;
}

const SYSTEM_PROMPT = `你是财务单据与文档的图片理解引擎。请仔细观察图片，输出严格 JSON（不要 Markdown 代码块），字段：
{
  "ocrText": "图片中全部文字的逐字提取",
  "imageSummary": "图片内容一句话摘要",
  "keyEntities": ["关键实体列表，如单据编号、金额、日期、单位名称"],
  "questionFocusedSummary": "针对用户问题的聚焦回答"
}`;

export function createImageService(llm: LlmClient, cfg: ServerConfig): ImageService {
  return {
    async understand(question, imageBase64) {
      const rawAnalysis = await llm.visionChat(
        SYSTEM_PROMPT,
        `用户问题：${question}\n请按协议输出 JSON。`,
        imageBase64,
      );
      // 容错解析：尝试 JSON，失败则退化为整体文本
      const jsonMatch = rawAnalysis.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? safeParseJson(jsonMatch[0]) : null;
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const entities = Array.isArray(parsed?.keyEntities) ? parsed.keyEntities : [];
      return {
        rawAnalysis,
        ocrText: str(parsed?.ocrText) ?? rawAnalysis,
        imageSummary: str(parsed?.imageSummary),
        keyEntities: entities.filter((e): e is string => typeof e === 'string'),
        questionFocusedSummary: str(parsed?.questionFocusedSummary),
      };
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
