import { Trash2, X } from 'lucide-react';
import { Button } from './ui/Button';

interface BatchDeleteBarProps {
  count: number;
  onClear: () => void;
  onDelete: () => void;
}

export function BatchDeleteBar({ count, onClear, onDelete }: BatchDeleteBarProps) {
  return (
    <div className="mb-3 flex animate-fade-in flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 dark:border-indigo-500/30 dark:bg-indigo-500/10">
      <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
        已选择 {count} 个任务
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" icon={<X className="h-3.5 w-3.5" />} onClick={onClear}>
          取消选择
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={onDelete}>
          批量删除
        </Button>
      </div>
    </div>
  );
}
