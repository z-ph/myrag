import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentUploadPanel } from '../src/pages/DocumentUploadPanel';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App>
        <DocumentUploadPanel open onClose={() => {}} onSubmitted={() => {}} onError={() => {}} />
      </App>
    </QueryClientProvider>,
  );
}

function folderInput(): HTMLInputElement {
  const el = document.querySelector('input[webkitdirectory]') as HTMLInputElement | null;
  if (!el) throw new Error('missing folder input');
  return el;
}

describe('DocumentUploadPanel folder select', () => {
  it('提供带 webkitdirectory 的隐藏 input', () => {
    mount();
    expect(folderInput()).toBeTruthy();
    expect(folderInput().multiple).toBe(true);
  });

  it('点击拖拽区会触发选择文件夹', () => {
    mount();
    const clicks: Event[] = [];
    const input = folderInput();
    input.addEventListener('click', (e) => {
      e.preventDefault();
      clicks.push(e);
    });
    fireEvent.click(screen.getByText('拖入文件或文件夹，或点击选择文件夹'));
    expect(clicks).toHaveLength(1);
  });

  it('选择文件夹按钮同样打开目录选择器', () => {
    mount();
    const clicks: Event[] = [];
    folderInput().addEventListener('click', (e) => {
      e.preventDefault();
      clicks.push(e);
    });
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
    expect(clicks).toHaveLength(1);
  });

  it('拖入文件后进入待上传列表', async () => {
    mount();
    const file = new File(['x'], '制度.pdf', { type: 'application/pdf' });
    fireEvent.drop(document.querySelector('.docs-drop')!, {
      dataTransfer: { items: [], files: [file], dropEffect: 'copy' },
    });
    await waitFor(() => {
      expect(screen.getByText('制度.pdf')).toBeTruthy();
    });
  });
});
