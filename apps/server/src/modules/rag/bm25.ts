/** BM25 打分：CJK 二元组 + 英文词分词，候选集为语料（内存重排） */

/** 将文本分词为词项：CJK 二元组 + 英文/数字词 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let prev: string | undefined;
  for (const ch of text.toLowerCase()) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      if (prev) tokens.push(prev + ch);
      prev = ch;
    } else {
      if (prev) prev = undefined;
    }
  }
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    tokens.push(m[0]);
  }
  return tokens;
}

export interface Bm25Scorer {
  /** 对候选文档打分，返回与输入同序的分数 */
  score(query: string, documents: string[]): number[];
}

export function createBm25Scorer(k1 = 1.5, b = 0.75): Bm25Scorer {
  return {
    score(query, documents) {
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0 || documents.length === 0) {
        return documents.map(() => 0);
      }
      const n = documents.length;
      const docTokens = documents.map(tokenize);
      const docLengths = docTokens.map((t) => t.length);
      const avgdl = docLengths.reduce((a, b) => a + b, 0) / n || 1;

      // 文档频率 df(t)
      const df = new Map<string, number>();
      for (const tokens of docTokens) {
        const seen = new Set(tokens);
        for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
      }
      // 逆文档频率 idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
      const idf = new Map<string, number>();
      for (const t of queryTokens) {
        const d = df.get(t) ?? 0;
        idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
      }

      const scores = docTokens.map((tokens, i) => {
        const len = docLengths[i] ?? 0;
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        let sum = 0;
        for (const t of queryTokens) {
          const f = tf.get(t) ?? 0;
          if (f === 0) continue;
          const denominator = f + k1 * (1 - b + (b * len) / avgdl);
          sum += (idf.get(t) ?? 0) * ((f * (k1 + 1)) / denominator);
        }
        return sum;
      });
      return scores;
    },
  };
}

/** Jaccard 相似度（用于去重） */
export function jaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
