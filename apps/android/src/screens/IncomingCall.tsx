import { conversationTitle } from '@nexus/shared';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { calls, useCall } from '../call/callManager';
import { useNexus } from '../lib/nexus';
import { startLoop, stopLoop } from '../lib/sounds';
import { IconButton } from '../ui/components';
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
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{caller ?? 'Alguém'} está chamando</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <IconButton
        name="phone"
        label="Atender"
        color={colors.success}
        onPress={() => {
          void calls.join(ringing.id);
          onAnswer();
        }}
      />
      <IconButton
        name="phoneOff"
        label="Recusar"
        danger
        onPress={() => setDismissed((d) => new Set(d).add(ringing.id))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    margin: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  title: { color: colors.text, fontWeight: '700', fontSize: 15 },
  sub: { color: colors.textMuted, fontSize: 13 },
});
