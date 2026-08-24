import { useEffect, useState } from 'react';

/**
 * 实时时钟：以固定间隔返回当前时间戳（毫秒）。
 * 用于"进行中"的实时时长展示；页面隐藏时暂停，节省开销。
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/** 毫秒 → 人类可读时长（如 1分23秒 / 45秒 / 2小时03分） */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}小时${String(m % 60).padStart(2, '0')}分`;
}
