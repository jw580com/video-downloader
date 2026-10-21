import { useMemo } from 'react';
import { api, type TaskListParams } from '../lib/api';
import type { Task, TaskStatus } from '../lib/types';
import { usePolling } from './usePolling';

export function useTasks(params: TaskListParams = {}, intervalMs = 1500): {
  tasks: Task[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  hasActive: boolean;
} {
  const key = JSON.stringify(params);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fn = useMemo(() => () => api.listTasks(params), [key]);
  const { data, loading, error, refresh } = usePolling(fn, intervalMs, true, key);
  const tasks = data?.items ?? [];
  const hasActive = tasks.some((t) =>
    (['waiting', 'parsing', 'downloading'] as TaskStatus[]).includes(t.status),
  );
  return { tasks, total: data?.total ?? 0, loading, error, refresh, hasActive };
}
