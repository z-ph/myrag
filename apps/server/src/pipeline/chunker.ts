/** 文档分块（标题感知 + 段落边界优先 + 重叠窗口） */

export interface TextChunk {
  index: number;
  text: string;
  title?: string;
  keywords?: string;
}

/** 中文/英文句子边界（用于在超长段落中优先断句） */
const SENTENCE_BOUNDARY = /(?<=[。！？!?；;])\s*/;
/** 段落边界 */
const PARAGRAPH_BOUNDARY = /\n\s*\n/;
/** 行边界 */
const LINE_BOUNDARY = /\n/;
/** 标题行：Markdown 标题或短行 */
const TITLE_RE = /^\s{0,3}#{1,6}\s+(.+)$/;
/** 文档日期：2024年12月31日 / 2024-12-31 / 2024/12/31 */
const DATE_RE = /(20\d{2}\s*[年/-]\s*\d{1,2}\s*[月/-]\s*\d{1,2}\s*日?)/;

/** 常见中文停用词（关键词提取用） */
const STOP_WORDS: Record<string, true> = {
  的: true, 了: true, 和: true, 是: true, 在: true, 有: true, 与: true, 及: true,
  或: true, 等: true, 为: true, 对: true, 从: true, 到: true, 之: true, 于: true,
  中: true, 上: true, 下: true, 不: true, 也: true, 就: true, 都: true, 而: true,
  但: true, 并: true, 又: true, 以: true, 可: true, 会: true, 能: true, 要: true,
  将: true, 应: true, 该: true, 此: true, 其: true, 各: true, 按: true, 被: true,
  把: true, '、': true, '，': true, '。': true, '：': true, '；': true, '！': true,
  '？': true, '（': true, '）': true, '(': true, ')': true,
};

/** 提取纯文本的标题：首个标题行；无标题行则取第一行（长度 ≤ 30） */
export function extractTitle(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = TITLE_RE.exec(line);
    if (heading?.[1]) return heading[1].trim();
    if (line.length <= 30 && !line.endsWith('。') && !line.endsWith('：') && !line.endsWith(':')) {
      return line;
    }
  }
  return undefined;
}

/** 提取文档日期（首个匹配） */
export function extractDocumentTime(text: string): string | undefined {
  const match = DATE_RE.exec(text);
  return match?.[1]?.replace(/\s+/g, '');
}

/**
 * 关键词提取：CJK 二元组 + 英文词频统计，过滤停用词，取 topN。
 * 与检索侧 BM25 的 CJK 二元组分词保持一致。
 */
export function extractKeywords(text: string, topN = 5): string {
  const counts = new Map<string, number>();
  const add = (word: string) => {
    if (word.length < 2 || STOP_WORDS[word]) return;
    // 由两个停用字组成的二元组（如“的的”“和和”）同样无信息量
    const [c1, c2] = word;
    if (c1 && c2 && STOP_WORDS[c1] && STOP_WORDS[c2]) return;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  };
  // CJK 二元组
  let prev: string | undefined;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      if (prev) add(prev + ch);
      prev = ch;
    } else {
      prev = undefined;
    }
  }
  // 英文/数字词
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]{1,}/g)) {
    add(m[0].toLowerCase());
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w)
    .join(',');
}

function splitByBoundary(text: string, size: number): string[] {
  const segments: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // 从 size*0.6 位置起向后找最近的句子边界，找不到则硬切
    let cut = -1;
    const from = Math.floor(size * 0.6);
    const window = rest.slice(from, size * 1.4);
    const match = SENTENCE_BOUNDARY.exec(window);
    if (match && match.index >= 0) cut = from + match.index + match[0].length;
    if (cut < 0 || cut >= rest.length) cut = size;
    segments.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) segments.push(rest.trim());
  return segments;
}

/**
 * 分块：按段落/行累积，尽量在段落边界切分；超长段落按句子边界切。
 * overlap 用于保留跨块上下文。
 */
export function chunkText(raw: string, size: number, overlap: number): TextChunk[] {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const paragraphs = text.split(PARAGRAPH_BOUNDARY).map((p) => p.trim()).filter(Boolean);
  const chunks: TextChunk[] = [];

  let buffer = '';
  const flush = () => {
    const content = buffer.trim();
    if (!content) return;
    // 若块超长（单个段落 > size），按句子/硬切细分
    if (content.length > size * 1.5) {
      for (const seg of splitByBoundary(content, size)) {
        chunks.push({ index: chunks.length, text: seg });
      }
    } else {
      chunks.push({ index: chunks.length, text: content });
    }
    // 保留 overlap 尾巴给下一块
    buffer = content.length > overlap ? content.slice(-overlap) : '';
  };

  for (const para of paragraphs) {
    const lines = para.split(LINE_BOUNDARY);
    for (const line of lines) {
      if ((buffer + line).length > size * 1.5) flush();
      buffer += (buffer ? '\n' : '') + line;
    }
    if (buffer.length > size * 1.5) flush();
  }
  flush();

  // 标题/关键词填充
  const docKeywords = extractKeywords(text);
  return chunks.map((chunk, i) => {
    const title = extractTitle(chunk.text);
    return {
      ...chunk,
      index: i,
      title: title ?? undefined,
      keywords: extractKeywords(chunk.text) || docKeywords,
    };
  });
}
