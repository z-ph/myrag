/**
 * 端到端冒烟测试：验证核心业务链路。
 * 前置：基础设施（mysql/qdrant/redis）+ mock-llm + server 已就绪。
 * 用法：pnpm tsx scripts/smoke.ts
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8080';
const ADMIN = { username: process.env.ADMIN_USERNAME ?? 'admin', password: process.env.ADMIN_PASSWORD ?? 'admin123' };

let passed = 0;
let failed = 0;
let token = '';

function check(name: string, ok: boolean, extra?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${extra ? ` (${extra})` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 非 JSON
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log('[1] 健康检查');
  const health = await json('/health');
  check('GET /health', health.status === 200);

  console.log('[2] OpenAPI 文档');
  const spec = await fetch(`${BASE}/openapi.json`);
  const specBody = (await spec.json()) as { paths?: Record<string, unknown>; components?: { securitySchemes?: unknown } };
  check('openapi.json 生成', spec.status === 200 && !!specBody.paths);
  check('文档包含路由', (specBody.paths ? Object.keys(specBody.paths).length : 0) >= 25, `${Object.keys(specBody.paths ?? {}).length} 条路径`);
  check('安全方案已注册', !!specBody.components?.securitySchemes);
  const docs = await fetch(`${BASE}/docs`);
  check('Scalar UI 可访问', docs.status === 200 && (await docs.text()).includes('scalar'));

  console.log('[3] 认证');
  const login = await json('/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) });
  const loginData = login.body as { data?: { token?: string; user?: { role?: string } } };
  check('登录成功', login.status === 200 && typeof loginData.data?.token === 'string');
  token = loginData.data?.token ?? '';
  check('超级管理员角色', loginData.data?.user?.role === 'SUPER_ADMIN');

  const me = await json('/auth/me');
  check('GET /auth/me', me.status === 200 && (me.body as { data?: { username?: string } }).data?.username === ADMIN.username);

  const badLogin = await json('/auth/login', { method: 'POST', body: JSON.stringify({ username: ADMIN.username, password: 'wrong' }) });
  check('错误密码拒绝', badLogin.status === 401);

  console.log('[4] 文档上传与处理');
  const uniq = Date.now().toString(36);
  const txt = `差旅费报销管理办法（修订版 ${uniq}）：出差人员凭发票与行程单报销，住宿费按城市等级限额，伙食补助每日 100 元。`;
  const form = new FormData();
  form.append('file', new File([txt], `差旅费管理办法-${uniq}.txt`, { type: 'text/plain' }));
  const upload = await json('/documents/upload', { method: 'POST', body: form });
  const uploadData = upload.body as { data?: { documentId?: string; success?: boolean; segmentCount?: number; status?: string } };
  check('上传并入库', upload.status === 200 && uploadData.data?.success === true, `分块 ${uploadData.data?.segmentCount}`);
  const documentId = uploadData.data?.documentId ?? '';

  const list = await json('/documents');
  const listData = list.body as { data?: { documents?: unknown[]; total?: number } };
  check('文档列表', list.status === 200 && (listData.data?.total ?? 0) >= 1);

  const detail = await json(`/documents/${documentId}/vector-detail`);
  const detailData = detail.body as { data?: { indexedPointCount?: number; points?: unknown[] } };
  check('向量详情', detail.status === 200 && (detailData.data?.indexedPointCount ?? 0) >= 1);

  const dl = await fetch(`${BASE}/documents/${documentId}/download`);
  check('下载文档', dl.status === 200 && dl.headers.get('content-disposition')?.includes('attachment'));

  console.log('[5] 检索问答（SSE 流式）');
  const convId = `smoke-${Date.now().toString(36)}`;
  const sseForm = new FormData();
  sseForm.append('question', '差旅费住宿报销标准是什么？');
  sseForm.append('conversationId', convId);
  const sseRes = await fetch(`${BASE}/rag/ask/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: sseForm,
  });
  const sseText = await sseRes.text();
  const events = [...sseText.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  check('SSE 事件流完整', events.includes('start') && events.includes('delta') && events.includes('complete'), events.join(','));
  check('SSE 含来源', events.includes('sources'));
  check('SSE 回答非空', /【Mock 回答】/.test(sseText));

  console.log('[6] 会话管理');
  const convs = await json('/rag/conversations');
  const convData = convs.body as { data?: { conversationId?: string }[] };
  check('会话列表包含新会话', (convData.data ?? []).some((c) => c.conversationId === convId));
  const convDetail = await json(`/rag/conversations/${convId}`);
  const convDetailData = convDetail.body as { data?: { exists?: boolean; recentMessages?: unknown[] } };
  check('会话详情持久化', convDetailData.data?.exists === true && (convDetailData.data?.recentMessages?.length ?? 0) === 2);

  console.log('[7] 公开接口（无登录）');
  const publicListRes = await fetch(`${BASE}/documents`);
  const publicList = (await publicListRes.json()) as { data?: { documents?: unknown[] } };
  check('文档列表公开可访问', publicListRes.status === 200 && (publicList.data?.documents?.length ?? 0) >= 1);
  const anon = await json('/rag/ask/anonymous', {
    method: 'POST',
    body: JSON.stringify({ question: '什么是差旅费？', contextMessages: [], maxResults: 5 }),
  });
  const anonData = anon.body as { data?: { answer?: string } };
  check('匿名问答有回答', anon.status === 200 && typeof anonData.data?.answer === 'string' && anonData.data.answer.length > 0);

  console.log('[8] 批量上传与用户管理');
  const batchForm = new FormData();
  batchForm.append('files', new File([`采购审批流程（${uniq}）：金额一万元以上需分管领导审批。`], `采购流程-${uniq}.md`, { type: 'text/markdown' }));
  batchForm.append('files', new File([`差旅费发票粘贴规范（${uniq}）：粘贴单上注明事由与金额。`], `发票粘贴-${uniq}.txt`, { type: 'text/plain' }));
  const batch = await json('/documents/batch-upload', { method: 'POST', body: batchForm });
  const batchData = batch.body as { data?: { taskId?: string; totalFiles?: number } };
  check('批量任务创建', batch.status === 200 && batchData.data?.totalFiles === 2, `task=${batchData.data?.taskId}`);
  await new Promise((r) => setTimeout(r, 1500));
  const task = await json(`/documents/batch-upload/${batchData.data?.taskId ?? ''}`);
  const taskData = task.body as { data?: { status?: string; successCount?: number } };
  check('批量任务完成', taskData.data?.status === 'SUCCESS' && taskData.data?.successCount === 2, taskData.data?.status);

  const newUser = `smoke_${Date.now().toString(36)}`;
  const createUser = await json('/admin/users', { method: 'POST', body: JSON.stringify({ username: newUser, displayName: '冒烟用户', role: 'STAFF' }) });
  check('创建用户', createUser.status === 200);
  const userLogin = await json('/auth/login', { method: 'POST', body: JSON.stringify({ username: newUser, password: newUser }) });
  check('新用户初始密码登录', userLogin.status === 200);
  const users = await json('/admin/users');
  const usersData = users.body as { data?: unknown[] };
  check('用户列表', (usersData.data ?? []).length >= 1);
  const uid = (usersData.data as { id: number }[]).find((u) => u.username === newUser)?.id ?? 0;
  await json(`/admin/users/${uid}`, { method: 'DELETE' });
  const afterDel = await json('/admin/users');
  check('删除用户', !(afterDel.body as { data?: { username: string }[] }).data?.some((u) => u.username === newUser));

  console.log('[9] 权限控制');
  const staffToken = userLogin.status === 200 ? ((userLogin.body as { data?: { token?: string } }).data?.token ?? '') : '';
  const prevToken = token;
  token = staffToken;
  const staffAdmin = await json('/admin/users');
  check('文档管理员禁止用户管理（RBAC 仅超级管理员）', staffAdmin.status === 403);
  const staffDetail = await json(`/documents/${documentId}/vector-detail`);
  check('文档管理员可查看向量详情（管理权限正向）', staffDetail.status === 200);
  token = prevToken;

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
