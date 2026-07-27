import { useState } from 'react';
import type { AppMode } from '../types';

export type { AppMode };

export interface UseAppModeResult {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export function useAppMode(): UseAppModeResult {
  const [mode, setMode] = useState<AppMode>('design');
  return { mode, setMode };
}
