import { colors, radius, space } from '@nexus/ui';
import { StyleSheet } from 'react-native';

export { colors, radius, space };

/** Hue from an id (stable colors for servers/avatars without an image). */
export function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/**
 * Same look as the desktop app (0.2): navy background, floating rounded
 * panels, indigo → violet gradient for primary actions.
 */
export const common = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center' },
  /** Floating card on the navy background. */
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  header: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    gap: space.sm,
  },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '700', flex: 1, letterSpacing: 0.2 },
  text: { color: colors.text, fontSize: 15 },
  muted: { color: colors.textMuted, fontSize: 13 },
  faint: { color: colors.textFaint, fontSize: 12 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  section: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
    overflow: 'hidden',
  },
  buttonText: { color: colors.accentText, fontWeight: '700', fontSize: 15 },
  buttonSecondary: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  error: { color: colors.danger, fontSize: 13 },
  badge: {
    backgroundColor: colors.danger,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  empty: { color: colors.textFaint, padding: space.xl, textAlign: 'center', lineHeight: 20 },
});
