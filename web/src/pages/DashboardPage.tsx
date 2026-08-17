import {
  BarChart3,
  CalendarCheck,
  CheckCircle2,
  Database,
  HardDriveDownload,
  ListChecks,
  RefreshCw,
  XCircle,
  Zap,
} from 'lucide-react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { Card } from '../components/ui/Card';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { PlatformBadge } from '../components/PlatformBadge';
import { BarChart } from '../components/charts/BarChart';
import { Donut } from '../components/charts/Donut';
import { SuccessRing } from '../components/charts/SuccessRing';

export default function DashboardPage() {
  const { data, loading, error, refresh } = usePolling(() => api.getStats(), 5000);

  const overview = data?.overview;

  return (
    <div className="animate-fade-in">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">数据统计 Dashboard</h2>
          <p className="mt-0.5 text-xs text-slate-400">下载任务全局概览（每 5 秒自动刷新）</p>
        </div>
        <button
          type="button"
          aria-label="刷新统计"
          onClick={refresh}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:text-indigo-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error ? (
        <Card>
          <p className="text-sm text-rose-500">加载失败：{error}</p>
        </Card>
      ) : null}

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={<CalendarCheck className="h-5 w-5" />}
          label="今日任务"
          value={overview?.todayTasks ?? '—'}
          accent="indigo"
        />
        <StatCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="今日已完成"
          value={overview?.todayCompleted ?? '—'}
          accent="emerald"
        />
        <StatCard
          icon={<Zap className="h-5 w-5" />}
          label="下载中"
          value={overview?.downloading ?? '—'}
          accent="violet"
        />
        <StatCard
          icon={<XCircle className="h-5 w-5" />}
          label="今日失败"
          value={overview?.todayFailed ?? '—'}
          accent="rose"
        />
        <StatCard
          icon={<HardDriveDownload className="h-5 w-5" />}
          label="累计下载"
          value={formatBytes(overview?.totalBytes ?? 0)}
          accent="sky"
        />
        <StatCard
          icon={<ListChecks className="h-5 w-5" />}
          label="累计任务"
          value={overview?.totalTasks ?? '—'}
          accent="amber"
        />
      </div>

      {/* 图表区 */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card title="每日下载量" description="最近 14 天完成的任务数" className="lg:col-span-2">
          <BarChart
            data={(data?.daily ?? []).map((d) => ({ label: d.label, value: d.count }))}
            formatValue={(n) => `${n} 个`}
          />
        </Card>
        <Card title="下载成功率" description="完成 /（完成+失败）">
          <div className="flex h-full items-center justify-center py-4">
            <SuccessRing rate={overview?.successRate ?? 0} />
          </div>
        </Card>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="各平台下载数量" description="按完成任务的平台统计">
          <Donut data={data?.platforms ?? []} />
        </Card>
        <Card title="最近下载任务" description="最新的 6 个任务">
          {data?.recent && data.recent.length > 0 ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.recent.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">{t.title}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <PlatformBadge platform={t.platform} name={t.platformName} />
                      <span className="text-[11px] text-slate-400">{formatDateTime(t.createdAt)}</span>
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-xs text-slate-400">
              <Database className="mx-auto mb-2 h-5 w-5" />
              暂无任务
            </p>
          )}
        </Card>
      </div>

      {!loading && overview && overview.totalTasks === 0 ? (
        <Card className="mt-5">
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <BarChart3 className="h-4 w-4 text-indigo-400" />
            添加并完成第一个下载任务后，这里将展示完整的数据统计。
          </div>
        </Card>
      ) : null}
    </div>
  );
}
