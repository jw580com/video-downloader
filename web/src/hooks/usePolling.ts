import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 轮询请求：同一时刻只允许一个请求在途，上一次请求完成后再安排下一次，
 * 避免网络变慢时请求堆积、旧响应覆盖新数据。
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled = true,
  /** 参数指纹：变化时立即重新请求，而不是等下一次轮询 */
  paramsKey = '',
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;

    const run = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const result = await fnRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '请求失败');
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
          timer = window.setTimeout(() => void run(), Math.max(250, intervalMs));
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, intervalMs, tick, paramsKey]);

  const refresh = useCallback(() => {
    setLoading(true);
    setTick((t) => t + 1);
  }, []);
  return { data, loading, error, refresh };
}
