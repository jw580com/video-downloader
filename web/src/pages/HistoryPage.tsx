import { useEffect, useMemo, useState } from 'react';
import { Download, History as HistoryIcon, Search, Trash2 } from 'lucide-react';
import { useTasks } from '../hooks/useTasks';
import { api } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { PLATFORM_META } from '../lib/constants';
import type { PlatformOption } from '../lib/types';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/StatusBadge';
import { PlatformBadge } from '../components/PlatformBadge';
import { TaskActions, CopyPathButton } from '../components/TaskActions';
import { BatchDeleteBar } from '../components/BatchDeleteBar';
import { useToast } from '../context/ToastContext';

const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'waiting', label: '等待中' },
  { value: 'downloading,parsing', label: '下载中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
];

const SORTS = [
  { value: 'desc', label: '时间倒序' },
  { value: 'asc', label: '时间正序' },
];

const PAGE_SIZE = 50;

function SelectCheckbox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-2 focus:ring-indigo-500/40 dark:border-slate-600 dark:bg-slate-800"
    />
  );
}

export default function HistoryPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('desc');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const next = search.trim();
    // 初始挂载（值未变化）时不要重置页码
    if (next === debounced) return;
    const t = window.setTimeout(() => {
      setDebounced(next);
      setPage(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search, debounced]);

  const params = useMemo(
    () => ({
      status: status || undefined,
      platform: platform || undefined,
      search: debounced || undefined,
      sort: 'completed_at',
      order: (sort === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [status, platform, debounced, sort, page],
  );

  const { tasks, total, loading, refresh } = useTasks(params, 5000);
  const toast = useToast();

  const [platformOptions, setPlatformOptions] = useState<PlatformOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .getPlatforms()
      .then((r) => {
        if (!cancelled) setPlatformOptions(r.platforms);
      })
      .catch(() => {
        // 平台列表加载失败时保留内置平台
      });
    return () => {
      cancelled = true;
    };
  }, [total]);

  // 内置平台 + 任务中出现过的自定义解析源平台（带数量）
  const platformFilters = useMemo(() => {
    const map = new Map<string, { value: string; label: string; count: number }>();
    for (const [key, meta] of Object.entries(PLATFORM_META)) {
      map.set(key, { value: key, label: meta.name, count: 0 });
    }
    for (const p of platformOptions) {
      const existing = map.get(p.platform);
      if (existing) {
        existing.count = p.count;
        // 内置平台使用内置显示名；仅自定义平台使用任务快照里的名称
        if (p.name && p.name !== p.platform) existing.label = p.name;
      } else {
        map.set(p.platform, { value: p.platform, label: p.name || p.platform, count: p.count });
      }
    }
    return [...map.values()];
  }, [platformOptions]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > pages - 1) setPage(pages - 1);
  }, [total, page]);

  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id));

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(tasks.map((t) => t.id)));
  };

  const doBatchDelete = async () => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      const r = await api.batchDelete([...selected], withFiles);
      toast.success(
        `已删除 ${r.deleted} 条记录`,
        r.failed > 0
          ? `${r.failed} 条记录删除失败，请重试`
          : r.filesDeleted > 0
            ? `同时删除了 ${r.filesDeleted} 个文件`
            : '已下载文件已保留',
      );
      setSelected(new Set());
      setBatchOpen(false);
      refresh();
    } catch (e) {
      toast.error('批量删除失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setBusy(false);
    }
  };

  const doDeleteAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.deleteAll({
        withFiles,
        status: status || undefined,
        platform: platform || undefined,
        search: debounced || undefined,
      });
      toast.success(
        `已删除 ${r.deleted} 条记录`,
        r.failed > 0
          ? `${r.failed} 条记录删除失败，请重试`
          : r.filesDeleted > 0
            ? `同时删除了 ${r.filesDeleted} 个文件`
            : '已下载文件已保留',
      );
      setSelected(new Set());
      setDeleteAllOpen(false);
      refresh();
    } catch (e) {
      toast.error('删除失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">下载历史</h2>
          <p className="mt-0.5 text-xs text-slate-400">共 {total} 条记录</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="!border-rose-200 !text-rose-600 hover:!bg-rose-50 dark:!border-rose-500/30 dark:!text-rose-400 dark:hover:!bg-rose-500/10"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() => {
            setWithFiles(false);
            setDeleteAllOpen(true);
          }}
          disabled={total === 0}
        >
          全部删除
        </Button>
      </div>

      {/* 筛选栏 */}
      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="relative col-span-2 lg:col-span-1">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
            <Search className="h-4 w-4" />
          </span>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
              setSelected(new Set());
            }}
            placeholder="搜索视频名称或链接…"
            className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
        </div>
        <select
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value);
            setPage(0);
            setSelected(new Set());
          }}
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          <option value="">全部平台</option>
          {platformFilters.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
              {p.count > 0 ? ` (${p.count})` : ''}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
            setSelected(new Set());
          }}
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(0);
            setSelected(new Set());
          }}
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {selected.size > 0 ? (
        <BatchDeleteBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          onDelete={() => {
            setWithFiles(false);
            setBatchOpen(true);
          }}
        />
      ) : null}

      {!loading && tasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon className="h-6 w-6" />}
            title="暂无历史记录"
            description={debounced || platform || status ? '没有符合筛选条件的记录' : '完成下载后，记录会显示在这里'}
          />
        </Card>
      ) : null}

      {/* 桌面表格 */}
      <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="w-10 px-4 py-3">
                <SelectCheckbox checked={allSelected} onChange={toggleAll} label="全选记录" />
              </th>
              <th className="px-4 py-3 font-medium">视频</th>
              <th className="px-4 py-3 font-medium">平台</th>
              <th className="px-4 py-3 font-medium">文件大小</th>
              <th className="px-4 py-3 font-medium">下载时间</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">文件路径</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr
                key={task.id}
                className={`border-b border-slate-100 transition last:border-0 hover:bg-slate-50/70 dark:border-slate-800/60 dark:hover:bg-slate-800/40 ${
                  selected.has(task.id) ? 'bg-indigo-50/50 dark:bg-indigo-500/5' : ''
                }`}
              >
                <td className="px-4 py-3">
                  <SelectCheckbox
                    checked={selected.has(task.id)}
                    onChange={() => toggleOne(task.id)}
                    label={`选择记录：${task.title}`}
                  />
                </td>
                <td className="max-w-[220px] px-4 py-3">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={task.title}>
                    {task.title}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-slate-400" title={task.url}>
                    {task.url}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <PlatformBadge platform={task.platform} name={task.platformName} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-slate-600 dark:text-slate-300">
                  {task.status === 'completed' ? formatBytes(task.totalBytes) : '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">
                  {formatDateTime(task.completedAt ?? task.updatedAt)}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={task.status} />
                </td>
                <td className="max-w-[200px] px-4 py-3">
                  {task.filePath ? (
                    <span className="flex items-center gap-1 text-[11px] text-slate-400">
                      <span className="truncate" title={task.filePath}>
                        {task.filePath}
                      </span>
                      <CopyPathButton path={task.filePath} />
                    </span>
                  ) : (
                    <span className="text-[11px] text-slate-300 dark:text-slate-600">无文件</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <TaskActions task={task} onChanged={refresh} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动端卡片 */}
      <div className="space-y-3 md:hidden">
        {tasks.map((task) => (
          <Card key={task.id} className={`p-4 ${selected.has(task.id) ? 'ring-2 ring-indigo-500/40' : ''}`}>
            <div className="flex items-start gap-3">
              <div className="pt-0.5">
                <SelectCheckbox
                  checked={selected.has(task.id)}
                  onChange={() => toggleOne(task.id)}
                  label={`选择记录：${task.title}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 text-sm font-medium text-slate-900 dark:text-slate-100">{task.title}</p>
                  <StatusBadge status={task.status} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                  <PlatformBadge platform={task.platform} name={task.platformName} />
                  <span>{task.status === 'completed' ? formatBytes(task.totalBytes) : '—'}</span>
                  <span>{formatDateTime(task.completedAt ?? task.updatedAt)}</span>
                </div>
                {task.filePath ? (
                  <p className="mt-2 flex items-center gap-1 truncate text-[11px] text-slate-400">
                    <span className="truncate">{task.filePath}</span>
                    <CopyPathButton path={task.filePath} />
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-2.5 flex justify-end border-t border-slate-100 pt-2.5 dark:border-slate-800">
              <TaskActions task={task} onChanged={refresh} />
            </div>
          </Card>
        ))}
      </div>

      {loading && tasks.length > 0 ? (
        <p className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400">
          <Download className="h-3.5 w-3.5 animate-bounce" />
          更新中…
        </p>
      ) : null}

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        unit="条记录"
        onChange={(next) => {
          setPage(next);
          setSelected(new Set());
        }}
      />

      {/* 批量删除确认 */}
      <Modal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        title="批量删除记录"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void doBatchDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          确定删除选中的 <span className="font-semibold text-slate-900 dark:text-white">{selected.size}</span>{' '}
          条记录吗？此操作无法撤销。
        </p>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={withFiles}
            onChange={(e) => setWithFiles(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>
            同时删除已下载的文件
            <span className="ml-1 text-xs text-slate-400">（默认仅删除记录，文件保留）</span>
          </span>
        </label>
      </Modal>

      {/* 全部删除确认 */}
      <Modal
        open={deleteAllOpen}
        onClose={() => setDeleteAllOpen(false)}
        title="删除全部记录"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteAllOpen(false)}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void doDeleteAll()}>
              确认删除全部
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          确定删除当前筛选条件下的
          <span className="font-semibold text-slate-900 dark:text-white">全部 {total} 条记录</span>吗？
          此操作无法撤销。
        </p>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={withFiles}
            onChange={(e) => setWithFiles(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>
            同时删除已下载的文件
            <span className="ml-1 text-xs text-slate-400">（默认仅删除记录，文件保留）</span>
          </span>
        </label>
      </Modal>
    </div>
  );
}
