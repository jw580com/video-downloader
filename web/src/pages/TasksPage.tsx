import { useState } from 'react';
import { Download, ListTodo, RefreshCw, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTasks } from '../hooks/useTasks';
import { api } from '../lib/api';
import type { Task, TaskStatus } from '../lib/types';
import { formatBytes, formatDateTime, formatEta, formatSpeed, percentOf, qualityLabel } from '../lib/format';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { ProgressBar } from '../components/ui/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import { PlatformBadge } from '../components/PlatformBadge';
import { TaskActions } from '../components/TaskActions';
import { BatchDeleteBar } from '../components/BatchDeleteBar';
import { useToast } from '../context/ToastContext';

const FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'waiting', label: '等待中' },
  { value: 'downloading,parsing', label: '下载中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
];

function Thumb({ task }: { task: Task }) {
  return (
    <div className="h-11 w-[72px] shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800">
      {task.thumbnail ? (
        <img src={task.thumbnail} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-300 dark:text-slate-600">
          <Download className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}

function ProgressCell({ task }: { task: Task }) {
  const pct = percentOf(task.downloadedBytes, task.totalBytes);
  const indeterminate = task.status === 'downloading' && task.totalBytes <= 0;
  return (
    <div className="min-w-[140px]">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
          {indeterminate ? '—' : `${Math.floor(pct)}%`}
        </span>
        <span className="truncate text-[11px] tabular-nums text-slate-400">
          {formatBytes(task.downloadedBytes)}
          {task.totalBytes > 0 ? ` / ${formatBytes(task.totalBytes)}` : ''}
        </span>
      </div>
      <ProgressBar value={pct} status={task.status} />
      {task.status === 'downloading' ? (
        <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
          <span>速度：{formatSpeed(task.speedBps)}</span>
          <span>剩余：{formatEta(task.etaSec)}</span>
        </p>
      ) : null}
      {task.status === 'failed' ? (
        <p className="mt-1 truncate text-[11px] text-rose-500" title={task.errorMessage}>
          {task.errorMessage || '下载失败'}
        </p>
      ) : null}
      {task.status === 'paused' && task.downloadedBytes > 0 ? (
        <p className="mt-1 text-[11px] text-amber-500">已下载 {formatBytes(task.downloadedBytes)}，可继续下载</p>
      ) : null}
    </div>
  );
}

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

export default function TasksPage() {
  const [filter, setFilter] = useState('');
  const { tasks, total, loading, error, refresh } = useTasks(
    { status: filter || undefined, sort: 'created_at', order: 'desc', limit: 200 },
    1200,
  );
  const navigate = useNavigate();
  const toast = useToast();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState(false);

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
        `已删除 ${r.deleted} 个任务`,
        r.filesDeleted > 0 ? `同时删除了 ${r.filesDeleted} 个文件` : '已下载文件已保留',
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
      const r = await api.deleteAll({ withFiles, status: filter || undefined });
      toast.success(
        `已删除 ${r.deleted} 个任务`,
        r.filesDeleted > 0 ? `同时删除了 ${r.filesDeleted} 个文件` : '已下载文件已保留',
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

  const activeCount = tasks.filter((t) => ['waiting', 'parsing', 'downloading', 'paused'].includes(t.status as TaskStatus)).length;

  return (
    <div className="animate-fade-in">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">下载任务</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            共 {total} 个任务{activeCount > 0 ? ` · ${activeCount} 个未完成` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={refresh}>
            刷新
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const isActive = filter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => {
                setFilter(f.value);
                setSelected(new Set());
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                isActive
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              {f.label}
            </button>
          );
        })}
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

      {error ? (
        <Card>
          <p className="text-sm text-rose-500">加载失败：{error}</p>
        </Card>
      ) : null}

      {!loading && tasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListTodo className="h-6 w-6" />}
            title={filter ? '该状态下暂无任务' : '还没有下载任务'}
            description="回到首页粘贴视频链接，创建你的第一个下载任务"
            action={
              <Button size="sm" onClick={() => navigate('/')}>
                去添加视频
              </Button>
            }
          />
        </Card>
      ) : null}

      {/* 桌面表格 */}
      <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="w-10 px-4 py-3">
                <SelectCheckbox checked={allSelected} onChange={toggleAll} label="全选任务" />
              </th>
              <th className="px-4 py-3 font-medium">视频</th>
              <th className="px-4 py-3 font-medium">规格</th>
              <th className="w-[26%] px-4 py-3 font-medium">进度</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">创建时间</th>
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
                    label={`选择任务：${task.title}`}
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Thumb task={task} />
                    <div className="min-w-0 max-w-[240px]">
                      <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={task.title}>
                        {task.title}
                      </p>
                      <div className="mt-1">
                        <PlatformBadge platform={task.platform} name={task.platformName} />
                      </div>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                  {qualityLabel(task.quality)} · {task.format.toUpperCase()}
                  {task.durationSec > 0 ? ` · ${Math.floor(task.durationSec / 60)}分` : ''}
                </td>
                <td className="px-4 py-3">
                  <ProgressCell task={task} />
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={task.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">{formatDateTime(task.createdAt)}</td>
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
                  label={`选择任务：${task.title}`}
                />
              </div>
              <Thumb task={task} />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-medium text-slate-900 dark:text-slate-100">{task.title}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <PlatformBadge platform={task.platform} name={task.platformName} />
                  <StatusBadge status={task.status} />
                </div>
              </div>
            </div>
            <div className="mt-3">
              <ProgressCell task={task} />
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2.5 dark:border-slate-800">
              <span className="text-[11px] text-slate-400">
                {qualityLabel(task.quality)} · {task.format.toUpperCase()} · {formatDateTime(task.createdAt)}
              </span>
              <TaskActions task={task} onChanged={refresh} />
            </div>
          </Card>
        ))}
      </div>

      {/* 批量删除确认 */}
      <Modal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        title="批量删除任务"
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
          个任务吗？此操作无法撤销。
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
        title="删除全部任务"
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
          确定删除{filter ? '当前筛选条件下的' : ''}
          <span className="font-semibold text-slate-900 dark:text-white">全部 {total} 个任务</span>吗？
          {activeCount > 0 ? '其中正在运行的任务会先被取消。' : ''}此操作无法撤销。
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
