import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '@myrag/shared';

describe('发明初稿本地模型配置', () => {
  it('读取独立交叉编码器和知识图谱服务配置', () => {
    const cfg = loadServerConfig({
      LLM_BASE_URL: 'http://llm.local/v1',
      LLM_API_KEY: 'local-key',
      LLM_CHAT_MODEL: 'chat',
      LLM_EMBEDDING_MODEL: 'embedding',
      LLM_VISION_MODEL: 'vision',
      LLM_OCR_MODEL: 'ocr',
      RERANK_BASE_URL: 'http://reranker.local',
      RERANK_MODEL: 'bge-reranker-v2-m3',
      NEO4J_URI: 'http://neo4j.local:7474',
      NEO4J_USER: 'neo4j',
      NEO4J_PASSWORD: 'graph-secret',
    });

    expect(cfg.rerankBaseUrl).toBe('http://reranker.local');
    expect(cfg.rerankModel).toBe('bge-reranker-v2-m3');
    expect(cfg.neo4jUri).toBe('http://neo4j.local:7474');
    expect(cfg.neo4jUser).toBe('neo4j');
    expect(cfg.neo4jPassword).toBe('graph-secret');
  });
});
