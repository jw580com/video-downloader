import { useState, useCallback, type ReactNode } from 'react';
import {
  AlertTriangle,
  Clock,
  Copy,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Task } from '../lib/types';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { useToast } from '../context/ToastContext';

interface TaskActionsProps {
  task: Task;
  onChanged: () => void;
  size?: 'sm' | 'md';
}

export function TaskActions({ task, onChanged, size = 'sm' }: TaskActionsProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [withFile, setWithFile] = useState(false);
  const [deleteFileOpen, setDeleteFileOpen] = useState(false);

  const run = useCallback(
    async (action: 'pause' | 'resume' | 'cancel' | 'retry', label: string) => {
      setBusy(action);
      try {
        await api.taskAction(task.id, action);
        toast.info(label);
        onChanged();
      } catch (e) {
        toast.error('操作失败', e instanceof Error ? e.message : '未知错误');
      } finally {
        setBusy(null);
      }
    },
    [task.id, toast, onChanged],
  );

  const confirmDelete = async () => {
    setBusy('delete');
    try {
      const res = await api.deleteTask(task.id, withFile);
      toast.success('任务已删除', res.fileDeleted ? '任务记录与文件均已删除' : '仅删除了任务记录，文件保留');
      onChanged();
      setDeleteOpen(false);
    } catch (e) {
      toast.error('删除失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setBusy(null);
    }
  };

  const doDeleteFile = async () => {
    setBusy('deleteFile');
    try {
      await api.deleteFile(task.id);
      toast.success('文件已删除', '历史记录已保留');
      onChanged();
      setDeleteFileOpen(false);
    } catch (e) {
      toast.error('删除文件失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    try {
      const res = await api.openFolder(task.id);
      if (!res.ok) toast.info(res.message);
    } catch (e) {
      toast.error('无法打开文件夹', e instanceof Error ? e.message : '未知错误');
    }
  };

  const btn = (cls: string, title: string, icon: ReactNode, onClick: () => void, loading?: string) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={busy !== null}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:opacity-50 ${cls}`}
    >
      {busy === loading ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        icon
      )}
    </button>
  );

  const active = ['downloading', 'parsing'].includes(task.status);

  return (
    <div className="flex items-center justify-end gap-1.5">
      {active
        ? btn(
            'border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400',
            '暂停',
            <Pause className="h-3.5 w-3.5" />,
            () => void run('pause', '任务已暂停'),
            'pause',
          )
        : null}
      {task.status === 'paused'
        ? btn(
            'border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400',
            '继续',
            <Play className="h-3.5 w-3.5" />,
            () => void run('resume', '任务已继续'),
            'resume',
          )
        : null}
      {['waiting', 'parsing', 'downloading', 'paused'].includes(task.status)
        ? btn(
            'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-rose-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-rose-400',
            '取消',
            <X className="h-3.5 w-3.5" />,
            () => void run('cancel', '任务已取消'),
            'cancel',
          )
        : null}
      {['failed', 'cancelled'].includes(task.status)
        ? btn(
            'border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-400',
            '重试',
            <RotateCcw className="h-3.5 w-3.5" />,
            () => void run('retry', '任务已重新加入队列'),
            'retry',
          )
        : null}
      {task.status === 'completed' && task.filePath
        ? btn(
            'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-indigo-400',
            '打开文件夹',
            <FolderOpen className="h-3.5 w-3.5" />,
            openFolder,
          )
        : null}
      {task.status === 'completed' && task.filePath
        ? btn(
            'border-rose-200 bg-white text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:border-rose-500/30 dark:bg-slate-900 dark:text-slate-400',
            '删除文件（保留记录）',
            <AlertTriangle className="h-3.5 w-3.5" />,
            () => setDeleteFileOpen(true),
          )
        : null}
      {btn(
        'border-slate-200 bg-white text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400',
        '删除任务',
        <Trash2 className="h-3.5 w-3.5" />,
        () => setDeleteOpen(true),
      )}

      {/* 删除任务确认（区分是否删除文件） */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="删除任务"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="danger" loading={busy === 'delete'} onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          确定删除任务「{task.title}」吗？此操作无法撤销。
        </p>
        {task.filePath ? (
          <label className="mt-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={withFile}
              onChange={(e) => setWithFile(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              同时删除已下载的文件
              <span className="ml-1 text-xs text-slate-400">（默认仅删除记录，文件保留）</span>
            </span>
          </label>
        ) : null}
      </Modal>

      {/* 仅删除文件确认 */}
      <Modal
        open={deleteFileOpen}
        onClose={() => setDeleteFileOpen(false)}
        title="删除文件"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteFileOpen(false)}>
              取消
            </Button>
            <Button variant="danger" loading={busy === 'deleteFile'} onClick={() => void doDeleteFile()}>
              删除文件
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          将删除视频文件，但保留历史记录。确定继续吗？
        </p>
      </Modal>

      {size === 'sm' ? null : (
        <span className="flex items-center gap-1 text-xs text-slate-400">
          <Clock className="h-3 w-3" />
        </span>
      )}
    </div>
  );
}

export function CopyPathButton({ path }: { path: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      title="复制路径"
      aria-label="复制路径"
      onClick={() => {
        void navigator.clipboard
          .writeText(path)
          .then(() => toast.success('路径已复制'))
          .catch(() => toast.error('复制失败'));
      }}
      className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}
