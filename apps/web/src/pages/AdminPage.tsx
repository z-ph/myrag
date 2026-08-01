import { Card, Col, Row, Statistic } from 'antd';
import { FileTextOutlined, TeamOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { documentsApi, usersApi } from '../api';

export default function AdminPage() {
  const { data: docs } = useQuery({ queryKey: ['documents'], queryFn: () => documentsApi.list() });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() });

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>管理面板</h2>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic title="知识库文档" value={docs?.total ?? 0} prefix={<FileTextOutlined />} />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
              向量分块 {(docs?.documents ?? []).reduce((sum, d) => sum + (d.segmentCount ?? 0), 0)}
            </div>
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="用户账号" value={users?.length ?? 0} prefix={<TeamOutlined />} />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
              管理员 {(users ?? []).filter((u) => u.role === 'SUPER_ADMIN').length} · 文档管理员 {(users ?? []).filter((u) => u.role === 'STAFF').length} · 普通用户 {(users ?? []).filter((u) => u.role === 'USER').length}
            </div>
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="知识库问答" value="流式" />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>向量召回 + BM25 重排 + MMR 去重</div>
          </Card>
        </Col>
      </Row>
      <Card title="运维说明" style={{ marginTop: 16 }}>
        <ul style={{ lineHeight: 2 }}>
          <li>文档上传后异步处理：解析 → 分块 → 向量化 → 入库，可在文档库查看状态。</li>
          <li>「恢复任务」用于接管因服务中断而搁置的批量任务。</li>
          <li>「全量重建」在更换 embedding 模型后使用，会清空向量库重新入库。</li>
          <li>用户管理：创建账号、启停、重置密码（初始密码为用户名）。</li>
        </ul>
      </Card>
    </div>
  );
}
