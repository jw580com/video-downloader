import { PLATFORM_META } from '../../lib/constants';

const FALLBACK_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#64748b',
];

interface DonutProps {
  data: Array<{ platform: string; count: number }>;
  size?: number;
}

export function Donut({ data, size = 168 }: DonutProps) {
  const total = data.reduce((a, b) => a + b.count, 0);
  const r = 40;
  const c = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <svg viewBox="0 0 100 100" style={{ width: size, height: size }} role="img" aria-label="各平台下载占比">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="12" className="stroke-slate-100 dark:stroke-slate-800" />
        {data.map((d, i) => {
          const frac = total > 0 ? d.count / total : 0;
          const seg = (
            <circle
              key={d.platform}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={FALLBACK_COLORS[i % FALLBACK_COLORS.length]}
              strokeWidth="12"
              strokeDasharray={`${frac * c} ${c}`}
              strokeDashoffset={-acc * c}
              transform="rotate(-90 50 50)"
            />
          );
          acc += frac;
          return seg;
        })}
        <text x="50" y="47" textAnchor="middle" className="fill-slate-900 dark:fill-slate-100" fontSize="15" fontWeight="700">
          {total}
        </text>
        <text x="50" y="59" textAnchor="middle" className="fill-slate-400 dark:fill-slate-500" fontSize="7">
          累计完成
        </text>
      </svg>
      <ul className="min-w-[140px] space-y-2">
        {data.length === 0 ? (
          <li className="text-xs text-slate-400">暂无数据</li>
        ) : (
          data.map((d, i) => (
            <li key={d.platform} className="flex items-center gap-2 text-xs">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: FALLBACK_COLORS[i % FALLBACK_COLORS.length] }}
              />
              <span className="flex-1 text-slate-600 dark:text-slate-300">
                {PLATFORM_META[d.platform]?.name ?? d.platform}
              </span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">{d.count}</span>
              <span className="w-10 text-right text-slate-400">
                {total > 0 ? `${Math.round((d.count / total) * 100)}%` : '0%'}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
