/**
 * 端到端冒烟测试：验证核心业务链路。
 * 前置：基础设施（postgres/qdrant/redis）+ mock-llm + server 已就绪。
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
  check('文档包含路由', (specBody.paths ? Object.keys(specBody.paths).length : 0) >= 20, `${Object.keys(specBody.paths ?? {}).length} 条路径`);
  check('安全方案已注册', !!specBody.components?.securitySchemes);
  const docs = await fetch(`${BASE}/docs`);
  check('Scalar UI 可访问', docs.status === 200 && (await docs.text()).includes('scalar'));

  console.log('[3] 认证（会话资源）');
  const login = await json('/auth/sessions', { method: 'POST', body: JSON.stringify(ADMIN) });
  const loginData = login.body as { token?: string; user?: { role?: string } };
  check('登录创建会话', login.status === 201 && typeof loginData.token === 'string');
  token = loginData.token ?? '';
  check('超级管理员角色', loginData.user?.role === 'SUPER_ADMIN');

  const me = await json('/auth/sessions/current');
  check('GET /auth/sessions/current', me.status === 200 && (me.body as { username?: string }).username === ADMIN.username);

  const badLogin = await json('/auth/sessions', { method: 'POST', body: JSON.stringify({ username: ADMIN.username, password: 'wrong' }) });
  check('错误密码拒绝', badLogin.status === 401);

  console.log('[4] 文档上传与处理');
  const uniq = Date.now().toString(36);
  const txt = `差旅费报销管理办法（修订版 ${uniq}）：出差人员凭发票与行程单报销，住宿费按城市等级限额，伙食补助每日 100 元。`;
  const form = new FormData();
  form.append('file', new File([txt], `差旅费管理办法-${uniq}.txt`, { type: 'text/plain' }));
  const upload = await json('/documents', { method: 'POST', body: form });
  const uploadData = upload.body as { documentId?: string; success?: boolean; segmentCount?: number; status?: string };
  check('创建文档并入库', upload.status === 201 && uploadData.success === true, `分块 ${uploadData.segmentCount}`);
  const documentId = uploadData.documentId ?? '';

  const list = await json('/documents');
  const listData = list.body as { documents?: unknown[]; total?: number };
  check('文档列表', list.status === 200 && (listData.total ?? 0) >= 1);

  const detail = await json(`/documents/${documentId}/vectors`);
  const detailData = detail.body as { indexedPointCount?: number; points?: unknown[] };
  check('向量详情', detail.status === 200 && (detailData.indexedPointCount ?? 0) >= 1);

  const dl = await fetch(`${BASE}/documents/${documentId}/file`);
  check('下载文档', dl.status === 200 && dl.headers.get('content-disposition')?.includes('attachment'));

  console.log('[5] 检索问答（SSE 流式）');
  const convId = `smoke-${Date.now().toString(36)}`;
  const sseForm = new FormData();
  sseForm.append('question', '差旅费住宿报销标准是什么？');
  sseForm.append('stream', 'true');
  const sseRes = await fetch(`${BASE}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: sseForm,
  });
  const sseText = await sseRes.text();
  const events = [...sseText.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  check('SSE 事件流完整', events.includes('start') && events.includes('delta') && events.includes('complete'), events.join(','));
  check('SSE 含来源', events.includes('sources'));
  check('SSE 含思考过程（reasoning）', events.includes('reasoning'));
  check('SSE 回答非空', /【Mock 回答】/.test(sseText));

  console.log('[6] 会话管理');
  const convs = await json('/conversations');
  const convData = convs.body as { conversationId?: string }[];
  check('会话列表包含新会话', Array.isArray(convData) && convData.some((c) => c.conversationId === convId));
  const convDetail = await json(`/conversations/${convId}`);
  const convDetailData = convDetail.body as { exists?: boolean; recentMessages?: unknown[] };
  check('会话详情持久化', convDetailData.exists === true && (convDetailData.recentMessages?.length ?? 0) === 2);

  console.log('[6.5] 访客会话（guest token 统一链路）');
  const adminToken = token;
  token = '';
  const guest = await json('/auth/guest-sessions', { method: 'POST' });
  const guestToken = (guest.body as { token?: string }).token ?? '';
  check('签发访客 token', guest.status === 201 && guestToken.length > 0);
  token = guestToken;

  const gConv = `guest-smoke-${Date.now().toString(36)}`;
  const gSseForm = new FormData();
  gSseForm.append('question', '住宿费报销标准是什么？');
  gSseForm.append('stream', 'true');
  const gSseRes = await fetch(`${BASE}/conversations/${gConv}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${guestToken}` },
    body: gSseForm,
  });
  const gSseText = await gSseRes.text();
  const gEvents = [...gSseText.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  check('访客 SSE 事件流完整', gEvents.includes('start') && gEvents.includes('delta') && gEvents.includes('complete'), gEvents.join(','));

  const gConvs = await json('/conversations');
  check('访客会话列表包含新会话', Array.isArray(gConvs.body) && (gConvs.body as { conversationId?: string }[]).some((c) => c.conversationId === gConv));
  const gDetail = await json(`/conversations/${gConv}`);
  const gDetailData = gDetail.body as { exists?: boolean; recentMessages?: unknown[] };
  check('访客会话详情持久化', gDetailData.exists === true && (gDetailData.recentMessages?.length ?? 0) === 2);
  const gCancel = await json(`/conversations/${gConv}/cancellation`, { method: 'POST' });
  check('访客取消端点可达（完成态拒绝）', gCancel.status === 400);
  const gAdmin = await json('/admin/users');
  check('访客禁止管理端点', gAdmin.status === 403);
  const gCurrent = await json('/auth/sessions/current');
  check('访客不允许查询登录会话', gCurrent.status === 401);
  token = adminToken;

  console.log('[6.6] 提示词管理与访客清理');
  const prompts = await json('/admin/prompts');
  check('提示词列表', prompts.status === 200 && Array.isArray(prompts.body) && (prompts.body as { key?: string }[]).some((p) => p.key === 'qa.system'));
  const putPrompt = await json('/admin/prompts/qa.system', { method: 'PUT', body: JSON.stringify({ content: '冒烟测试提示词：基于资料简洁回答。' }) });
  check('更新提示词', putPrompt.status === 200);
  const versions = await json('/admin/prompts/qa.system/versions');
  check('提示词版本记录', versions.status === 200 && Array.isArray(versions.body) && (versions.body as unknown[]).length >= 1);
  const resetPrompt = await json('/admin/prompts/qa.system', { method: 'DELETE' });
  check('重置提示词', resetPrompt.status === 200);
  const cleanup = await json('/admin/conversations/cleanup', { method: 'POST' });
  check('手动触发访客清理', cleanup.status === 200 && typeof (cleanup.body as { deletedCount?: number }).deletedCount === 'number');

  console.log('[7] 批量上传与用户管理');
  const batchForm = new FormData();
  batchForm.append('files', new File([`采购审批流程（${uniq}）：金额一万元以上需分管领导审批。`], `采购流程-${uniq}.md`, { type: 'text/markdown' }));
  batchForm.append('files', new File([`差旅费发票粘贴规范（${uniq}）：粘贴单上注明事由与金额。`], `发票粘贴-${uniq}.txt`, { type: 'text/plain' }));
  const batch = await json('/documents/uploads', { method: 'POST', body: batchForm });
  const batchData = batch.body as { taskId?: string; totalFiles?: number };
  check('批量任务创建', batch.status === 201 && batchData.totalFiles === 2, `task=${batchData.taskId}`);
  await new Promise((r) => setTimeout(r, 1500));
  const task = await json(`/documents/uploads/${batchData.taskId ?? ''}`);
  const taskData = task.body as { status?: string; successCount?: number };
  check('批量任务完成', taskData.status === 'SUCCESS' && taskData.successCount === 2, taskData.status);

  const newUser = `smoke_${Date.now().toString(36)}`;
  const createUser = await json('/admin/users', { method: 'POST', body: JSON.stringify({ username: newUser, displayName: '冒烟用户', role: 'STAFF' }) });
  check('创建用户', createUser.status === 201);
  const userLogin = await json('/auth/sessions', { method: 'POST', body: JSON.stringify({ username: newUser, password: newUser }) });
  check('新用户初始密码登录', userLogin.status === 201);
  const users = await json('/admin/users');
  const usersData = users.body as unknown[];
  check('用户列表', Array.isArray(usersData) && usersData.length >= 1);
  const uid = (usersData as { id: number }[]).find((u) => u.username === newUser)?.id ?? 0;
  await json(`/admin/users/${uid}`, { method: 'DELETE' });
  const afterDel = await json('/admin/users');
  check('删除用户', !(afterDel.body as { username: string }[]).some((u) => u.username === newUser));

  console.log('[8] 权限控制');
  const staffToken = userLogin.status === 201 ? ((userLogin.body as { token?: string }).token ?? '') : '';
  const prevToken = token;
  token = staffToken;
  const staffAdmin = await json('/admin/users');
  check('文档管理员禁止用户管理（RBAC 仅超级管理员）', staffAdmin.status === 403);
  const staffDetail = await json(`/documents/${documentId}/vectors`);
  check('文档管理员可查看向量详情（管理权限正向）', staffDetail.status === 200);
  token = prevToken;

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
