import { useEffect, useState } from 'react';
import {
  Cookie,
  Database,
  Download,
  Gauge,
  Globe,
  HardDrive,
  Monitor,
  Moon,
  RefreshCw,
  Save,
  Sun,
  Timer,
  Wifi,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Settings, SystemInfo } from '../lib/types';
import { formatBytes } from '../lib/format';
import { CONCURRENCY_OPTIONS, FORMAT_OPTIONS, QUALITY_OPTIONS } from '../lib/constants';
import { useTheme, type ThemeMode } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input, Select } from '../components/ui/Field';
import { ParsersCard } from '../components/ParsersCard';
import { useSettings } from '../hooks/useSettings';

export default function SettingsPage() {
  const { settings, loading, error: settingsError, save, reload } = useSettings();
  const { mode, setMode } = useTheme();
  const toast = useToast();
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [sysLoading, setSysLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  useEffect(() => {
    void loadSystem();
  }, []);

  async function loadSystem() {
    setSysLoading(true);
    try {
      setSystem(await api.getSystem());
    } catch {
      // 静默失败，系统信息区显示占位
    } finally {
      setSysLoading(false);
    }
  }

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!form || saving) return;
    setSaving(true);
    try {
      const saved = await save({
        downloadQuality: form.downloadQuality,
        downloadFormat: form.downloadFormat,
        maxConcurrency: form.maxConcurrency,
        downloadDir: form.downloadDir,
        maxSpeedKBps: form.maxSpeedKBps,
        timeoutSec: form.timeoutSec,
        autoRetries: form.autoRetries,
        cookiesFile: form.cookiesFile,
        proxyUrl: form.proxyUrl,
      });
      setForm(saved);
      setDirty(false);
      toast.success('设置已保存');
      void loadSystem();
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">设置</h2>
          <p className="mt-0.5 text-xs text-slate-400">下载、网络、外观与系统信息</p>
        </div>
        <Button size="sm" loading={saving} disabled={!dirty || !form || loading} icon={<Save className="h-3.5 w-3.5" />} onClick={() => void handleSave()}>
          保存设置
        </Button>
      </div>

      {!form || loading ? (
        settingsError && !loading ? (
          <Card>
            <p className="text-sm text-rose-500">读取设置失败：{settingsError}</p>
            <Button size="sm" className="mt-3" onClick={() => void reload()}>
              重试
            </Button>
          </Card>
        ) : (
          <div className="space-y-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-44 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-900" />
            ))}
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {/* 下载设置 */}
          <Card title="下载设置" description="新任务的默认选项与并发控制">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="默认下载质量"
                value={form.downloadQuality}
                onChange={(e) => patch('downloadQuality', e.target.value)}
                options={QUALITY_OPTIONS.map((q) => ({ value: q.value, label: q.label }))}
              />
              <Select
                label="默认文件格式"
                value={form.downloadFormat}
                onChange={(e) => patch('downloadFormat', e.target.value)}
                options={FORMAT_OPTIONS.map((f) => ({ value: f.value, label: f.label }))}
              />
              <div className="sm:col-span-2">
                <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">最大并发任务</span>
                <div className="flex flex-wrap gap-2">
                  {CONCURRENCY_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => patch('maxConcurrency', n)}
                      className={`h-10 w-14 rounded-lg border text-sm font-semibold transition ${
                        form.maxConcurrency === n
                          ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-slate-400">超过并发上限的任务将进入等待状态</p>
              </div>
              <div className="sm:col-span-2">
                <Input
                  label="默认保存目录"
                  value={form.downloadDir}
                  onChange={(e) => patch('downloadDir', e.target.value)}
                  leading={<Download className="h-4 w-4" />}
                  hint="相对路径相对于项目根目录解析；保存时会自动创建并校验目录可写，修改后新任务使用该目录"
                />
              </div>
            </div>
          </Card>

          {/* 网络设置 */}
          <Card title="网络设置" description="限速、超时与自动重试">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <Input
                  label="最大下载速度"
                  type="number"
                  min={0}
                  value={form.maxSpeedKBps > 0 ? Math.round((form.maxSpeedKBps / 1024) * 100) / 100 : 0}
                  onChange={(e) => {
                    const mbps = Math.max(0, Number(e.target.value) || 0);
                    patch('maxSpeedKBps', Math.round(mbps * 1024));
                  }}
                  leading={<Gauge className="h-4 w-4" />}
                />
                <p className="mt-1 text-xs text-slate-400">单位 MB/s，0 表示不限速</p>
              </div>
              <Input
                label="请求超时"
                type="number"
                min={5}
                max={600}
                value={form.timeoutSec}
                onChange={(e) => patch('timeoutSec', Math.max(5, Math.min(600, Number(e.target.value) || 60)))}
                leading={<Timer className="h-4 w-4" />}
                hint="单位：秒"
              />
              <Input
                label="自动重试次数"
                type="number"
                min={0}
                max={10}
                value={form.autoRetries}
                onChange={(e) => patch('autoRetries', Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0))))}
                leading={<RefreshCw className="h-4 w-4" />}
                hint="失败后自动重试 0~10 次"
              />
              <div className="sm:col-span-3">
                <Input
                  label="代理服务器（可选）"
                  value={form.proxyUrl}
                  onChange={(e) => patch('proxyUrl', e.target.value)}
                  leading={<Globe className="h-4 w-4" />}
                  placeholder="http://127.0.0.1:10020"
                  hint="支持 http://、https://、socks5:// 代理，例如 http://127.0.0.1:10020；留空表示直连。本机与局域网地址会自动直连。修改后对之后发起的解析与下载生效。"
                />
              </div>
              <div className="sm:col-span-3">
                <Input
                  label="Cookie 文件路径（可选）"
                  value={form.cookiesFile}
                  onChange={(e) => patch('cookiesFile', e.target.value)}
                  leading={<Cookie className="h-4 w-4" />}
                  hint="Netscape 格式 cookies.txt 的绝对路径。部分平台（如抖音、X）的视频需要新鲜 Cookie 才能解析与下载；仅用于你本人有权访问的内容，留空则不使用。"
                />
              </div>
            </div>
          </Card>

          {/* 解析源 */}
          <ParsersCard />

          {/* 外观 */}
          <Card title="外观" description="选择主题模式">
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { value: 'light', label: '浅色', icon: <Sun className="h-4 w-4" /> },
                  { value: 'dark', label: '深色', icon: <Moon className="h-4 w-4" /> },
                  { value: 'system', label: '跟随系统', icon: <Monitor className="h-4 w-4" /> },
                ] as Array<{ value: ThemeMode; label: string; icon: React.ReactNode }>
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`theme-${opt.value}`}
                  onClick={() => setMode(opt.value)}
                  className={`flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border text-xs font-medium transition ${
                    mode === opt.value
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400'
                      : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
                  }`}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          </Card>

          {/* 系统 */}
          <Card
            title="系统信息"
            description="运行环境与存储状态"
            action={
              <button
                type="button"
                aria-label="刷新系统信息"
                onClick={() => void loadSystem()}
                className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-indigo-600 dark:hover:bg-slate-800"
              >
                <RefreshCw className={`h-4 w-4 ${sysLoading ? 'animate-spin' : ''}`} />
              </button>
            }
          >
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <Wifi className="h-4 w-4" /> 当前版本
                </dt>
                <dd className="font-mono text-xs text-slate-700 dark:text-slate-300">
                  v{system?.version ?? '—'} · Node {system?.node ?? '—'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <Database className="h-4 w-4" /> 数据库状态
                </dt>
                <dd className="flex items-center gap-1.5 text-xs">
                  <span
                    className={`h-2 w-2 rounded-full ${system ? (system.db.ok ? 'bg-emerald-500' : 'bg-rose-500') : 'bg-slate-300'}`}
                  />
                  <span className="text-slate-700 dark:text-slate-300">
                    {system ? (system.db.ok ? '正常' : '异常') : '检测中…'}
                  </span>
                  {system ? (
                    <span className="text-slate-400">
                      ({formatBytes(system.db.sizeBytes)} · {system.db.taskCount} 任务)
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <Download className="h-4 w-4" /> 下载目录状态
                </dt>
                <dd className="flex items-center gap-1.5 text-xs">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      system ? (system.downloadDir.writable ? 'bg-emerald-500' : 'bg-rose-500') : 'bg-slate-300'
                    }`}
                  />
                  <span className="text-slate-700 dark:text-slate-300">
                    {system ? (system.downloadDir.writable ? '可写' : system.downloadDir.exists ? '不可写' : '不存在') : '检测中…'}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <HardDrive className="h-4 w-4" /> 磁盘剩余空间
                </dt>
                <dd className="text-xs text-slate-700 dark:text-slate-300">
                  {system?.downloadDir.freeBytes != null ? formatBytes(system.downloadDir.freeBytes) : '未知'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                <dt className="text-xs text-slate-400">下载目录路径</dt>
                <dd className="max-w-[60%] truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={system?.downloadDir.path}>
                  {system?.downloadDir.path ?? '—'}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      )}
    </div>
  );
}
