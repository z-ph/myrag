import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'antd';
import {
  CommentOutlined,
  FileTextOutlined,
  DashboardOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import ChatPage from './pages/ChatPage';
import DocumentsPage from './pages/DocumentsPage';
import AdminPage from './pages/AdminPage';
import UsersPage from './pages/UsersPage';
import MyPage from './pages/MyPage';

const { Sider, Content } = Layout;

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
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={200} breakpoint="lg" collapsedWidth={0}>
        <div className="app-logo">财务处知识库</div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={visibleItems.map((n) => ({ key: n.key, icon: n.icon, label: n.label }))}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Content style={{ padding: 16, overflow: 'auto' }}>
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
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return <AppShell />;
}
