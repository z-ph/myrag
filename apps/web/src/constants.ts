/** 与后端保持一致的文件扩展名白名单 */
export const ALLOWED_EXTENSIONS = [
  '.txt', '.md', '.csv',
  '.pdf',
  '.doc', '.docx',
  '.ppt', '.pptx',
  '.xls', '.xlsx',
  '.html', '.htm',
  '.jpg', '.jpeg', '.png', '.bmp',
] as const;

/** 扩展名 → 类型标签 */
export const EXTENSION_TO_TYPE: Record<string, string> = {
  '.txt': 'TEXT', '.md': 'TEXT', '.csv': 'TEXT',
  '.pdf': 'PDF',
  '.doc': 'DOCUMENT', '.docx': 'DOCUMENT',
  '.ppt': 'PRESENTATION', '.pptx': 'PRESENTATION',
  '.xls': 'EXCEL', '.xlsx': 'EXCEL',
  '.html': 'HTML', '.htm': 'HTML',
  '.jpg': 'IMAGE', '.jpeg': 'IMAGE', '.png': 'IMAGE', '.bmp': 'IMAGE',
};
