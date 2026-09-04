import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AlignLeftOutlined, PlusCircleOutlined } from '@ant-design/icons';
import { useAuthStore } from './store/auth';
import { isNarrowViewport } from './utils/viewport';
import OverlayScrollbar from './components/OverlayScrollbar';
import AppSidebar from './pages/AppSidebar';
import ChatPage from './pages/ChatPage';
import DocumentsPage from './pages/DocumentsPage';
import AdminPage from './pages/AdminPage';
import UsersPage from './pages/UsersPage';
import LoginModal from './pages/LoginModal';
import { GenericNotFoundPage } from './pages/RouteStatusPage';

export function AppShell() {
  const { user, loading, restore } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void restore();
  }, []);

  // 移动端默认收起侧栏，通过左上角图标打开
  useEffect(() => {
    if (isNarrowViewport()) setSidebarOpen(false);
  }, []);

  // 身份变化（登录/退出/访客重签，含跨标签页同步）后清空会话并进入新会话页
  useEffect(() => {
    const onIdentityChanged = () => navigate('/chat/new', { replace: true });
    window.addEventListener('myrag:identity-changed', onIdentityChanged);
    return () => window.removeEventListener('myrag:identity-changed', onIdentityChanged);
  }, [navigate]);

  const handleMobileNewChat = () => {
    navigate('/chat/new');
  };

  return (
    <div className={`app-shell${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <AppSidebar
        onFold={() => setSidebarOpen(false)}
        onNavigated={() => {
          if (isNarrowViewport()) setSidebarOpen(false);
        }}
      />
      {sidebarOpen && (
        <button type="button" className="chat-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />
      )}
      {!sidebarOpen && (
        <button type="button" className="sidebar-reopen" aria-label="打开侧栏" onClick={() => setSidebarOpen(true)}>
          <AlignLeftOutlined />
        </button>
      )}
      <main className="app-main" ref={mainRef}>
        {/* 窄屏顶栏：左历史、右新对话（仅聊天页显示新对话钮） */}
        <div className="chat-mobile-bar">
          <button type="button" className="chat-mobile-icon" aria-label="打开菜单" onClick={() => setSidebarOpen(true)}>
            <AlignLeftOutlined />
          </button>
          {location.pathname.startsWith('/chat') && (
            <button type="button" className="chat-mobile-icon" aria-label="新对话" onClick={handleMobileNewChat}>
              <PlusCircleOutlined />
            </button>
          )}
        </div>
        {loading ? null : (
          <Routes>
            <Route path="/" element={<Navigate to="/chat/new" replace />} />
            <Route path="/chat" element={<Navigate to="/chat/new" replace />} />
            <Route path="/chat/new" element={<ChatPage />} />
            <Route path="/chat/:conversationId" element={<ChatPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/admin" element={user?.role === 'SUPER_ADMIN' ? <AdminPage /> : <Navigate to="/chat/new" replace />} />
            <Route path="/users" element={user?.role === 'SUPER_ADMIN' ? <UsersPage /> : <Navigate to="/chat/new" replace />} />
            <Route path="*" element={<GenericNotFoundPage />} />
          </Routes>
        )}
        <OverlayScrollbar getScroller={() => mainRef.current} deps={[location.pathname, loading]} />
      </main>
      <LoginModal />
    </div>
  );
}

export default function App() {
  return <AppShell />;
}
