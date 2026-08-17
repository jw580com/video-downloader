import { useMemo } from 'react';

interface BarChartProps {
  data: Array<{ label: string; value: number }>;
  height?: number;
  color?: string;
  formatValue?: (n: number) => string;
}

export function BarChart({ data, height = 180, color = '#6366f1', formatValue }: BarChartProps) {
  const W = 640;
  const H = 200;
  const PAD_B = 26;
  const PAD_T = 20;
  const PAD_X = 8;
  const max = useMemo(() => Math.max(1, ...data.map((d) => d.value)), [data]);
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_B - PAD_T;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.min(34, slot * 0.6);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height }}
      role="img"
      aria-label="每日下载量柱状图"
    >
      {[0.25, 0.5, 0.75, 1].map((r) => (
        <line
          key={r}
          x1={PAD_X}
          x2={W - PAD_X}
          y1={PAD_T + innerH * (1 - r)}
          y2={PAD_T + innerH * (1 - r)}
          stroke="currentColor"
          className="text-slate-200 dark:text-slate-800"
          strokeDasharray="3 4"
        />
      ))}
      {data.map((d, i) => {
        const h = (d.value / max) * innerH;
        const x = PAD_X + slot * i + (slot - barW) / 2;
        const y = PAD_T + innerH - h;
        return (
          <g key={`${d.label}-${i}`}>
            <title>{`${d.label}：${formatValue ? formatValue(d.value) : d.value} 个`}</title>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(1.5, h)}
              rx={4}
              fill={color}
              opacity={0.9}
            />
            {d.value > 0 ? (
              <text
                x={x + barW / 2}
                y={y - 5}
                textAnchor="middle"
                className="fill-slate-500 dark:fill-slate-400"
                fontSize="10"
              >
                {d.value}
              </text>
            ) : null}
            <text
              x={x + barW / 2}
              y={H - 8}
              textAnchor="middle"
              className="fill-slate-400 dark:fill-slate-500"
              fontSize="9.5"
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
