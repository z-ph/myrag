import type { SourceReference } from '@myrag/shared';

export function shouldShowAssistantCopy(status: string, text: string): boolean {
  return status !== 'GENERATING' && text.trim().length > 0;
}

/** 提取回答里的「反问」问题（引号包裹、带疑问语义），供点击追问 */
export function extractCounterQuestions(text: string): string[] {
  const out: string[] = [];
  const re = /[「“"]([^」”"\n]{4,60})[」”"]/g;
  const qWords = /什么|多少|如何|是否|哪些|怎么|哪|吗|呢|为什么/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let q = (m[1] ?? '').trim();
    if (!q) continue;
    if (!q.endsWith('？') && !q.endsWith('?')) {
      if (!qWords.test(q)) continue;
      q = `${q}？`;
    }
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, 4);
}

function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim();
}

function followUpsFromSources(sources: SourceReference[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    const title = titleFromFilename(s.filename);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push(`「${title}」还规定了哪些相关内容？`);
  }
  return out;
}

export function buildFollowUpQuestions(text: string, sources: SourceReference[]): string[] {
  const out: string[] = [];
  for (const q of [...extractCounterQuestions(text), ...followUpsFromSources(sources)]) {
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, 4);
}
