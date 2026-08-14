import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAuthService } from '../src/modules/auth/auth.service';
import { signToken, verifyToken } from '../src/lib/security';
import { requireRegistered } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error';
import { loadServerConfig } from '@myrag/shared';

function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe('createGuestSession', () => {
  it('签出的 token 经 verifyToken 解析后 role === GUEST、sub 以 guest- 开头', async () => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.GUEST_JWT_TTL_SECONDS = '3600';
    const cfg = loadServerConfig();
    // 访客不写 users 表，传 null as any 即可（实际传入 drizzle 实例，但 createGuestSession 不使用 db）
    const authService = createAuthService(null as any, cfg);
    const { token } = await authService.createGuestSession();
    const payload = await verifyToken(token);
    expect(payload.role).toBe('GUEST');
    expect(payload.sub.startsWith('guest-')).toBe(true);
    expect(payload.username.startsWith('guest-')).toBe(true);
  });
});

describe('requireRegistered', () => {
  it('GUEST 角色被拒绝', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const cfg = loadServerConfig();
    const guestToken = await signToken({ sub: 'guest-abc', username: 'guest-abc', role: 'GUEST' }, cfg);

    const app = createTestApp();
    app.use('/test', requireRegistered);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${guestToken}` },
    });
    expect(res.status).toBe(401);
  });

  it('SUPER_ADMIN 角色放行', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const cfg = loadServerConfig();
    const adminToken = await signToken({ sub: '1', username: 'admin', role: 'SUPER_ADMIN' }, cfg);

    const app = createTestApp();
    app.use('/test', requireRegistered);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('STAFF 角色放行', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const cfg = loadServerConfig();
    const staffToken = await signToken({ sub: '2', username: 'staff', role: 'STAFF' }, cfg);

    const app = createTestApp();
    app.use('/test', requireRegistered);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('USER 角色放行', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const cfg = loadServerConfig();
    const userToken = await signToken({ sub: '3', username: 'user', role: 'USER' }, cfg);

    const app = createTestApp();
    app.use('/test', requireRegistered);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);
  });
});