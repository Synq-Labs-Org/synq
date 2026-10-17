'use client';

import { useEffect, useState } from 'react';

/** Looks the workspace page ships; the first is the default. Matches the iMessage themes. */
export const WORKSPACE_THEMES = [
  { id: 'ascii', name: 'ASCII' },
  { id: 'paper', name: 'Paper' },
  { id: 'holo', name: 'Holo' },
] as const;
export type WorkspaceTheme = (typeof WORKSPACE_THEMES)[number]['id'];

const KEY = 'synq.theme';
const isTheme = (v: unknown): v is WorkspaceTheme =>
  WORKSPACE_THEMES.some((t) => t.id === v);

/** The viewer's saved look, kept in this browser only. */
export function useWorkspaceTheme() {
  const [theme, setTheme] = useState<WorkspaceTheme>(WORKSPACE_THEMES[0].id);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (isTheme(saved)) setTheme(saved);
    } catch {
      // Storage blocked: keep the default.
    }
  }, []);
  const choose = (next: WorkspaceTheme) => {
    setTheme(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };
  return [theme, choose] as const;
}

export function ThemePicker(props: {
  value: WorkspaceTheme;
  onChange: (theme: WorkspaceTheme) => void;
}) {
  return (
    <label className="workspace-theme">
      Theme{' '}
      <select
        value={props.value}
        onChange={(e) => {
          if (isTheme(e.target.value)) props.onChange(e.target.value);
        }}
      >
        {WORKSPACE_THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
