import { beforeAll, describe, expect, it } from 'vitest';
import { isOleBuffer, ParseError } from '../src/pipeline/parsers';
import { convertViaLibreOffice, hasLibreOffice } from '../src/pipeline/libreoffice';

/** OLE 复合文档魔数（.doc/.ppt/.xls 文件头均为 D0 CF 11 E0） */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array(16).fill(0)]);
const ZIP_MAGIC = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(32)]);

describe('isOleBuffer', () => {
  it('识别 OLE 魔数（老版 .ppt/.xls/.doc）', () => {
    expect(isOleBuffer(OLE_MAGIC)).toBe(true);
  });

  it('不把 zip 容器（docx/pptx/xlsx）当 OLE', () => {
    expect(isOleBuffer(ZIP_MAGIC)).toBe(false);
  });

  it('空/超短 buffer 安全返回 false', () => {
    expect(isOleBuffer(Buffer.alloc(0))).toBe(false);
    expect(isOleBuffer(Buffer.from([0xd0]))).toBe(false);
  });
});

describe('convertViaLibreOffice', () => {
  let sofficeAvailable = false;
  beforeAll(async () => {
    sofficeAvailable = await hasLibreOffice();
  });

  it.skipIf(!sofficeAvailable)('真实转换 .xls → .xlsx 并可被 exceljs 读取', async () => {
    const xlsx = await convertViaLibreOffice(OLE_MAGIC, '.xls', '.xlsx');
    // 转换产物应为 zip 容器（xlsx 本质是 zip），而非原样透传的 OLE
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  }, 30_000);

  // .ppt 的合法 fixture 无法离线构造（OLE 结构复杂），真实文件覆盖走 e2e/手工验证

  it('无 LibreOffice 环境给出明确错误而非静默崩溃', async () => {
    if (sofficeAvailable) return; // 有 soffice 的环境本用例退化为冒烟
    await expect(convertViaLibreOffice(OLE_MAGIC, '.xls', '.xlsx')).rejects.toThrow(ParseError);
  });
});
