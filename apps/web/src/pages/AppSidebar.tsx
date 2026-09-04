import { useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dropdown, message, Popconfirm } from 'antd';
import {
  CommentOutlined,
  DashboardOutlined,
  DeleteOutlined,
  FileTextOutlined,
  LayoutOutlined,
  LogoutOutlined,
  PlusCircleOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../store/auth';
import { useUiStore } from '../store/ui';
import { useChatStore, type ConversationMeta } from '../store/chat';
import OverlayScrollbar from '../components/OverlayScrollbar';

/** 历史会话分组（DeepSeek 侧栏式）：今天 / 7天内 / 30天内 / 按月。传入前需按 updatedAt 降序。 */
interface ConvGroup {
  label: string;
  items: ConversationMeta[];
}

function groupConversations(metas: ConversationMeta[]): ConvGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const today: ConversationMeta[] = [];
  const week: ConversationMeta[] = [];
  const month: ConversationMeta[] = [];
  const older = new Map<string, ConversationMeta[]>();
  for (const meta of metas) {
    if (meta.updatedAt >= startOfToday) today.push(meta);
    else if (meta.updatedAt >= startOfToday - 7 * day) week.push(meta);
    else if (meta.updatedAt >= startOfToday - 30 * day) month.push(meta);
    else {
      const d = new Date(meta.updatedAt);
      const label = `${d.getFullYear()}年${d.getMonth() + 1}月`;
      const bucket = older.get(label);
      if (bucket) bucket.push(meta);
      else older.set(label, [meta]);
    }
  }
  const groups: ConvGroup[] = [];
  if (today.length) groups.push({ label: '今天', items: today });
  if (week.length) groups.push({ label: '7天内', items: week });
  if (month.length) groups.push({ label: '30天内', items: month });
  for (const [label, items] of older) groups.push({ label, items });
  return groups;
}

/** 全局侧栏：菜单（导航）+ 分割线 + 历史会话 + 底部账号，所有页面共用 */
export default function AppSidebar({ onFold, onNavigated }: { onFold: () => void; onNavigated: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const openLogin = useUiStore((s) => s.openLogin);
  const { historyMetas, conversationId, loadConversation, startNewConversation, deleteConversation } = useChatStore();
  const sidebarBodyRef = useRef<HTMLDivElement>(null);

  const NAV_ITEMS = [
    { key: '/chat', icon: <CommentOutlined />, label: '智能问答' },
    { key: '/documents', icon: <FileTextOutlined />, label: '文档库' },
    { key: '/admin', icon: <DashboardOutlined />, label: '管理面板', adminOnly: true },
    { key: '/users', icon: <TeamOutlined />, label: '用户管理', adminOnly: true },
  ].filter((n) => !n.adminOnly || user?.role === 'SUPER_ADMIN');

  const selectedKey = NAV_ITEMS.map((n) => n.key).find((k) => location.pathname.startsWith(k)) ?? '/chat';

  const sortedMetas = useMemo(() => [...historyMetas].sort((a, b) => b.updatedAt - a.updatedAt), [historyMetas]);
  const convGroups = useMemo(() => groupConversations(sortedMetas), [sortedMetas]);

  const go = (key: string) => {
    navigate(key);
    onNavigated();
  };
  const handleNewConversation = () => {
    startNewConversation();
    navigate('/chat');
    onNavigated();
  };
  const pickConversation = (id: string) => {
    void loadConversation(id);
    navigate('/chat');
    onNavigated();
  };

  return (
    <aside className="chat-sidebar" aria-label="导航与历史会话">
      <div className="sidebar-head">
        <span className="sidebar-brand">财务处知识库</span>
        <button type="button" className="sidebar-fold" aria-label="收起侧栏" onClick={onFold}>
          <LayoutOutlined />
        </button>
      </div>
      <nav className="sidebar-nav" aria-label="菜单">
        {NAV_ITEMS.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`sidebar-nav-item${selectedKey === n.key ? ' active' : ''}`}
            onClick={() => go(n.key)}
          >
            <span className="sidebar-nav-icon">{n.icon}</span>
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-divider" role="separator" />
      <div className="sidebar-body" ref={sidebarBodyRef}>
        <button type="button" className="sidebar-new" onClick={handleNewConversation}>
          <PlusCircleOutlined />
          <span>开启新对话</span>
        </button>
        {convGroups.length === 0 ? (
          <div className="sidebar-empty">暂无会话</div>
        ) : (
          convGroups.map((group) => (
            <div key={group.label} className="sidebar-group">
              <div className="sidebar-group-label">{group.label}</div>
              {group.items.map((meta) => (
                <div
                  key={meta.id}
                  role="button"
                  tabIndex={0}
                  className={`sidebar-item${meta.id === conversationId ? ' active' : ''}`}
                  onClick={() => pickConversation(meta.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pickConversation(meta.id);
                    }
                  }}
                >
                  <span className="sidebar-item-title" title={meta.title}>{meta.title}</span>
                  <Popconfirm
                    title="删除该会话？"
                    getPopupContainer={(trigger) => trigger.closest('.chat-sidebar') ?? document.body}
                    onConfirm={(e) => {
                      e?.stopPropagation();
                      void deleteConversation(meta.id);
                    }}
                  >
                    <button type="button" className="sidebar-item-del" aria-label="删除会话" onClick={(e) => e.stopPropagation()}>
                      <DeleteOutlined />
                    </button>
                  </Popconfirm>
                </div>
              ))}
            </div>
          ))
        )}
        <OverlayScrollbar getScroller={() => sidebarBodyRef.current} deps={[convGroups, conversationId]} />
      </div>
      <div className="sidebar-foot">
        {user ? (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'name', label: `${user.displayName}（@${user.username}）`, disabled: true },
                { type: 'divider' },
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: '退出登录',
                  onClick: () => {
                    logout();
                    message.success('已退出登录');
                  },
                },
              ],
            }}
          >
            <button type="button" className="sidebar-user">
              <span className="sidebar-user-avatar" aria-hidden="true"><UserOutlined /></span>
              <span className="sidebar-user-name">{user.displayName}</span>
              <span className="sidebar-user-more" aria-hidden="true">···</span>
            </button>
          </Dropdown>
        ) : (
          <button type="button" className="sidebar-user" onClick={openLogin}>
            <span className="sidebar-user-avatar" aria-hidden="true"><UserOutlined /></span>
            <span className="sidebar-user-name">请登录</span>
            <span className="sidebar-user-more" aria-hidden="true">···</span>
          </button>
        )}
      </div>
    </aside>
  );
}
