import type { ComponentType } from 'react';
import { BookOutlined, SearchOutlined, ToolOutlined } from '@ant-design/icons';

/**
 * 工具展示注册表。
 *
 * 新增工具只需在此登记一条配置，执行中/已完成文案与行首图标自动派生，
 * 渲染层（工具行、状态行）统一走 toolDisplay/getToolConfig，不写死文案。
 */

/** 单个工具的展示配置 */
export interface ToolDisplayConfig {
  /** 动作名（如「检索知识库」），状态文案由它派生 */
  action: string;
  /** 执行中文案，缺省派生为 `${action}中` */
  running?: string;
  /** 完成文案，缺省派生为 `已${action}` */
  done?: string;
  /** 行首图标，缺省用通用扳手图标 */
  icon?: ComponentType;
}

export type ToolStatus = 'running' | 'done';

export const TOOL_REGISTRY: Record<string, ToolDisplayConfig> = {
  search_knowledge_base: { action: '检索知识库', icon: SearchOutlined },
  read_document: { action: '阅读文档正文', icon: BookOutlined },
};

const FALLBACK_ICON = ToolOutlined;

/** 取工具配置；未注册工具回退为「工具名本身 + 通用图标」 */
export function getToolConfig(name: string): ToolDisplayConfig {
  return TOOL_REGISTRY[name] ?? { action: name, icon: FALLBACK_ICON };
}

/** 按执行状态派生展示文案：执行中「检索知识库中」，已完成「已检索知识库」 */
export function toolDisplay(name: string, status: ToolStatus): string {
  const { action, running, done } = getToolConfig(name);
  return status === 'running' ? (running ?? `${action}中`) : (done ?? `已${action}`);
}
