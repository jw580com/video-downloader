import type { TaskStatus } from '../../lib/types';
import { STATUS_META } from '../../lib/constants';

interface ProgressBarProps {
  value: number;
  status?: TaskStatus;
  className?: string;
}

export function ProgressBar({ value, status = 'downloading', className = '' }: ProgressBarProps) {
  const meta = STATUS_META[status];
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      className={`h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800 ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${meta.barClass} ${meta.animated ? 'stripes animate-progress-stripes' : ''}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
