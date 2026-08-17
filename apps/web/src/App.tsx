import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  CommentOutlined,
  FileTextOutlined,
  DashboardOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuthStore } from './store/auth';
import ChatPage from './pages/ChatPage';
import DocumentsPage from './pages/DocumentsPage';
import AdminPage from './pages/AdminPage';
import UsersPage from './pages/UsersPage';
import MyPage from './pages/MyPage';

const NAV_ITEMS = [
  { key: '/chat', icon: <CommentOutlined />, label: '智能问答' },
  { key: '/documents', icon: <FileTextOutlined />, label: '文档库' },
  { key: '/admin', icon: <DashboardOutlined />, label: '管理面板', adminOnly: true },
  { key: '/users', icon: <TeamOutlined />, label: '用户管理', adminOnly: true },
  { key: '/my', icon: <UserOutlined />, label: '我的' },
];

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading, restore } = useAuthStore();

  useEffect(() => {
    void restore();
  }, []);

  const selectedKey = NAV_ITEMS.map((n) => n.key).find((k) => location.pathname.startsWith(k)) ?? '/chat';
  const visibleItems = NAV_ITEMS.filter((n) => !n.adminOnly || user?.role === 'SUPER_ADMIN');

  return (
    <div className="app-shell">
      <header className="topbar">
        <button type="button" className="topbar-brand" onClick={() => navigate('/chat')}>
          <span className="seal">财</span>
          <span className="topbar-title">财务处知识库</span>
        </button>
        <nav className="topbar-nav">
          {visibleItems.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`topbar-nav-item${selectedKey === n.key ? ' active' : ''}`}
              onClick={() => navigate(n.key)}
            >
              <span className="topbar-nav-icon">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {user ? <span className="topbar-user">{user.displayName}</span> : <span className="topbar-user">访客</span>}
        </div>
      </header>
      <main className="app-main">
        {loading ? null : (
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/admin" element={user?.role === 'SUPER_ADMIN' ? <AdminPage /> : <Navigate to="/chat" replace />} />
            <Route path="/users" element={user?.role === 'SUPER_ADMIN' ? <UsersPage /> : <Navigate to="/chat" replace />} />
            <Route path="/my" element={<MyPage />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return <AppShell />;
}
