import { PLATFORM_META } from '../lib/constants';

interface PlatformBadgeProps {
  platform: string;
  name?: string;
}

export function PlatformBadge({ platform, name }: PlatformBadgeProps) {
  const meta = PLATFORM_META[platform] ?? PLATFORM_META.generic;
  const label = name?.trim() || meta.name;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badgeClass}`}
      title={name && name !== meta.name ? platform : undefined}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
      {label}
    </span>
  );
}
