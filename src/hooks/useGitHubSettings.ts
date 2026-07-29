import { useCallback, useState } from 'react';
import type { GitHubSettings } from '../github/client';

const STORAGE_KEY = 'sqlviz.githubSettings.v1';

const EMPTY_SETTINGS: GitHubSettings = { token: '', owner: '', repo: '', branch: 'main' };

function load(): GitHubSettings {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_SETTINGS;
    return { ...EMPTY_SETTINGS, ...(JSON.parse(raw) as Partial<GitHubSettings>) };
  } catch {
    return EMPTY_SETTINGS;
  }
}

function save(settings: GitHubSettings): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // sessionStorage unavailable (e.g. disabled by browser settings) — settings
    // just won't survive a reload, which is an acceptable degradation here.
  }
}

/** Backs the GitHub PAT/repo/branch settings with sessionStorage (cleared on
 * tab close, survives reload) per github-sync-spec.md 7節. Never persisted to
 * localStorage — the PAT's exposure window should stay session-scoped. */
export function useGitHubSettings() {
  const [settings, setSettingsState] = useState<GitHubSettings>(load);

  const setSettings = useCallback((next: GitHubSettings) => {
    setSettingsState(next);
    save(next);
  }, []);

  return { settings, setSettings };
}
