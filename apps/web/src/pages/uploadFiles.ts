export function isIgnoredUploadName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.startsWith('.') || base === 'Thumbs.db' || base === 'desktop.ini';
}

export function uploadFileKey(file: File): string {
  return file.webkitRelativePath || `${file.name}:${file.size}:${file.lastModified}`;
}

function attachRelativePath(file: File, fullPath: string): File {
  if (file.webkitRelativePath || !fullPath) return file;
  const relative = fullPath.replace(/^\//, '');
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: relative,
    });
  } catch {
    return file;
  }
  return file;
}

function readDirectory(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  const { promise, resolve } = Promise.withResolvers<FileSystemEntry[]>();
  const pump = () => {
    reader.readEntries(
      (batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        pump();
      },
      () => resolve(entries),
    );
  };
  pump();
  return promise;
}

function readFile(entry: FileSystemFileEntry): Promise<File | null> {
  const { promise, resolve } = Promise.withResolvers<File | null>();
  entry.file(
    (file) => resolve(file),
    () => resolve(null),
  );
  return promise;
}

async function collectFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await readFile(entry as FileSystemFileEntry);
    if (!file || isIgnoredUploadName(file.name)) return [];
    return [attachRelativePath(file, entry.fullPath)];
  }
  if (!entry.isDirectory) return [];
  const children = await readDirectory(entry as FileSystemDirectoryEntry);
  const nested = await Promise.all(children.map(collectFromEntry));
  return nested.flat();
}

export async function collectFilesFromEntries(
  entries: Array<FileSystemEntry | null | undefined>,
): Promise<File[]> {
  const nested = await Promise.all(
    entries.filter((entry): entry is FileSystemEntry => entry != null).map(collectFromEntry),
  );
  return nested.flat();
}

export async function collectFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.some((entry) => entry != null)) {
    return collectFilesFromEntries(entries);
  }
  return Array.from(dataTransfer.files ?? []).filter((file) => !isIgnoredUploadName(file.name));
}
