import type { Presence, PublicUser, ServerView } from '@nexus/protocol';
import { hueFor, initials } from '@nexus/shared';
import { ICON_PATHS, type IconName, presenceColor } from '@nexus/ui';
import React, { memo } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { client } from '../lib/nexus';
import { colors, common, hueOf, radius, space } from './theme';

export function Icon({ name, size = 22, color = colors.textMuted }: { name: IconName; size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={ICON_PATHS[name]} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Filled glyph (play/pause look better solid). */
export function SolidIcon({ name, size = 22, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={ICON_PATHS[name]} fill={color} />
    </Svg>
  );
}

let gradientSeq = 0;

/**
 * Diagonal gradient filling its parent (absolute). Default: the brand
 * indigo → violet, as on the desktop buttons and the logo.
 */
export const Gradient = memo(function Gradient({
  from = colors.accent,
  to = colors.accent2,
  radius: r = 0,
}: {
  from?: string;
  to?: string;
  radius?: number;
}) {
  const id = React.useMemo(() => `g${++gradientSeq}`, []);
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" rx={r} ry={r} fill={`url(#${id})`} />
    </Svg>
  );
});

export function IconButton({
  name,
  onPress,
  color,
  active,
  danger,
  size = 22,
  label,
  filled,
}: {
  name: IconName;
  onPress: () => void;
  color?: string;
  active?: boolean;
  danger?: boolean;
  size?: number;
  label: string;
  /** Round raised background (header buttons). */
  filled?: boolean;
}) {
  const c = color ?? (danger ? colors.danger : active ? colors.accent : colors.textMuted);
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={8}
      android_ripple={{ color: colors.surfaceHover, borderless: true, radius: size }}
      style={({ pressed }) => [styles.iconButton, filled && styles.iconButtonFilled, pressed && { opacity: 0.7 }]}
    >
      <Icon name={name} size={size} color={c} />
    </Pressable>
  );
}

/** Top bar: round back button, title (+ subtitle), right actions. */
export function Header({
  title,
  subtitle,
  onBack,
  left,
  right,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onBack?: () => void;
  left?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <View style={common.header}>
      {onBack && <IconButton name="arrowLeft" label="Voltar" filled onPress={onBack} color={colors.text} />}
      {left}
      <View style={{ flex: 1 }}>
        <Text style={[common.headerTitle, { flex: 0 }]} numberOfLines={1}>
          {title}
        </Text>
        {typeof subtitle === 'string' ? (
          <Text style={common.faint} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {right}
    </View>
  );
}

/** Primary (gradient), secondary or danger button. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const primary = variant === 'primary';
  const fg = primary ? colors.accentText : variant === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        primary ? styles.btnPrimary : styles.btnSecondary,
        variant === 'danger' && { borderColor: 'rgba(244,80,107,0.45)' },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {primary && <Gradient radius={radius.md} />}
      {busy ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <View style={[common.row, { gap: space.sm }]}>
          {icon && <Icon name={icon} size={18} color={fg} />}
          <Text style={[styles.btnText, { color: fg }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Bottom sheet with a grab handle. */
export function Sheet({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Modal transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.handle} />
          {title && <Text style={[common.headerTitle, { flex: 0, marginBottom: space.sm }]}>{title}</Text>}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function SheetItem({
  icon,
  label,
  onPress,
  danger,
  hint,
}: {
  icon?: IconName;
  label: string;
  onPress: () => void;
  danger?: boolean;
  hint?: string;
}) {
  const c = danger ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.surfaceHover }}
      style={({ pressed }) => [styles.sheetItem, pressed && { backgroundColor: colors.surfaceHover }]}
    >
      {icon && (
        <View style={[styles.sheetIcon, danger && { backgroundColor: 'rgba(244,80,107,0.14)' }]}>
          <Icon name={icon} size={18} color={c} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={[common.text, { color: c, fontWeight: '600' }]}>{label}</Text>
        {hint && <Text style={common.faint}>{hint}</Text>}
      </View>
    </Pressable>
  );
}

/** Rounded card with an optional section title (settings, profile). */
export function Card({ title, children, style }: { title?: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      {title && <Text style={[common.section, { marginBottom: space.sm, marginLeft: space.xs }]}>{title}</Text>}
      <View style={[common.panel, { padding: space.md, gap: space.md }]}>{children}</View>
    </View>
  );
}

export const Avatar = memo(function Avatar({
  user,
  size = 40,
  presence,
  speaking,
  ringColor = colors.surface,
}: {
  user: Pick<PublicUser, 'id' | 'display_name' | 'avatar_url'> | undefined;
  size?: number;
  presence?: Presence;
  speaking?: boolean;
  /** Color around the presence dot (the background it sits on). */
  ringColor?: string;
}) {
  const url = user?.avatar_url ? client().api.url(user.avatar_url) : undefined;
  const hue = hueFor(user?.id ?? '?');
  const ring = speaking ? { borderWidth: 3, borderColor: colors.speaking } : null;
  return (
    <View style={{ width: size, height: size }}>
      {url ? (
        <Image source={{ uri: url }} style={[{ width: size, height: size, borderRadius: size / 2 }, ring]} />
      ) : (
        <View
          style={[
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: `hsl(${hue}, 45%, 36%)`,
              alignItems: 'center',
              justifyContent: 'center',
            },
            ring,
          ]}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>
            {initials(user?.display_name ?? '?')}
          </Text>
        </View>
      )}
      {presence && (
        <View
          style={[
            styles.presence,
            {
              width: Math.max(10, size * 0.3),
              height: Math.max(10, size * 0.3),
              borderRadius: size,
              backgroundColor: presenceColor(presence),
              borderColor: ringColor,
            },
          ]}
        />
      )}
    </View>
  );
});

/** Server icon: its image, or the initials on a per-server gradient (same as desktop). */
export function ServerIcon({
  server,
  size = 48,
  rounded = size * 0.32,
}: {
  server: Pick<ServerView, 'id' | 'name' | 'icon_url'>;
  size?: number;
  rounded?: number;
}) {
  const url = client().api.url(server.icon_url);
  const words = server.name.trim().split(/\s+/).filter(Boolean);
  const text = (words.length > 1 ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '') : server.name.slice(0, 2)).toUpperCase();
  if (url) return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: rounded }} />;
  const a = hueOf(server.id);
  return (
    <View style={{ width: size, height: size, borderRadius: rounded, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      <Gradient from={`hsl(${a}, 70%, 58%)`} to={`hsl(${(a + 50) % 360}, 72%, 48%)`} radius={rounded} />
      <Text style={{ color: '#fff', fontWeight: '800', fontSize: size * 0.34 }}>{text}</Text>
    </View>
  );
}

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count >= 100 ? '99+' : count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  iconButton: { padding: 8, borderRadius: 999 },
  iconButtonFilled: { backgroundColor: colors.surfaceRaised },
  presence: { position: 'absolute', right: -2, bottom: -2, borderWidth: 3 },
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
  btnPrimary: {
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    elevation: 3,
  },
  btnSecondary: {
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnText: { fontWeight: '700', fontSize: 15 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(3,4,10,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    gap: 2,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: space.md,
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  sheetIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
