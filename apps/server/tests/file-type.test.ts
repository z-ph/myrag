import { describe, expect, it } from 'vitest';
import { detectFileType } from '../src/modules/documents/process.service';

describe('文档文件类型识别', () => {
  it('识别 HTML 和 HTM 文件', () => {
    expect(detectFileType('制度.html')).toBe('HTML');
    expect(detectFileType('制度.htm')).toBe('HTML');
  });
});
