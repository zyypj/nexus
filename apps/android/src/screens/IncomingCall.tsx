import { conversationTitle } from '@nexus/shared';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { calls, useCall } from '../call/callManager';
import { useNexus } from '../lib/nexus';
import { startLoop, stopLoop } from '../lib/sounds';
import { Gradient, Icon } from '../ui/components';
import { colors, radius, space } from '../ui/theme';

/**
 * Ringing banner for calls started by someone else while we are not in any
 * call (same rules as the desktop app). Declined calls stay dismissed.
 */
export function IncomingCall({ onAnswer }: { onAnswer: () => void }) {
  const myId = useNexus((s) => s.me?.id);
  const myCallId = useCall((s) => s.callId);
  const ringing = useNexus((s) =>
    Object.values(s.calls).find(
      (c) =>
        // Voice channels never ring.
        !s.conversations[c.conversation_id]?.server_id &&
        c.started_by !== myId &&
        c.participants.length > 0 &&
        !c.participants.some((p) => p.user_id === myId) &&
        Date.now() - c.created_at < 60_000,
    ),
  );
  const title = useNexus((s) => {
    const c = ringing ? s.conversations[ringing.conversation_id] : undefined;
    return c ? conversationTitle(s, c) : '';
  });
  const caller = useNexus((s) => (ringing?.started_by ? s.users[ringing.started_by]?.display_name : undefined));
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const show = !!ringing && !myCallId && !dismissed.has(ringing.id);

  useEffect(() => {
    if (!show) return;
    startLoop('ring');
    return () => stopLoop('ring');
  }, [show]);

  if (!show || !ringing) return null;
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <View style={styles.icon}>
        <Gradient radius={22} />
        <Icon name="phone" size={20} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={1}>
          {caller ?? 'Alguém'} está chamando
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Pressable
        style={[styles.action, { backgroundColor: colors.danger }]}
        accessibilityLabel="Recusar"
        onPress={() => setDismissed((d) => new Set(d).add(ringing.id))}
      >
        <Icon name="phoneOff" size={20} color="#fff" />
      </Pressable>
      <Pressable
        style={[styles.action, { backgroundColor: colors.success }]}
        accessibilityLabel="Atender"
        onPress={() => {
          void calls.join(ringing.id);
          onAnswer();
        }}
      >
        <Icon name="phone" size={20} color="#fff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    margin: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: 'rgba(84,104,245,0.55)',
    elevation: 8,
  },
  icon: { width: 44, height: 44, borderRadius: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  action: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '700', fontSize: 15 },
  sub: { color: colors.textMuted, fontSize: 13 },
});
