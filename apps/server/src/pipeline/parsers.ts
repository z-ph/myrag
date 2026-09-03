import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { extname } from 'node:path';
import type { LlmClient } from '../llm/client';
import type { FileType } from '@myrag/shared';
import { convertToPdf, type LibreOfficeInputExtension } from './libreoffice';
import { assembleMarkdown, textToMarkdown, type MarkdownPage } from './markdown';

/** 解析失败时抛出，message 面向用户 */
export class ParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ParseError';
  }
}

const decoder = new TextDecoder('utf-8');

/** OLE 复合文档魔数（D0 CF 11 E0）：.doc/.ppt/.xls 等老二进制格式共用 */
export function isOleBuffer(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
}

/** 纯文本类（txt/md/csv） */
export function parsePlainText(buffer: Buffer): string {
  return decoder.decode(buffer).replace(/^\uFEFF/, '');
}

/** PDF：优先文本层提取，字符过少（扫描件）抛特殊信号由调用方转 OCR */
export interface ParsedPdfPage {
  pageNumber: number;
  text: string;
}

export async function parsePdf(buffer: Buffer): Promise<{ text: string; isScanned: boolean; pages: ParsedPdfPage[] }> {
  let text: string;
  let pages: ParsedPdfPage[];
  try {
    // pdf-parse 2.x：data 会被 transfer 到 worker，传拷贝保住原 buffer（扫描件还需复用做 OCR）
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      text = result.text ?? '';
      pages = result.pages.map((page) => ({ pageNumber: page.num, text: page.text ?? '' }));
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    throw new ParseError('PDF 解析失败，文件可能已损坏', err);
  }
  const isScanned = pages.every((page) => page.text.replace(/\s+/g, '').length === 0);
  return { text: isScanned ? '' : text, isScanned, pages };
}

/** DOCX */
export async function parseDocx(buffer: Buffer): Promise<string> {
  try {
    // mammoth 声明为旧式非泛型 Buffer，与 node 24 类型不兼容
    const result = await mammoth.extractRawText({ buffer: buffer as unknown as Buffer });
    return result.value ?? '';
  } catch (err) {
    throw new ParseError('DOCX 解析失败，文件可能已损坏', err);
  }
}

/** DOC（旧二进制格式） */
export async function parseDoc(buffer: Buffer): Promise<string> {
  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody() ?? '';
  } catch (err) {
    throw new ParseError('DOC 解析失败，建议转换为 DOCX 后上传', err);
  }
}

/** XLSX/XLS：每行转文本，保留表头与单元格值 */
export async function parseSpreadsheet(buffer: Buffer): Promise<string> {
  try {
    // exceljs 声明了模块内 `Buffer extends ArrayBuffer`，与 node Buffer 类型冲突，无法直接赋值
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      lines.push(`【工作表：${sheet.name}】`);
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values = row.values as unknown[];
        // values[0] 是行号占位
        const cells = values.slice(1).map((v) => (v == null ? '' : String(v).trim()));
        const line = cells.filter(Boolean).join(' | ');
        if (line) lines.push(line);
      });
    });
    return lines.join('\n');
  } catch (err) {
    throw new ParseError('表格解析失败，文件可能已损坏', err);
  }
}

/** PPTX：解压读取 slide XML 文本 */
export async function parsePptx(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = Number(a.match(/slide(\d+)/)?.[1] ?? 0);
        const nb = Number(b.match(/slide(\d+)/)?.[1] ?? 0);
        return na - nb;
      });
    const lines: string[] = [];
    for (const name of slideNames) {
      const xml = await zip.file(name)?.async('string');
      if (!xml) continue;
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1] ?? '').filter(Boolean);
      if (texts.length > 0) {
        lines.push(`【第 ${slideNames.indexOf(name) + 1} 页】`, ...texts);
      }
    }
    return lines.join('\n');
  } catch (err) {
    throw new ParseError('PPTX 解析失败，文件可能已损坏', err);
  }
}

const OCR_SYSTEM_PROMPT =
  '你是文档 OCR 引擎。请完整提取图片中的全部文字，保持原有段落、标题和表格结构，不要添加任何解释。';
const OCR_USER_PROMPT =
  '请逐字提取图中所有文字内容，按阅读顺序输出。表格请转换为 Markdown 表格；无法确认的字符不要猜测。只输出正文，不要添加文件标题、页码或说明。';

/** PDF 扫描件：用 pdf-parse 的 getScreenshot 逐页渲染为 PNG，再逐页发 OCR 专用模型 */
export async function parseScannedPdf(
  buffer: Buffer,
  llm: LlmClient,
  onPage?: (done: number, total: number) => void | Promise<void>,
  title = '文档',
  nativePages: ParsedPdfPage[] = [],
): Promise<string> {
  let screenshots;
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      // desiredWidth=1600 保证清晰度，imageDataUrl=false 跳过 dataUrl（只取 buffer）
      screenshots = await parser.getScreenshot({ desiredWidth: 1600, imageDataUrl: false });
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    throw new ParseError('PDF 渲染失败，无法转图片进行 OCR', err);
  }

  const pages: MarkdownPage[] = nativePages
    .filter((page) => page.text.trim())
    .map((page) => ({ pageNumber: page.pageNumber, text: page.text }));
  const nativePageNumbers = new Set(nativePages.filter((page) => page.text.trim()).map((page) => page.pageNumber));
  const ocrPages = screenshots.pages.filter((page) => page.data.length > 0 && !nativePageNumbers.has(page.pageNumber));
  let done = 0;
  for (const page of ocrPages) {
    const base64 = Buffer.from(page.data).toString('base64');
    try {
      const text = await llm.ocrChat(OCR_SYSTEM_PROMPT, OCR_USER_PROMPT, base64);
      if (text.trim()) pages.push({ pageNumber: page.pageNumber, text });
    } catch (err) {
      if (err instanceof Error && err.message.includes('模型服务')) throw err;
      throw new ParseError(`PDF 第 ${page.pageNumber} 页 OCR 失败`, err);
    }
    done += 1;
    await onPage?.(done, ocrPages.length);
  }
  return pages.length > 0 ? assembleMarkdown(title, pages.sort((a, b) => a.pageNumber - b.pageNumber)) : '';
}

/** 图片：OCR 专用模型提取文本 */
export async function parseImage(buffer: Buffer, llm: LlmClient, title = '图片'): Promise<string> {
  const base64 = buffer.toString('base64');
  if (base64.length > 5 * 1024 * 1024) {
    throw new ParseError('图片过大，请压缩后上传（建议 5MB 以内）');
  }
  try {
    return textToMarkdown(await llm.ocrChat(OCR_SYSTEM_PROMPT, OCR_USER_PROMPT, base64), title);
  } catch (err) {
    if (err instanceof Error && err.message.includes('模型服务')) throw err;
    throw new ParseError('图片文字识别失败', err);
  }
}

/** 从文件名取得 LibreOffice 输入扩展名；无文件名时使用对应大类的现代格式。 */
function sourceExtension(filename: string, fallback: LibreOfficeInputExtension): LibreOfficeInputExtension {
  const ext = extname(filename).toLowerCase();
  const supported: LibreOfficeInputExtension[] = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.html', '.htm'];
  return supported.includes(ext as LibreOfficeInputExtension) ? (ext as LibreOfficeInputExtension) : fallback;
}

/** 统一走 PDF：先读 PDF 文本层，只有扫描件才渲染 PNG 调用 OCR。 */
async function parsePdfAsMarkdown(
  buffer: Buffer,
  llm: LlmClient,
  onOcrPage: ((done: number, total: number) => void | Promise<void>) | undefined,
  title: string,
): Promise<{ text: string; ocrModel?: string; ocrDurationMs?: number }> {
  const start = Date.now();
  const { text, pages } = await parsePdf(buffer);
  const needsOcr = pages.some((page) => !page.text.trim());
  if (!needsOcr) return { text: textToMarkdown(text, title) };
  const ocrText = await parseScannedPdf(buffer, llm, onOcrPage, title, pages);
  return { text: ocrText, ocrModel: 'ocr', ocrDurationMs: Date.now() - start };
}

/** 按文件类型路由解析；Office/HTML 先统一转换 PDF，扫描页再调用 OCR。 */
export async function parseDocument(
  fileType: FileType,
  buffer: Buffer,
  llm: LlmClient,
  onOcrPage?: (done: number, total: number) => void | Promise<void>,
  sourceFilename = '文档',
): Promise<{ text: string; ocrModel?: string; ocrDurationMs?: number }> {
  switch (fileType) {
    case 'TEXT':
      return {
        text: sourceFilename.toLowerCase().endsWith('.md')
          ? parsePlainText(buffer)
          : textToMarkdown(parsePlainText(buffer), sourceFilename),
      };
    case 'PDF':
      return parsePdfAsMarkdown(buffer, llm, onOcrPage, sourceFilename);
    case 'DOCUMENT':
      return parsePdfAsMarkdown(
        await convertToPdf(buffer, sourceExtension(sourceFilename, '.docx')),
        llm,
        onOcrPage,
        sourceFilename,
      );
    case 'PRESENTATION':
      return parsePdfAsMarkdown(
        await convertToPdf(buffer, sourceExtension(sourceFilename, '.pptx')),
        llm,
        onOcrPage,
        sourceFilename,
      );
    case 'EXCEL':
      return parsePdfAsMarkdown(
        await convertToPdf(buffer, sourceExtension(sourceFilename, '.xlsx')),
        llm,
        onOcrPage,
        sourceFilename,
      );
    case 'HTML':
      return parsePdfAsMarkdown(
        await convertToPdf(buffer, sourceExtension(sourceFilename, '.html')),
        llm,
        onOcrPage,
        sourceFilename,
      );
    case 'IMAGE': {
      const start = Date.now();
      const text = await parseImage(buffer, llm, sourceFilename);
      return { text, ocrModel: 'ocr', ocrDurationMs: Date.now() - start };
    }
  }
}
