import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { LlmClient } from '../llm/client';
import type { FileType } from '@myrag/shared';
import { convertViaLibreOffice } from './libreoffice';

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
export async function parsePdf(buffer: Buffer): Promise<{ text: string; isScanned: boolean }> {
  let text: string;
  try {
    // pdf-parse 2.x：data 会被 transfer 到 worker，传拷贝保住原 buffer（扫描件还需复用做 OCR）
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      text = result.text ?? '';
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    throw new ParseError('PDF 解析失败，文件可能已损坏', err);
  }
  const isScanned = text.replace(/\s+/g, '').length < 50;
  return { text: isScanned ? '' : text, isScanned };
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

/** PDF 扫描件：用 pdf-parse 的 getScreenshot 逐页渲染为 PNG，再逐页发视觉模型 OCR */
export async function parseScannedPdf(
  buffer: Buffer,
  llm: LlmClient,
  onPage?: (done: number, total: number) => void | Promise<void>,
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

  const pages: string[] = [];
  const ocrPages = screenshots.pages.filter((p) => p.data.length > 0);
  let done = 0;
  for (const page of ocrPages) {
    const base64 = Buffer.from(page.data).toString('base64');
    try {
      const text = await llm.visionChat(
        '你是文档 OCR 引擎。请完整提取图片中的全部文字，保持原有段落结构，不要添加任何解释。',
        '请逐字提取图中所有文字内容，按阅读顺序输出。若图片是表格，保留表格结构（用 | 分隔列）。只输出提取的文本，不要任何额外说明。',
        base64,
      );
      if (text.trim()) pages.push(`【第 ${page.pageNumber} 页】\n${text}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('模型服务')) throw err;
      throw new ParseError(`PDF 第 ${page.pageNumber} 页 OCR 失败`, err);
    }
    done += 1;
    await onPage?.(done, ocrPages.length);
  }
  return pages.join('\n\n');
}

/** 图片：视觉模型 OCR 提取文本 */
export async function parseImage(buffer: Buffer, llm: LlmClient): Promise<string> {
  const base64 = buffer.toString('base64');
  if (base64.length > 5 * 1024 * 1024) {
    throw new ParseError('图片过大，请压缩后上传（建议 5MB 以内）');
  }
  const system = '你是文档 OCR 引擎。请完整提取图片中的全部文字，保持原有段落结构，不要添加任何解释。';
  const prompt =
    '请逐字提取图中所有文字内容，按阅读顺序输出。若图片是表格，保留表格结构（用 | 分隔列）。只输出提取的文本，不要任何额外说明。';
  try {
    return await llm.visionChat(system, prompt, base64);
  } catch (err) {
    if (err instanceof Error && err.message.includes('模型服务')) throw err;
    throw new ParseError('图片文字识别失败', err);
  }
}

/** 按文件类型路由解析（图片与 PDF 扫描件需要 llm 做 OCR；onOcrPage 逐页报进度） */
export async function parseDocument(
  fileType: FileType,
  buffer: Buffer,
  llm: LlmClient,
  onOcrPage?: (done: number, total: number) => void | Promise<void>,
): Promise<{ text: string; ocrModel?: string; ocrDurationMs?: number }> {
  const start = Date.now();
  switch (fileType) {
    case 'TEXT':
      return { text: parsePlainText(buffer) };
    case 'PDF': {
      const { text, isScanned } = await parsePdf(buffer);
      if (!isScanned) return { text };
      const ocrText = await parseScannedPdf(buffer, llm, onOcrPage);
      return { text: ocrText, ocrModel: 'vision', ocrDurationMs: Date.now() - start };
    }
    case 'DOCUMENT': {
      // docx 以 PK 头开头；doc 是 OLE（D0 CF 11 E0）
      const text = isOleBuffer(buffer) ? await parseDoc(buffer) : await parseDocx(buffer);
      return { text };
    }
    case 'PRESENTATION':
      // 老二进制 .ppt（OLE）先经 LibreOffice 转 pptx，再走同一解析
      return {
        text: await (isOleBuffer(buffer)
          ? convertViaLibreOffice(buffer, '.ppt', '.pptx').then(parsePptx)
          : parsePptx(buffer)),
      };
    case 'EXCEL':
      // 老二进制 .xls（OLE）先经 LibreOffice 转 xlsx；exceljs 读不了 BIFF 格式
      return {
        text: await (isOleBuffer(buffer)
          ? convertViaLibreOffice(buffer, '.xls', '.xlsx').then(parseSpreadsheet)
          : parseSpreadsheet(buffer)),
      };
    case 'IMAGE': {
      const text = await parseImage(buffer, llm);
      return { text, ocrModel: 'vision', ocrDurationMs: Date.now() - start };
    }
  }
}
