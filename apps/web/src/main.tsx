import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { setupAuthEvents } from './store/auth';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// 路由 base 与 vite.config.ts 同源：VITE_BASE 由 define 编译期注入，
// 缺失/格式错误在构建期报错，此处无兜底；
// react-router basename 不接受尾斜杠（除根路径外），仅做 API 格式适配
const VITE_BASE = import.meta.env.VITE_BASE as string;
const routerBasename = VITE_BASE === '/' ? '/' : VITE_BASE.replace(/\/+$/, '');

setupAuthEvents();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1a2138',
          colorLink: '#1a2138',
          colorLinkHover: '#b4382f',
          borderRadius: 8,
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter basename={routerBasename}>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
