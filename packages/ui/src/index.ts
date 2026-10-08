/**
 * Nexus visual identity: deep slate surfaces, a teal accent and warm amber
 * highlights. Deliberately unlike other chat apps' palettes.
 */
export const colors = {
  bg: "#0d1117",
  surface: "#141a21",
  surfaceRaised: "#1b232c",
  surfaceHover: "#222c37",
  border: "#27313d",
  text: "#e6edf3",
  textMuted: "#8b98a5",
  textFaint: "#5c6976",
  accent: "#2bb3a3",
  accentHover: "#33c9b7",
  accentText: "#04211d",
  highlight: "#e0a43a",
  danger: "#e5534b",
  success: "#3fb950",
  idle: "#d29922",
  dnd: "#e5534b",
  offline: "#5c6976",
  speaking: "#3fb950",
  mention: "rgba(224, 164, 58, 0.12)",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, round: 999 } as const;
export const font = {
  family: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  mono: '"Cascadia Code", Consolas, monospace',
  size: { xs: 11, sm: 13, md: 14, lg: 16, xl: 20, xxl: 26 },
} as const;

export type ColorName = keyof typeof colors;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** CSS custom properties (`--c-text`, `--space-md`...) for the desktop app. */
export function cssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) vars[`--c-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(space)) vars[`--space-${k}`] = `${v}px`;
  for (const [k, v] of Object.entries(radius)) vars[`--radius-${k}`] = `${v}px`;
  for (const [k, v] of Object.entries(font.size)) vars[`--fs-${k}`] = `${v}px`;
  vars["--font"] = font.family;
  vars["--font-mono"] = font.mono;
  return vars;
}

export const presenceColor = (p: string): string =>
  p === "online" ? colors.success : p === "idle" ? colors.idle : p === "dnd" ? colors.dnd : colors.offline;

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"] as const;

export * from "./icons";
