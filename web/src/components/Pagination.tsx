import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './ui/Button';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  unit?: string;
}

/** 简单分页控件：页码从 0 开始 */
export function Pagination({ page, pageSize, total, onChange, unit = '条' }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const current = Math.min(page, pages - 1);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
      <span>
        第 <span className="font-semibold text-slate-700 dark:text-slate-200">{current + 1}</span> / {pages} 页 ·
        共 {total} {unit}
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid="pagination-prev"
          icon={<ChevronLeft className="h-3.5 w-3.5" />}
          disabled={current <= 0}
          onClick={() => onChange(current - 1)}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="pagination-next"
          disabled={current >= pages - 1}
          onClick={() => onChange(current + 1)}
        >
          下一页
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
