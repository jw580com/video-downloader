import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Settings } from '../lib/types';

export function useSettings(): {
  settings: Settings | null;
  loading: boolean;
  save: (partial: Partial<Settings>) => Promise<Settings>;
  reload: () => void;
} {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { settings: s } = await api.getSettings();
      setSettings(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (partial: Partial<Settings>) => {
    const { settings: s } = await api.updateSettings(partial);
    setSettings(s);
    return s;
  }, []);

  return { settings, loading, save, reload: load };
}
