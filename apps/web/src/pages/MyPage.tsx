import { useState } from 'react';
import { App, Button, Card, Form, Input, Space, Tag, Typography } from 'antd';
import { LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

export default function MyPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { user, login, logout } = useAuthStore();
  const [loading, setLoading] = useState(false);

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      await login(values.username, values.password);
      message.success('登录成功');
      navigate('/chat');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  if (user) {
    return (
      <Card style={{ maxWidth: 480, margin: '40px auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <UserOutlined style={{ fontSize: 48, color: '#1a2138' }} />
          <h2 style={{ margin: '12px 0 4px' }}>{user.displayName}</h2>
          <Typography.Text type="secondary">@{user.username}</Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Tag color={user.role === 'SUPER_ADMIN' ? 'gold' : user.role === 'STAFF' ? 'blue' : 'default'}>
              {user.role === 'SUPER_ADMIN' ? '超级管理员' : user.role === 'STAFF' ? '文档管理员' : '普通用户'}
            </Tag>
          </div>
        </div>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button danger block icon={<LogoutOutlined />} onClick={() => { logout(); message.success('已退出登录'); navigate('/chat'); }}>
            退出登录
          </Button>
        </Space>
      </Card>
    );
  }

  return (
    <Card title="登录" style={{ maxWidth: 420, margin: '40px auto' }}>
      <Form layout="vertical" onFinish={(v) => void handleLogin(v)}>
        <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
          <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading}>
          登录
        </Button>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
          登录后支持：会话持久化、图片问答、文档上传维护。未登录也可使用匿名问答与文档浏览。
        </Typography.Paragraph>
      </Form>
    </Card>
  );
}
