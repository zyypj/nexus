import type { Presence, PublicUser } from '@nexus/protocol';
import { hueFor, initials } from '@nexus/shared';
import { ICON_PATHS, type IconName, presenceColor } from '@nexus/ui';
import React, { memo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { client } from '../lib/nexus';
import { colors } from './theme';

export function Icon({ name, size = 22, color = colors.textMuted }: { name: IconName; size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={ICON_PATHS[name]} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconButton({
  name,
  onPress,
  color,
  active,
  danger,
  size = 22,
  label,
}: {
  name: IconName;
  onPress: () => void;
  color?: string;
  active?: boolean;
  danger?: boolean;
  size?: number;
  label: string;
}) {
  const c = color ?? (danger ? colors.danger : active ? colors.accent : colors.textMuted);
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.surfaceHover }]}
    >
      <Icon name={name} size={size} color={c} />
    </Pressable>
  );
}

export const Avatar = memo(function Avatar({
  user,
  size = 40,
  presence,
  speaking,
}: {
  user: Pick<PublicUser, 'id' | 'display_name' | 'avatar_url'> | undefined;
  size?: number;
  presence?: Presence;
  speaking?: boolean;
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
              backgroundColor: `hsl(${hue}, 45%, 32%)`,
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
            { width: size * 0.32, height: size * 0.32, borderRadius: size, backgroundColor: presenceColor(presence) },
          ]}
        />
      )}
    </View>
  );
});

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count >= 100 ? '99+' : count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  iconButton: { padding: 8, borderRadius: 8 },
  presence: { position: 'absolute', right: -1, bottom: -1, borderWidth: 2, borderColor: colors.surface },
  badge: {
    backgroundColor: colors.danger,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
