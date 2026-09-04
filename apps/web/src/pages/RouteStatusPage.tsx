import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';

interface RouteStatusPageProps {
  title: string;
  description: string;
  actionText: string;
}

function RouteStatusPage({ title, description, actionText }: RouteStatusPageProps) {
  const navigate = useNavigate();

  return (
    <section className="route-status" aria-labelledby="route-status-title">
      <div className="route-status-code">404</div>
      <h1 id="route-status-title">{title}</h1>
      <p>{description}</p>
      <Button type="primary" onClick={() => navigate('/chat/new')}>
        {actionText}
      </Button>
    </section>
  );
}

export function ConversationNotFoundPage() {
  return <RouteStatusPage title="会话不存在" description="未找到对应会话，或当前账号无权访问。" actionText="新建会话" />;
}

export function GenericNotFoundPage() {
  return <RouteStatusPage title="页面不存在" description="你访问的页面不存在。" actionText="返回首页" />;
}

export function RouteLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="route-status" aria-labelledby="route-load-error-title">
      <h1 id="route-load-error-title">加载失败</h1>
      <p>会话加载失败，请重试。</p>
      <Button type="primary" onClick={onRetry}>
        重试
      </Button>
    </section>
  );
}
