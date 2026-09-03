export interface MarkdownPage {
  pageNumber: number;
  text: string;
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

function safeTitle(title: string): string {
  const normalized = title.replace(/[\r\n]+/g, ' ').trim();
  return normalized || '文档';
}

/** 把原生文本包装成可直接进入分块器的 Markdown。 */
export function textToMarkdown(text: string, title?: string): string {
  const body = cleanText(text);
  if (!body) return '';
  return title ? `# ${safeTitle(title)}\n\n${body}` : body;
}

/** 按页组装 OCR 内容，页码边界可供检索和引用保留。 */
export function assembleMarkdown(title: string, pages: MarkdownPage[]): string {
  const heading = `# ${safeTitle(title)}`;
  const sections = pages
    .map((page) => ({ pageNumber: page.pageNumber, text: cleanText(page.text) }))
    .filter((page) => page.text)
    .map((page) => `## 第 ${page.pageNumber} 页\n\n${page.text}`);
  return sections.length > 0 ? [heading, ...sections].join('\n\n') : heading;
}
