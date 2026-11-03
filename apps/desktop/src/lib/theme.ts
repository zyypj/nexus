import { cssVariables } from "@nexus/ui";

/**
 * Desktop look (1.0): flat, calm graphite surfaces with a muted teal accent.
 * Only the desktop app uses these; Android keeps the shared @nexus/ui tokens.
 */
const desktop: Record<string, string> = {
  "--c-bg": "#121517",
  "--c-surface": "#171b1e",
  "--c-main": "#1a1e21",
  "--c-surface-raised": "#20252a",
  "--c-surface-hover": "#262c31",
  "--c-border": "#2a3036",
  "--c-border-soft": "#23282d",
  "--c-text": "#e4e7e9",
  "--c-text-muted": "#9aa3a9",
  "--c-text-faint": "#646d73",
  "--c-accent": "#3d8f7d",
  "--c-accent-hover": "#47a18d",
  "--c-accent-text": "#ffffff",
  "--c-accent2": "#2f7465",
  "--c-accent-soft": "rgba(61, 143, 125, 0.16)",
  "--c-accent-strong": "#6cc3ad",
  "--c-highlight": "#6cc3ad",
  "--c-danger": "#e0606e",
  "--c-danger-soft": "rgba(224, 96, 110, 0.16)",
  "--c-success": "#3fb98a",
  "--c-speaking": "#3fb98a",
  "--c-idle": "#d9a441",
  "--c-mention": "rgba(61, 143, 125, 0.14)",
  "--radius-sm": "6px",
  "--radius-md": "8px",
  "--radius-lg": "10px",
  /** Avatars are rounded squares everywhere except inside calls. */
  "--avatar-radius": "30%",
};

export function applyTheme() {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries({ ...cssVariables(), ...desktop })) root.setProperty(k, v);
}
