export type GraphEntityType = 'PERSON_LEVEL' | 'REGION_LEVEL' | 'BUSINESS_CATEGORY' | 'PROJECT_LEVEL' | 'LIMIT';

export interface GraphEntity {
  key: string;
  name: string;
  type: GraphEntityType;
}

export interface GraphRelation {
  key: string;
  fromKey: string;
  toKey: string;
  kind: 'APPLIES_TO' | 'LIMIT' | 'FORBIDDEN';
  description: string;
  value?: string;
}

export interface GraphFactsInput {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
}

export interface GraphFacts extends GraphFactsInput {
  chunkId: string;
  entities: GraphEntity[];
  relations: GraphRelation[];
}

const ENTITY_RULES: Array<{ type: GraphEntityType; names: string[] }> = [
  {
    type: 'PERSON_LEVEL',
    names: ['正高级职称', '副高级职称', '项目负责人', '管理人员', '研究生', '教职工', '教师', '学生'],
  },
  {
    type: 'REGION_LEVEL',
    names: ['一线城市', '省会城市', '其他地区', '北京', '上海', '广州', '深圳'],
  },
  {
    type: 'PROJECT_LEVEL',
    names: ['重点研发计划', '国家级科研项目', '纵向科研项目', '横向课题', '科研项目'],
  },
  {
    type: 'BUSINESS_CATEGORY',
    names: ['住宿费', '交通费', '差旅费', '设备费', '间接费用', '会议费', '培训费', '报销'],
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addEntity(
  entities: Map<string, GraphEntity>,
  type: GraphEntityType,
  name: string,
): GraphEntity {
  const key = `${type}:${name}`;
  const entity = entities.get(key) ?? { key, name, type };
  entities.set(key, entity);
  return entity;
}

function relationKey(kind: string, fromKey: string, toKey: string, value = ''): string {
  return `${kind}:${fromKey}:${toKey}:${value}`;
}

/**
 * 轻量规则抽取器：把政策中稳定的对象、地域、项目类别、业务类别和额度关系
 * 写入图谱。它不是通用 NLP，而是可解释的领域词典基线，后续可以替换为 LLM/NER。
 */
export function extractGraphFacts(input: GraphFactsInput): GraphFacts {
  const entities = new Map<string, GraphEntity>();
  const relations = new Map<string, GraphRelation>();

  for (const rule of ENTITY_RULES) {
    for (const name of rule.names) {
      if (input.text.includes(name)) addEntity(entities, rule.type, name);
    }
  }

  const allEntities = [...entities.values()];
  const applicable = allEntities.filter((entity) =>
    entity.type === 'PERSON_LEVEL' || entity.type === 'REGION_LEVEL' || entity.type === 'PROJECT_LEVEL',
  );
  const categories = allEntities.filter((entity) => entity.type === 'BUSINESS_CATEGORY');
  for (const subject of applicable) {
    for (const category of categories) {
      const key = relationKey('APPLIES_TO', subject.key, category.key);
      relations.set(key, {
        key,
        fromKey: subject.key,
        toKey: category.key,
        kind: 'APPLIES_TO',
        description: `${subject.name}适用${category.name}`,
      });
    }
  }

  for (const category of categories) {
    const pattern = new RegExp(
      `${escapeRegExp(category.name)}[^。；;\\n]{0,80}?(?:最高|限额|上限|不超过)[^0-9]{0,16}(\\d+(?:\\.\\d+)?)\\s*(元(?:/天|每天)?|万元)`,
      'g',
    );
    for (const match of input.text.matchAll(pattern)) {
      const amount = `${match[1]}${match[2]}`;
      const limit = addEntity(entities, 'LIMIT', amount);
      const key = relationKey('LIMIT', category.key, limit.key, amount);
      relations.set(key, {
        key,
        fromKey: category.key,
        toKey: limit.key,
        kind: 'LIMIT',
        description: `${category.name}限制额度为${amount}`,
        value: amount,
      });
    }
  }

  const categoryByName = new Map(categories.map((entity) => [entity.name, entity]));
  for (const sentence of input.text.split(/[。；;！？!?\n]/)) {
    if (!/(?:不得|禁止|不可|不应)/.test(sentence)) continue;
    const mentioned = [...categoryByName.values()].filter((entity) => sentence.includes(entity.name));
    for (let i = 0; i < mentioned.length; i += 1) {
      for (let j = i + 1; j < mentioned.length; j += 1) {
        const from = mentioned[i]!;
        const to = mentioned[j]!;
        const key = relationKey('FORBIDDEN', from.key, to.key, sentence);
        relations.set(key, {
          key,
          fromKey: from.key,
          toKey: to.key,
          kind: 'FORBIDDEN',
          description: sentence.trim(),
        });
      }
    }
  }

  return {
    ...input,
    chunkId: `${input.documentId}:${input.chunkIndex}`,
    entities: [...entities.values()],
    relations: [...relations.values()],
  };
}
