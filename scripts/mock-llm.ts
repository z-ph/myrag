/**
 * Mock OpenAI 兼容 LLM（本地 smoke test 用）：
 * - POST /v1/chat/completions：固定回答，支持 stream
 * - POST /v1/embeddings：返回 dim=2048 确定性伪随机向量
 * 用法：pnpm tsx scripts/mock-llm.ts
 */
import { createServer } from 'node:http';

const DIM = 2048;

/** 基于字符串哈希的确定性向量（同文本同向量，可检索） */
function embed(text: string): number[] {
  const vec = new Array<number>(DIM);
  let seed = 0;
  for (const ch of text) {
    seed = (seed * 31 + ch.codePointAt(0)!) >>> 0;
  }
  for (let i = 0; i < DIM; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vec[i] = (seed % 2000) / 1000 - 1; // [-1, 1]
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 空 body
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/embeddings' || url.pathname === '/v1/embeddings') {
      const input = body['input'];
      const texts = Array.isArray(input) ? (input as string[]) : [String(input ?? '')];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: texts.map((t, i) => ({ index: i, embedding: embed(t) })),
          model: 'mock-embedding',
        }),
      );
      return;
    }

    if (url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions') {
      const messages = (body['messages'] ?? []) as { role: string; content: string }[];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const question = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const answer = `【Mock 回答】已收到问题「${question.slice(0, 50)}」。这是本地冒烟测试的固定回复，不表示真实知识库回答。`;

      if (body['stream'] === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const parts = [answer.slice(0, 20), answer.slice(20, 40), answer.slice(40)];
        let i = 0;
        const timer = setInterval(() => {
          if (i >= parts.length) {
            res.write('data: [DONE]\n\n');
            res.end();
            clearInterval(timer);
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i] } }] })}\n\n`);
          i += 1;
        }, 30);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: answer } }],
          model: 'mock-chat',
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

const port = Number(process.env.MOCK_LLM_PORT ?? 9999);
server.listen(port, () => {
  console.log(`[mock-llm] listening on http://localhost:${port} (dim=${DIM})`);
});
