import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * 通用零占宽悬浮滚动条。
 *
 * 原生滚动条（即使样式成细条）也会占掉滚动容器的布局宽度，且轨道贯穿吸顶表头。
 * 本组件把目标容器的原生滚动条隐藏（scrollbar-width: none + ::-webkit-scrollbar 隐藏），
 * 用一条 position: fixed 的细拇指浮在内容右缘上方，从 topOffset（如吸顶表头高度）处开始。
 *
 * 用法：挂在目标滚动容器的任意兄弟/父级位置即可，无需宿主 position: relative。
 *   <OverlayScrollbar getScroller={() => ref.current} deps={[data]} />
 */

type Props = {
  /** 返回目标滚动容器元素（可为 null，组件会隐藏） */
  getScroller: () => HTMLElement | null;
  /** 轨道顶部起始偏移 px（如吸顶表头高度），可为函数动态计算 */
  topOffset?: number | (() => number);
  /** 数据 / 布局变化时的额外重测量依赖 */
  deps?: unknown[];
};

type TrackState = {
  show: boolean;
  top: number;
  left: number;
  height: number;
  thumbHeight: number;
  thumbTop: number;
};

const HIDDEN: TrackState = { show: false, top: 0, left: 0, height: 0, thumbHeight: 0, thumbTop: 0 };
const MIN_THUMB = 24;
const EDGE_PAD = 4;

export default function OverlayScrollbar({ getScroller, topOffset = 0, deps = [] }: Props) {
  const [track, setTrack] = useState<TrackState>(HIDDEN);
  const trackRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  // 回调经 ref 转发，避免调用方每次渲染的内联函数触发 effect 重跑
  const getScrollerRef = useRef(getScroller);
  getScrollerRef.current = getScroller;
  const topOffsetRef = useRef(topOffset);
  topOffsetRef.current = topOffset;

  const measure = useCallback(() => {
    const el = getScrollerRef.current();
    if (!el || !el.isConnected) {
      setTrack((s) => (s.show ? HIDDEN : s));
      return;
    }
    // 幂等隐藏原生滚动条：零占宽
    el.classList.add('osb-native-hidden');
    const rect = el.getBoundingClientRect();
    const headOffset = typeof topOffsetRef.current === 'function' ? topOffsetRef.current() : topOffsetRef.current;
    const { clientHeight, scrollHeight, scrollTop } = el;
    const height = rect.height - headOffset - EDGE_PAD * 2;
    if (rect.height < 60 || scrollHeight <= clientHeight + 1 || height < MIN_THUMB) {
      setTrack((s) => (s.show ? HIDDEN : s));
      return;
    }
    const thumbHeight = Math.max(MIN_THUMB, Math.round((height * clientHeight) / scrollHeight));
    const maxScroll = scrollHeight - clientHeight;
    const thumbTop = ((height - thumbHeight) * scrollTop) / maxScroll;
    const next: TrackState = {
      show: true,
      top: rect.top + headOffset + EDGE_PAD,
      left: rect.right - 11,
      height,
      thumbHeight,
      thumbTop,
    };
    setTrack((s) =>
      s.show === next.show &&
      s.top === next.top &&
      s.left === next.left &&
      s.height === next.height &&
      s.thumbHeight === next.thumbHeight &&
      s.thumbTop === next.thumbTop
        ? s
        : next,
    );
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    measure();
    // 弹窗开启动画 / 字体加载等场景的布局沉降兜底
    timersRef.current.push(window.setTimeout(schedule, 250), window.setTimeout(schedule, 700));
    const el = getScrollerRef.current();
    const ro = new ResizeObserver(schedule);
    if (el) {
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    window.addEventListener('resize', schedule);
    // 捕获阶段监听所有滚动（含目标容器自身与祖先滚动导致的位移）
    document.addEventListener('scroll', schedule, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, schedule, ...deps]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = getScrollerRef.current();
    const trackEl = trackRef.current;
    if (!el || !trackEl) return;
    e.preventDefault();
    const trackRect = trackEl.getBoundingClientRect();
    const thumbHeight = track.thumbHeight;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const jumpRatio = (e.clientY - trackRect.top - thumbHeight / 2) / Math.max(1, trackRect.height - thumbHeight);
    el.scrollTop = Math.min(1, Math.max(0, jumpRatio)) * maxScroll;
    trackEl.classList.add('is-dragging');
    const scrollStart = el.scrollTop;
    const pointerStart = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const ratio = (ev.clientY - pointerStart) / Math.max(1, trackRect.height - thumbHeight);
      el.scrollTop = scrollStart + ratio * maxScroll;
    };
    const onUp = () => {
      trackEl.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!track.show) return null;
  return (
    <div
      ref={trackRef}
      className="osb-track"
      style={{ top: track.top, left: track.left, height: track.height }}
      onPointerDown={onPointerDown}
    >
      <div className="osb-thumb" style={{ height: track.thumbHeight, transform: `translateY(${track.thumbTop}px)` }} />
    </div>
  );
}
