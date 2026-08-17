import { useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, type TableProps } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, UserCreateRequest, UserItem, UserUpdateRequest } from '@myrag/shared';
import { usersApi } from '../api';
import { useAuthStore } from '../store/auth';

/** 管理员可分配的角色（GUEST 由系统签发，不在用户表） */
type AssignableRole = UserCreateRequest['role'];

interface UserForm {
  username?: string;
  displayName: string;
  role: AssignableRole;
}

export default function UsersPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserItem | null>(null);
  const [resetUser, setResetUser] = useState<UserItem | null>(null);
  const [createForm] = Form.useForm<UserForm>();
  const [editForm] = Form.useForm<Omit<UserUpdateRequest, 'enabled'>>();
  const [resetForm] = Form.useForm<{ password: string }>();

  const { data: users, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['users'] });

  const createMutation = useMutation({
    mutationFn: (body: UserCreateRequest) => usersApi.create(body),
    onSuccess: () => {
      message.success('用户创建成功，初始密码为用户名');
      setCreateOpen(false);
      createForm.resetFields();
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: UserUpdateRequest }) => usersApi.update(id, body),
    onSuccess: () => {
      message.success('已更新');
      setEditUser(null);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const resetMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) => usersApi.resetPassword(id, password),
    onSuccess: () => {
      message.success('密码已重置');
      setResetUser(null);
      resetForm.resetFields();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const columns: TableProps<UserItem>['columns'] = [
    { title: '用户名', dataIndex: 'username' },
    { title: '显示名称', dataIndex: 'displayName' },
    {
      title: '角色',
      dataIndex: 'role',
      width: 100,
      render: (v: Role) => (
        <Tag color={v === 'SUPER_ADMIN' ? 'gold' : v === 'STAFF' ? 'blue' : 'default'}>
          {v === 'SUPER_ADMIN' ? '超级管理员' : v === 'STAFF' ? '文档管理员' : '普通用户'}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 90,
      render: (v: boolean, row) => (
        <Switch
          size="small"
          checked={v}
          disabled={row.username === 'admin'}
          onChange={(checked) => updateMutation.mutate({ id: row.id, body: { enabled: checked } })}
        />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      width: 200,
      render: (_, row) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            disabled={row.username === 'admin' || row.id === currentUser?.id}
            onClick={() => {
              setEditUser(row);
              editForm.setFieldsValue({ displayName: row.displayName, role: row.role as AssignableRole });
            }}
          >
            编辑
          </Button>
          <Button type="link" size="small" disabled={row.username === 'admin'} onClick={() => setResetUser(row)}>
            重置密码
          </Button>
          {row.username !== 'admin' && (
            <Popconfirm title={`删除用户「${row.username}」？`} onConfirm={() => void deleteMutation.mutate(row.id)}>
              <Button type="link" size="small" danger>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1>用户管理</h1>
        <p>管理系统账号与角色权限。</p>
      </div>
      <div className="page-card" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={invalidate} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新增用户
          </Button>
        </Space>
      </div>

      <div className="page-card">
        <Table<UserItem>
          rowKey="id"
          loading={isLoading}
          dataSource={users ?? []}
          columns={columns}
          pagination={false}
          size="middle"
        />
      </div>

      {/* 新建用户 */}
      <Modal
        title="新增用户"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={(values) => {
            if (!values.username) return;
            createMutation.mutate({ username: values.username, displayName: values.displayName, role: values.role });
          }}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true, pattern: /^(?!guest-)[a-zA-Z0-9_.-]{2,32}$/, message: '2-32 位字母、数字、下划线、点或连字符，且不以 guest- 开头' }]}>
            <Input placeholder="登录账号，初始密码同用户名" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="USER" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'USER', label: '普通用户' },
                { value: 'STAFF', label: '文档管理员' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑用户 */}
      <Modal
        title={`编辑用户：${editUser?.username ?? ''}`}
        open={editUser != null}
        onCancel={() => setEditUser(null)}
        onOk={() => editForm.submit()}
        confirmLoading={updateMutation.isPending}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(values) => {
            if (editUser) updateMutation.mutate({ id: editUser.id, body: values });
          }}
        >
          <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'USER', label: '普通用户' },
                { value: 'STAFF', label: '文档管理员' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal
        title={`重置密码：${resetUser?.username ?? ''}`}
        open={resetUser != null}
        onCancel={() => setResetUser(null)}
        onOk={() => resetForm.submit()}
        confirmLoading={resetMutation.isPending}
        destroyOnHidden
      >
        <Form
          form={resetForm}
          layout="vertical"
          onFinish={(values) => {
            if (resetUser) resetMutation.mutate({ id: resetUser.id, password: values.password });
          }}
        >
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 6, max: 64, message: '6-64 位' }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
