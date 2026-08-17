import { useEffect, useState } from 'react';
import { Pencil, Plus, Puzzle, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { Parser, ParserInput } from '../lib/types';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Input, Select } from '../components/ui/Field';
import { Badge } from '../components/ui/Badge';

const EMPTY: ParserInput = {
  name: '',
  domains: '',
  type: 'ytdlp',
  enabled: true,
  ytdlpArgs: '',
  headers: '',
  script: '',
  cookiesFile: '',
};

export function ParsersCard() {
  const toast = useToast();
  const [parsers, setParsers] = useState<Parser[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ParserInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    try {
      const { parsers } = await api.listParsers();
      setParsers(parsers);
    } catch {
      // 静默
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY);
    setOpen(true);
  };

  const openEdit = (p: Parser) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      domains: p.domains,
      type: p.type,
      enabled: p.enabled,
      ytdlpArgs: p.ytdlpArgs,
      headers: p.headers,
      script: p.script,
      cookiesFile: p.cookiesFile,
    });
    setOpen(true);
  };

  const patch = <K extends keyof ParserInput>(key: K, value: ParserInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = async () => {
    if (!form.name.trim() || !form.domains.trim()) {
      toast.error('请填写名称与域名');
      return;
    }
    if (form.type === 'script' && !form.script.trim()) {
      toast.error('脚本型解析源必须填写脚本命令');
      return;
    }
    if (form.headers.trim()) {
      try {
        JSON.parse(form.headers.trim());
      } catch {
        toast.error('请求头必须是合法 JSON 对象，如 {"Referer":"https://example.com"}');
        return;
      }
    }
    setSaving(true);
    try {
      if (editingId) {
        await api.updateParser(editingId, form);
        toast.success('解析源已更新');
      } else {
        await api.createParser(form);
        toast.success('解析源已添加');
      }
      setOpen(false);
      void load();
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDeleteId || deleting) return;
    setDeleting(true);
    try {
      await api.deleteParser(confirmDeleteId);
      toast.success('解析源已删除');
      setConfirmDeleteId(null);
      void load();
    } catch (e) {
      toast.error('删除失败', e instanceof Error ? e.message : '未知错误');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card
      className="xl:col-span-2"
      title="解析源（自定义）"
      description="为任意站点添加解析规则：yt-dlp 参数型（覆盖 yt-dlp 支持的 1900+ 站点）或自定义脚本型（脚本输出直链 JSON）。内置平台优先于自定义解析源。"
      action={
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate}>
          添加解析源
        </Button>
      }
    >
      {loading ? (
        <p className="py-6 text-center text-xs text-slate-400">加载中…</p>
      ) : parsers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Puzzle className="h-6 w-6 text-slate-300 dark:text-slate-600" />
          <p className="text-xs text-slate-400">
            暂无自定义解析源。未匹配内置平台的链接会自动尝试 yt-dlp 通用解析（支持 1900+ 站点）。
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {parsers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{p.name}</span>
                  <Badge tone={p.type === 'script' ? 'violet' : 'indigo'}>
                    {p.type === 'script' ? '脚本型' : 'yt-dlp 型'}
                  </Badge>
                  <Badge tone={p.enabled ? 'emerald' : 'slate'}>{p.enabled ? '已启用' : '已停用'}</Badge>
                </div>
                <p className="mt-1 truncate text-[11px] text-slate-400" title={p.domains}>
                  域名：{p.domains}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  title="编辑"
                  aria-label="编辑解析源"
                  onClick={() => openEdit(p)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="删除"
                  aria-label="删除解析源"
                  onClick={() => setConfirmDeleteId(p.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:text-rose-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 添加/编辑弹窗 */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editingId ? '编辑解析源' : '添加解析源'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button loading={saving} onClick={() => void save()}>
              保存解析源
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="名称"
            data-testid="parser-name"
            value={form.name}
            onChange={(e) => patch('name', e.target.value)}
            placeholder="如：微博"
          />
          <Input
            label="域名（逗号分隔）"
            data-testid="parser-domains"
            value={form.domains}
            onChange={(e) => patch('domains', e.target.value)}
            placeholder="如：weibo.com,weibo.cn"
            hint="支持子域名匹配"
          />
          <Select
            label="类型"
            data-testid="parser-type"
            value={form.type}
            onChange={(e) => patch('type', e.target.value as ParserInput['type'])}
            options={[
              { value: 'ytdlp', label: 'yt-dlp 参数型' },
              { value: 'script', label: '自定义脚本型' },
            ]}
          />
          <Input
            label="Cookie 文件（可选）"
            value={form.cookiesFile}
            onChange={(e) => patch('cookiesFile', e.target.value)}
            placeholder="Netscape 格式 cookies.txt 路径"
          />
          {form.type === 'ytdlp' ? (
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
                附加 yt-dlp 参数（可选，每行一个）
              </label>
              <textarea
                data-testid="parser-args"
                value={form.ytdlpArgs}
                onChange={(e) => patch('ytdlpArgs', e.target.value)}
                rows={3}
                placeholder={'--extractor-args "generic:..."\n--referer https://example.com'}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>
          ) : (
            <div className="sm:col-span-2">
              <Input
                label="脚本命令（{url} 为页面链接占位符）"
                data-testid="parser-script"
                value={form.script}
                onChange={(e) => patch('script', e.target.value)}
                placeholder={'node C:\\parsers\\site.mjs {url}'}
                hint="脚本在 stdout 输出一行 JSON：{ title?, thumbnail?, author?, durationSec?, url(必填，直链), sizeBytes?, headers? }；未出现 {url} 时自动追加为最后一个参数"
              />
            </div>
          )}
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              附加请求头（可选，JSON 对象）
            </label>
            <textarea
              data-testid="parser-headers"
              value={form.headers}
              onChange={(e) => patch('headers', e.target.value)}
              rows={2}
              placeholder={'{"Referer":"https://example.com","User-Agent":"..."}'}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => patch('enabled', e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            启用该解析源
          </label>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={confirmDeleteId !== null}
        onClose={() => setConfirmDeleteId(null)}
        title="删除解析源"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDeleteId(null)}>
              取消
            </Button>
            <Button variant="danger" loading={deleting} onClick={() => void doDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          确定删除解析源「{parsers.find((p) => p.id === confirmDeleteId)?.name}」吗？该解析源的历史任务不受影响。
        </p>
      </Modal>
    </Card>
  );
}
