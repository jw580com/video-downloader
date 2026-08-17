import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FolderOpen,
  Link2,
  Loader2,
  Play,
  Plus,
  Sparkles,
  User,
} from 'lucide-react';
import { api } from '../lib/api';
import type { VideoInfo } from '../lib/types';
import { formatBytes, formatDuration } from '../lib/format';
import { SUPPORTED_PLATFORM_CHIPS } from '../lib/constants';
import { useSettings } from '../hooks/useSettings';
import { useToast } from '../context/ToastContext';
import { PlatformBadge } from '../components/PlatformBadge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input, Select } from '../components/ui/Field';
import { Modal } from '../components/ui/Modal';

export default function HomePage() {
  const [url, setUrl] = useState('');
  const [parsing, setParsing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState('best');
  const [format, setFormat] = useState('mp4');
  const [folder, setFolder] = useState('');
  const [dragging, setDragging] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [addedTaskId, setAddedTaskId] = useState<string | null>(null);
  const { settings } = useSettings();
  const toast = useToast();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settings && !info) {
      setQuality(settings.downloadQuality);
      setFormat(settings.downloadFormat);
      setFolder(settings.downloadDir);
    }
  }, [settings, info]);

  const estimate = useMemo(() => {
    if (!info) return undefined;
    if (info.sizeBytes) return info.sizeBytes;
    return undefined;
  }, [info]);

  const handleParse = async () => {
    if (parsing) return;
    setError(null);
    setInfo(null);
    setAddedTaskId(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setError('请先粘贴视频链接');
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('URL 无效，请输入以 http:// 或 https:// 开头的链接');
      return;
    }
    setParsing(true);
    try {
      const { info: parsed } = await api.parse(trimmed);
      setInfo(parsed);
      if (parsed.qualities.some((q) => q.value === quality) === false) {
        setQuality(parsed.qualities[0]?.value ?? 'best');
      }
      if (parsed.formats.some((f) => f.value === format) === false) {
        setFormat(parsed.formats[0]?.value ?? 'mp4');
      }
      if (!parsed.downloadable && parsed.warning) {
        toast.info('仅获取到元数据', parsed.warning);
      } else {
        toast.success('解析成功', `${parsed.platformName} · ${parsed.title}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '解析失败';
      setError(msg);
      toast.error('解析失败', msg);
    } finally {
      setParsing(false);
    }
  };

  const doAdd = async () => {
    if (!info || adding) return;
    setAdding(true);
    try {
      const { task } = await api.createTask({
        url: info.url,
        quality,
        format,
        folder: folder || undefined,
        title: info.title,
        thumbnail: info.thumbnail,
        author: info.author,
        durationSec: info.durationSec,
        formatId: info.formatId,
        totalBytes: info.sizeBytes ?? 0,
        engine: info.engine,
        platform: info.platform,
        platformName: info.platformName,
        resolvedUrl: info.downloadUrl,
        headers: info.headers,
        ytdlpArgs: info.ytdlpArgs,
        cookiesFile: info.cookiesFile,
      });
      setAddedTaskId(task.id);
      toast.success('已加入下载队列', `${info.title}`);
      window.setTimeout(() => navigate('/tasks'), 900);
    } catch (e) {
      toast.error('添加失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setAdding(false);
    }
  };

  const handleAdd = () => {
    if (info?.duplicate) {
      setDupOpen(true);
      return;
    }
    void doAdd();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length > 0) {
      setUrl(lines[0]);
      inputRef.current?.focus();
      toast.info('已识别拖入的链接', lines[0].slice(0, 80));
    }
  };

  return (
    <div className="animate-fade-in">
      {/* Hero */}
      <div className="mx-auto max-w-3xl pt-8 text-center lg:pt-16">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-400">
          <Sparkles className="h-3.5 w-3.5" />
          支持 {SUPPORTED_PLATFORM_CHIPS.length}+ 平台 · 可自定义解析源 · 公开视频资源
        </span>
        <h1 className="mt-5 text-3xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-4xl lg:text-5xl">
          在线视频下载管理器
        </h1>
        <p className="mt-3 text-base text-slate-500 dark:text-slate-400 sm:text-lg">
          统一管理你的在线视频下载任务
        </p>
      </div>

      {/* 输入区 */}
      <div className="mx-auto mt-8 max-w-2xl">
        <div
          data-testid="drop-zone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`rounded-2xl border-2 border-dashed p-4 transition sm:p-5 ${
            dragging
              ? 'border-indigo-500 bg-indigo-50/70 dark:bg-indigo-500/10'
              : 'border-slate-300 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900'
          }`}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
                <Link2 className="h-4 w-4" />
              </span>
              <input
                ref={inputRef}
                data-testid="url-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleParse();
                }}
                placeholder="粘贴视频链接，或拖拽链接到此处"
                className="h-12 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500"
              />
            </div>
            <Button
              size="lg"
              data-testid="parse-btn"
              onClick={() => void handleParse()}
              loading={parsing}
              className="sm:w-36"
            >
              {parsing ? '解析中…' : '解析视频'}
            </Button>
          </div>
          {error ? (
            <p data-testid="parse-error" className="mt-2.5 flex items-center gap-1.5 text-sm text-rose-500">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : (
            <p className="mt-2.5 text-xs text-slate-400 dark:text-slate-500">
              支持 YouTube、Bilibili、Vimeo、X (Twitter)、TikTok、抖音、Instagram 及直链视频，更多站点可在「设置 → 解析源」自定义 · 仅处理公开且你有权下载的内容
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {SUPPORTED_PLATFORM_CHIPS.map((p) => (
            <span
              key={p}
              className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
            >
              {p}
            </span>
          ))}
        </div>
      </div>

      {/* 解析结果预览卡片 */}
      {parsing ? (
        <div className="mx-auto mt-10 max-w-2xl">
          <Card className="flex items-center gap-4">
            <div className="flex h-24 w-40 animate-pulse items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800">
              <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
            </div>
            <div className="flex-1 space-y-2.5">
              <div className="h-4 w-3/4 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
            </div>
          </Card>
          <p className="mt-3 text-center text-xs text-slate-400">正在获取视频信息，请稍候…</p>
        </div>
      ) : null}

      {info ? (
        <div className="mx-auto mt-10 max-w-2xl animate-slide-up">
          <Card data-testid="preview-card">
            <div className="flex flex-col gap-5 sm:flex-row">
              {/* 缩略图 */}
              <div className="relative h-40 w-full shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-900 sm:w-56">
                {info.thumbnail ? (
                  <img src={info.thumbnail} alt={info.title} className="h-full w-full object-cover" />
                ) : null}
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/20">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-lg">
                    <Play className="h-5 w-5 fill-indigo-600 text-indigo-600" />
                  </div>
                </div>
                {info.durationSec > 0 ? (
                  <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-slate-950/80 px-1.5 py-0.5 text-xs font-medium text-white">
                    <Clock className="h-3 w-3" />
                    {formatDuration(info.durationSec)}
                  </span>
                ) : null}
              </div>
              {/* 信息 */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <PlatformBadge platform={info.platform} name={info.platformName} />
                  {info.sizeBytes ? (
                    <span className="text-xs text-slate-400">约 {formatBytes(info.sizeBytes)}</span>
                  ) : null}
                </div>
                <h2 className="mt-2 line-clamp-2 text-base font-semibold leading-snug text-slate-900 dark:text-white">
                  {info.title}
                </h2>
                {info.author ? (
                  <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-slate-500 dark:text-slate-400">
                    <User className="h-3.5 w-3.5 shrink-0" />
                    {info.author}
                  </p>
                ) : null}
                {info.warning ? (
                  <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {info.warning}
                  </p>
                ) : null}
                {info.duplicate ? (
                  <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    该视频此前已下载完成（「{info.duplicate.title.slice(0, 40)}」）。如仍要添加，将创建新的下载任务。
                  </p>
                ) : null}
                {addedTaskId ? (
                  <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    已加入下载队列，正在跳转到任务页…
                  </p>
                ) : null}
              </div>
            </div>

            {/* 选项区 */}
            <div className="mt-5 grid grid-cols-1 gap-4 border-t border-slate-100 pt-5 dark:border-slate-800 sm:grid-cols-3">
              <Select
                label="视频质量"
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                options={info.qualities.map((q) => ({ value: q.value, label: q.label }))}
              />
              <Select
                label="文件格式"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                options={info.formats.map((f) => ({ value: f.value, label: f.label }))}
              />
              <Input
                label="保存位置"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                leading={<FolderOpen className="h-4 w-4" />}
                hint="留空则使用默认下载目录"
              />
            </div>

            <div className="mt-5 flex flex-col-reverse items-center gap-3 sm:flex-row sm:justify-between">
              <p className="text-xs text-slate-400 dark:text-slate-500">
                {estimate
                  ? `预估大小：${formatBytes(estimate)} · ${quality === 'best' ? '最佳画质' : `${quality}P`} · ${format.toUpperCase()}`
                  : `画质 ${quality === 'best' ? '最佳' : quality} · ${format.toUpperCase()}（大小未知）`}
              </p>
              <div className="flex w-full gap-2 sm:w-auto">
                <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => setInfo(null)}>
                  取消
                </Button>
                <Button
                  data-testid="add-btn"
                  className="flex-1 sm:flex-none sm:px-8"
                  loading={adding}
                  disabled={!info.downloadable}
                  onClick={handleAdd}
                >
                  <Plus className="h-4 w-4" />
                  加入下载队列
                </Button>
              </div>
            </div>
            {!info.downloadable ? (
              <p className="mt-3 text-center text-xs text-amber-500">
                当前环境缺少 yt-dlp，无法下载该平台视频，仅展示元数据
              </p>
            ) : null}
          </Card>
        </div>
      ) : null}

      {/* 重复下载确认 */}
      <Modal
        open={dupOpen}
        onClose={() => setDupOpen(false)}
        title="重复下载确认"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDupOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setDupOpen(false);
                void doAdd();
              }}
            >
              仍要添加
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          该视频已在下载历史中完成过下载（{info?.duplicate?.title.slice(0, 50)}）。再次添加会创建新的下载任务并占用磁盘空间，确定继续吗？
        </p>
      </Modal>
    </div>
  );
}
