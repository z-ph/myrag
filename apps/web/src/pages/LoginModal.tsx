import { useState } from 'react';
import { App, Form, Input, Modal, Button, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { useAuthStore } from '../store/auth';
import { useUiStore } from '../store/ui';

/** 全局登录弹窗：未登录时从侧栏 / 我的页唤起，替代独立登录页 */
export default function LoginModal() {
  const { message } = App.useApp();
  const { loginOpen, closeLogin } = useUiStore();
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      await login(values.username, values.password);
      message.success('登录成功');
      form.resetFields();
      closeLogin();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={loginOpen && !user}
      title="登录"
      width={400}
      footer={null}
      onCancel={() => {
        form.resetFields();
        closeLogin();
      }}
    >
      <Form form={form} layout="vertical" onFinish={(v) => void handleLogin(v)} style={{ marginTop: 16 }}>
        <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
          <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading}>
          登录
        </Button>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12, marginBottom: 0 }}>
          登录后支持：会话持久化、图片问答、文档上传维护。未登录也可使用匿名问答与文档浏览。
        </Typography.Paragraph>
      </Form>
    </Modal>
  );
}
