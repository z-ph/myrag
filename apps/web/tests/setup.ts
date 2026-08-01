import '@testing-library/jest-dom/vitest';
import { beforeEach, vi } from 'vitest';

// antd message 依赖 DOM 容器，测试中降级为 no-op
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    message: {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    },
  };
});

beforeEach(() => {
  localStorage.clear();
});
