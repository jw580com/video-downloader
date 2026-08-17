import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  action?: ReactNode;
  padded?: boolean;
}

export function Card({ title, description, action, padded = true, className = '', children, ...rest }: CardProps) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 ${padded ? 'p-5' : ''} ${className}`}
      {...rest}
    >
      {title || action ? (
        <div className={`mb-4 flex items-start justify-between gap-3 ${padded ? '' : 'px-5 pt-5'}`}>
          <div>
            {title ? (
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}
