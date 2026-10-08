/**
 * Nexus visual identity (0.2): deep navy surfaces and the logo's indigo,
 * with violet/cyan for gradients and highlights.
 */
export const colors = {
  bg: "#0a0c14",
  surface: "#11131f",
  surfaceRaised: "#181b2b",
  surfaceHover: "#1f2336",
  border: "#252a40",
  text: "#e9ebf8",
  textMuted: "#9aa0c3",
  textFaint: "#62688a",
  accent: "#5468f5",
  accentHover: "#6b7dff",
  accentText: "#ffffff",
  /** Second gradient stop (violet). */
  accent2: "#9b5cf6",
  highlight: "#22d3ee",
  danger: "#f4506b",
  success: "#2fd27a",
  idle: "#f5b041",
  dnd: "#f4506b",
  offline: "#62688a",
  speaking: "#2fd27a",
  mention: "rgba(91, 115, 247, 0.14)",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 18, round: 999 } as const;
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
