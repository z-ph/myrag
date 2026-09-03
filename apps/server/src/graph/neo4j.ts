import type { ServerConfig } from '@myrag/shared';
import { logger } from '../lib/util';
import type { GraphSearchHit, GraphStore } from '../modules/rag/retrieval.service';
import { extractGraphFacts, type GraphFacts, type GraphRelation } from './extractor';

interface Neo4jStatement {
  statement: string;
  parameters?: Record<string, unknown>;
  resultDataContents?: string[];
}

interface Neo4jResponse {
  results?: Array<{ data?: Array<{ row?: unknown[]; graph?: unknown }> }>;
  errors?: Array<{ code?: string; message?: string }>;
}

function graphFactsFor(
  documentId: string,
  filename: string,
  chunks: Array<{ chunkIndex: number; text: string }>,
): GraphFacts[] {
  return chunks.map((chunk) =>
    extractGraphFacts({ documentId, filename, chunkIndex: chunk.chunkIndex, text: chunk.text }),
  );
}

function relationRows(facts: GraphFacts[]) {
  const entities = new Map(facts.flatMap((fact) => fact.entities.map((entity) => [entity.key, entity] as const)));
  return facts.flatMap((fact) =>
    fact.relations.map((relation: GraphRelation) => ({
      ...relation,
      fromName: entities.get(relation.fromKey)?.name ?? relation.fromKey,
      fromType: entities.get(relation.fromKey)?.type ?? 'BUSINESS_CATEGORY',
      toName: entities.get(relation.toKey)?.name ?? relation.toKey,
      toType: entities.get(relation.toKey)?.type ?? 'BUSINESS_CATEGORY',
    })),
  );
}

export function createNeo4jGraphStore(cfg: ServerConfig): GraphStore {
  const enabled = cfg.neo4jEnabled && Boolean(cfg.neo4jUri) && Boolean(cfg.neo4jPassword);

  async function run(statements: Neo4jStatement[]): Promise<Neo4jResponse> {
    if (!enabled) return { results: [], errors: [] };
    const baseUrl = cfg.neo4jUri.replace(/\/+$/, '');
    const url = `${baseUrl}/db/${encodeURIComponent(cfg.neo4jDatabase)}/tx/commit`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${cfg.neo4jUser}:${cfg.neo4jPassword}`).toString('base64')}`,
      },
      body: JSON.stringify({ statements }),
    });
    if (!response.ok) throw new Error(`Neo4j HTTP ${response.status}`);
    const payload = (await response.json()) as Neo4jResponse;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((error) => `${error.code ?? ''} ${error.message ?? ''}`.trim()).join('; '));
    }
    return payload;
  }

  return {
    async upsertDocument(documentId, filename, chunks) {
      if (!enabled) return;
      const facts = graphFactsFor(documentId, filename, chunks);
      const entityRows = facts.flatMap((fact) =>
        fact.entities.map((entity) => ({
          chunkId: fact.chunkId,
          key: entity.key,
          name: entity.name,
          type: entity.type,
        })),
      );
      const rows = facts.map((fact) => ({
        chunkId: fact.chunkId,
        documentId: fact.documentId,
        filename: fact.filename,
        chunkIndex: fact.chunkIndex,
        text: fact.text,
      }));
      try {
        await run([
          {
            statement: 'MATCH (c:Chunk {documentId: $documentId}) DETACH DELETE c',
            parameters: { documentId },
          },
          {
            statement:
              'UNWIND $chunks AS row MERGE (c:Chunk {id: row.chunkId}) SET c.documentId = row.documentId, c.filename = row.filename, c.chunkIndex = row.chunkIndex, c.text = row.text',
            parameters: { chunks: rows },
          },
          {
            statement:
              'UNWIND $mentions AS row MATCH (c:Chunk {id: row.chunkId}) MERGE (e:Entity {key: row.key}) SET e.name = row.name, e.type = row.type MERGE (c)-[:MENTIONS]->(e)',
            parameters: { mentions: entityRows },
          },
          {
            statement:
              'UNWIND $relations AS row MERGE (a:Entity {key: row.fromKey}) SET a.name = row.fromName, a.type = row.fromType MERGE (b:Entity {key: row.toKey}) SET b.name = row.toName, b.type = row.toType MERGE (a)-[r:CONSTRAINT {key: row.key}]->(b) SET r.kind = row.kind, r.description = row.description, r.value = row.value',
            parameters: { relations: relationRows(facts) },
          },
          {
            statement: 'MATCH (e:Entity) WHERE NOT (e)--() DELETE e',
          },
        ]);
      } catch (error) {
        logger.warn('[graph] Neo4j 写入失败，跳过图谱索引:', error);
      }
    },

    async deleteDocument(documentId) {
      if (!enabled) return;
      try {
        await run([
          {
            statement: 'MATCH (c:Chunk {documentId: $documentId}) DETACH DELETE c',
            parameters: { documentId },
          },
          { statement: 'MATCH (e:Entity) WHERE NOT (e)--() DELETE e' },
        ]);
      } catch (error) {
        logger.warn('[graph] Neo4j 删除失败:', error);
      }
    },

    async search(query, topK, documentIds): Promise<GraphSearchHit[]> {
      if (!enabled || topK <= 0) return [];
      const terms = extractGraphFacts({ documentId: '_query', filename: '', chunkIndex: 0, text: query }).entities.map(
        (entity) => entity.name,
      );
      if (terms.length === 0) return [];
      try {
        const payload = await run([
          {
            statement:
              'MATCH (c:Chunk)-[:MENTIONS]->(e:Entity) WHERE any(term IN $terms WHERE toLower(e.name) CONTAINS toLower(term)) AND ($documentIds = [] OR c.documentId IN $documentIds) OPTIONAL MATCH (e)-[r:CONSTRAINT]-(other:Entity) RETURN c.documentId AS documentId, c.filename AS filename, c.chunkIndex AS chunkIndex, c.text AS text, collect(DISTINCT {name: e.name, kind: r.kind, to: other.name, description: r.description, value: r.value}) AS facts, count(DISTINCT e) AS matched ORDER BY matched DESC LIMIT $limit',
            parameters: { terms, documentIds: documentIds ?? [], limit: topK },
            resultDataContents: ['row'],
          },
        ]);
        const rows = payload.results?.[0]?.data ?? [];
        return rows.flatMap((entry) => {
          const row = entry.row;
          if (!row || row.length < 6) return [];
          const [documentId, filename, chunkIndex, text, facts, matched] = row;
          if (typeof documentId !== 'string' || typeof chunkIndex !== 'number' || typeof text !== 'string') return [];
          const factText = Array.isArray(facts)
            ? facts
                .filter((fact): fact is Record<string, unknown> => Boolean(fact && typeof fact === 'object'))
                .map((fact) => `${String(fact.name ?? '')} ${String(fact.kind ?? '')} ${String(fact.to ?? '')}`.trim())
                .filter(Boolean)
                .join('；')
            : '';
          return [{
            documentId,
            filename: typeof filename === 'string' ? filename : documentId,
            chunkIndex,
            text: factText ? `图谱事实：${factText}\n原文片段：${text}` : text,
            score: Math.min(1, Math.max(0, Number(matched) / 2)),
          }];
        });
      } catch (error) {
        logger.warn('[graph] Neo4j 查询失败，降级为其他召回:', error);
        return [];
      }
    },
  };
}
