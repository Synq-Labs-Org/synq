'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ThemePicker,
  WORKSPACE_THEMES,
  type WorkspaceTheme,
} from '../workspaces/theme-picker';

/** The same storage key the workspace pages and the iOS app use. */
const KEY = 'synq.theme';
/** The landing page's art-directed default. */
export const LANDING_DEFAULT_THEME: WorkspaceTheme = 'ascii';

const isTheme = (v: unknown): v is WorkspaceTheme =>
  WORKSPACE_THEMES.some((t) => t.id === v);

type ThemeState = {
  theme: WorkspaceTheme;
  setTheme: (theme: WorkspaceTheme) => void;
};

const ThemeContext = createContext<ThemeState>({
  theme: LANDING_DEFAULT_THEME,
  setTheme: () => undefined,
});

export const useLandingTheme = () => useContext(ThemeContext);

/**
 * Owns the look of the landing page. Sections only read tokens (CSS
 * variables under `[data-theme]`) and ask `art.tsx` for per-theme art, so a
 * theme never needs changes inside a section.
 */
export function LandingThemeScope({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<WorkspaceTheme>(
    LANDING_DEFAULT_THEME,
  );
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (isTheme(saved)) setThemeState(saved);
    } catch {
      // Storage blocked: keep the default look.
    }
  }, []);
  const setTheme = useCallback((next: WorkspaceTheme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // The choice lasts for this visit.
    }
  }, []);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return (
    <ThemeContext.Provider value={value}>
      <div className="lp-shell" data-theme={theme}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function LandingThemePicker() {
  const { theme, setTheme } = useLandingTheme();
  return <ThemePicker value={theme} onChange={setTheme} />;
}
