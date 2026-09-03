/**
 * LibreOffice headless 桥接：老式 OLE 二进制办公文档（.ppt/.xls）转新格式后复用现有解析器。
 * 纯 JS 生态没有 .ppt 解析器，soffice 是唯一无 JVM/Python 的现实路径。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ParseError } from './parsers';

const execFileAsync = promisify(execFile);

/** 单文件转换超时（秒）：50MB 上限的老文档转换通常 <5s，取保守值 */
const CONVERT_TIMEOUT_MS = 60_000;

/** soffice 可执行文件路径（Docker 镜像与常见 Linux 安装均在 PATH） */
const SOFFICE_BIN = process.env.SOFFICE_BIN ?? 'soffice';

/** 探测宿主机是否安装了 LibreOffice（测试跳过与环境降级提示用） */
export async function hasLibreOffice(): Promise<boolean> {
  try {
    await execFileAsync(SOFFICE_BIN, ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export type LibreOfficeInputExtension = '.doc' | '.docx' | '.ppt' | '.pptx' | '.xls' | '.xlsx' | '.html' | '.htm';
export type LibreOfficeOutputExtension = '.pdf' | '.pptx' | '.xlsx';

/**
 * 用 LibreOffice headless 把 buffer 从 fromExt 转换为 toExt，返回转换后的内容。
 * - 独立临时目录 + 独立 UserInstallation profile，批量并发时互不抢锁
 * - --norestore 崩溃恢复不弹恢复向导；密码保护/损坏文件以非零码退出
 */
export async function convertViaLibreOffice(
  buffer: Buffer,
  fromExt: LibreOfficeInputExtension,
  toExt: LibreOfficeOutputExtension,
): Promise<Buffer> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'myrag-lo-'));
    const srcPath = join(dir, `input${fromExt}`);
    // profile 放独立子目录，file:// URL 必须三斜杠起头
    const profileUrl = `file://${join(dir, 'profile')}`;
    await writeFile(srcPath, buffer);
    await execFileAsync(
      SOFFICE_BIN,
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=${profileUrl}`,
        '--convert-to',
        toExt.slice(1),
        '--outdir',
        dir,
        srcPath,
      ],
      { timeout: CONVERT_TIMEOUT_MS },
    );
    return await readFile(join(dir, `input${toExt}`));
  } catch (err) {
    if (err instanceof Error && 'killed' in err && err.killed) {
      throw new ParseError('文档转换超时，请转换为 PDF 后重新上传');
    }
    const code = err instanceof Error && 'code' in err ? (err as { code?: number }).code : undefined;
    if (code === 127 || (err instanceof Error && err.message.includes('ENOENT'))) {
      throw new ParseError('服务器未安装 LibreOffice，无法执行文档转 PDF');
    }
    throw new ParseError('文档转换失败，文件可能已加密或损坏', err);
  } finally {
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 将 Office/HTML 统一转换为 PDF，供后续原生文本提取和逐页 OCR 共用。 */
export function convertToPdf(
  buffer: Buffer,
  fromExt: LibreOfficeInputExtension,
): Promise<Buffer> {
  return convertViaLibreOffice(buffer, fromExt, '.pdf');
}
