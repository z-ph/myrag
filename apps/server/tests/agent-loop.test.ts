import { describe, expect, it } from 'vitest';
import { createAgent, FakeToolCallingModel, modelCallLimitMiddleware, tool, toolCallLimitMiddleware } from 'langchain';
import * as z from 'zod';
import {
  QA_AGENT_RECURSION_LIMIT,
  QA_AGENT_TOOL_RUN_LIMIT,
  SEARCH_TOOL_NAME,
} from '../src/modules/rag/rag.service';

function searchTool() {
  return tool(async ({ query }: { query: string }) => `与「${query}」相关的资料片段`, {
    name: SEARCH_TOOL_NAME,
    description: '检索知识库',
    schema: z.object({ query: z.string() }),
  });
}

function loopingModel(rounds: number) {
  return new FakeToolCallingModel({
    toolCalls: Array.from({ length: rounds }, (_, i) => [
      { name: SEARCH_TOOL_NAME, args: { query: '报销' }, id: `call-${i}` },
    ]),
  });
}

describe('QA agent 循环上限', () => {
  it('模型持续调工具时不抛 GRAPH_RECURSION_LIMIT，并在工具上限处停', async () => {
    const agent = createAgent({
      model: loopingModel(40),
      tools: [searchTool()],
      systemPrompt: '根据资料回答。',
      middleware: [
        toolCallLimitMiddleware({ runLimit: QA_AGENT_TOOL_RUN_LIMIT, exitBehavior: 'continue' }),
        modelCallLimitMiddleware({ runLimit: QA_AGENT_TOOL_RUN_LIMIT + 3, exitBehavior: 'end' }),
      ],
    });

    const result = await agent.invoke(
      { messages: [{ role: 'user', content: '差旅费怎么报销' }] },
      { recursionLimit: QA_AGENT_RECURSION_LIMIT },
    );

    const toolMessages = result.messages.filter((m) => m.getType() === 'tool');
    // continue 会在超限后再写一条拦截 ToolMessage，所以允许 +1；关键是远小于 40 轮死循环
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(toolMessages.length).toBeLessThanOrEqual(QA_AGENT_TOOL_RUN_LIMIT + 1);
    expect(result.messages.some((m) => m.getType() === 'ai')).toBe(true);
  });
});
