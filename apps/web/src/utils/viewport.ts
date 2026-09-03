/** 窄屏判定：移动端侧栏以浮层形式打开 */
export function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
}
