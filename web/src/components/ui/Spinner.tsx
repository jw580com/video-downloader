import { Loader2 } from 'lucide-react';

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-indigo-500 ${className}`} />;
}

export function PageLoading() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="flex flex-col items-center gap-3 text-slate-400">
        <Spinner className="h-7 w-7" />
        <p className="text-sm">加载中…</p>
      </div>
    </div>
  );
}
