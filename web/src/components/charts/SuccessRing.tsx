interface SuccessRingProps {
  rate: number;
  size?: number;
}

export function SuccessRing({ rate, size = 132 }: SuccessRingProps) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, rate));
  return (
    <div className="flex flex-col items-center gap-3">
      <svg viewBox="0 0 100 100" style={{ width: size, height: size }} role="img" aria-label={`成功率 ${pct}%`}>
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="11" className="stroke-slate-100 dark:stroke-slate-800" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="11"
          stroke="#10b981"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="47" textAnchor="middle" className="fill-slate-900 dark:fill-slate-100" fontSize="15" fontWeight="700">
          {pct}%
        </text>
        <text x="50" y="60" textAnchor="middle" className="fill-slate-400 dark:fill-slate-500" fontSize="7.5">
          成功率
        </text>
      </svg>
      <p className="text-center text-xs text-slate-400 dark:text-slate-500">
        完成 {`${Math.round((pct / 100) * 1000) / 10}`}% · 失败 {`${Math.round((1 - pct / 100) * 1000) / 10}`}%
      </p>
    </div>
  );
}
