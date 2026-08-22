import { describe, expect, it } from 'vitest';
import {
  collectFilesFromDataTransfer,
  collectFilesFromEntries,
  isIgnoredUploadName,
  uploadFileKey,
} from '../src/pages/uploadFiles';

function fileOf(name: string, body = 'x'): File {
  return new File([body], name, { type: 'application/octet-stream' });
}

function fileEntry(file: File, fullPath = `/${file.name}`): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath,
    filesystem: {} as FileSystem,
    file: (success) => {
      success(file);
    },
    getParent: () => undefined,
  };
}

function dirEntry(name: string, fullPath: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    filesystem: {} as FileSystem,
    createReader: () => {
      let sent = false;
      return {
        readEntries: (success) => {
          if (sent) {
            success([]);
            return;
          }
          sent = true;
          success(children);
        },
      };
    },
    getFile: () => undefined,
    getDirectory: () => undefined,
    getParent: () => undefined,
  };
}

describe('isIgnoredUploadName', () => {
  it('忽略系统与隐藏文件', () => {
    expect(isIgnoredUploadName('.DS_Store')).toBe(true);
    expect(isIgnoredUploadName('folder/.DS_Store')).toBe(true);
    expect(isIgnoredUploadName('Thumbs.db')).toBe(true);
    expect(isIgnoredUploadName('desktop.ini')).toBe(true);
    expect(isIgnoredUploadName('.gitignore')).toBe(true);
  });

  it('保留正常文档名', () => {
    expect(isIgnoredUploadName('制度.pdf')).toBe(false);
    expect(isIgnoredUploadName('docs/报销.docx')).toBe(false);
  });
});

describe('collectFilesFromEntries', () => {
  it('收集单个文件 entry', async () => {
    const file = fileOf('a.pdf');
    const files = await collectFilesFromEntries([fileEntry(file)]);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('a.pdf');
  });

  it('递归展开文件夹并带上相对路径', async () => {
    const nested = fileOf('报销.pdf');
    const junk = fileOf('.DS_Store');
    const root = dirEntry('制度', '/制度', [
      fileEntry(fileOf('总则.docx'), '/制度/总则.docx'),
      dirEntry('附件', '/制度/附件', [
        fileEntry(nested, '/制度/附件/报销.pdf'),
        fileEntry(junk, '/制度/附件/.DS_Store'),
      ]),
    ]);

    const files = await collectFilesFromEntries([root]);
    expect(files.map((f) => f.webkitRelativePath || f.name).sort()).toEqual([
      '制度/总则.docx',
      '制度/附件/报销.pdf',
    ]);
  });

  it('跳过空 entry 与空文件夹', async () => {
    const empty = dirEntry('空', '/空', []);
    const files = await collectFilesFromEntries([null, undefined, empty]);
    expect(files).toEqual([]);
  });
});

describe('collectFilesFromDataTransfer', () => {
  it('有 webkit entry 时走目录遍历', async () => {
    const file = fileOf('a.pdf');
    const dt = {
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: () => fileEntry(file, '/a.pdf'),
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const files = await collectFilesFromDataTransfer(dt);
    expect(files.map((f) => f.name)).toEqual(['a.pdf']);
  });

  it('没有 entry 时回退到 files', async () => {
    const file = fileOf('b.docx');
    const dt = {
      items: [],
      files: [file],
    } as unknown as DataTransfer;

    const files = await collectFilesFromDataTransfer(dt);
    expect(files).toEqual([file]);
  });
});

describe('uploadFileKey', () => {
  it('优先用相对路径避免重名冲突', () => {
    const a = fileOf('readme.md');
    Object.defineProperty(a, 'webkitRelativePath', { value: 'docs/a/readme.md' });
    const b = fileOf('readme.md');
    Object.defineProperty(b, 'webkitRelativePath', { value: 'docs/b/readme.md' });
    expect(uploadFileKey(a)).not.toBe(uploadFileKey(b));
  });
});
