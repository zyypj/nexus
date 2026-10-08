import { formatDay, formatTime } from '@nexus/shared';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Linking,
  Modal,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
} from 'react-native';
import { useNexus } from '../lib/nexus';
import { Icon } from '../ui/components';
import { colors, space } from '../ui/theme';
import { closeViewer, useViewer } from './media';

const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 260;

const distance = (e: GestureResponderEvent) => {
  const [a, b] = e.nativeEvent.touches;
  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
};

/**
 * Full-screen image viewer: pinch or double-tap to zoom, drag to pan when
 * zoomed, swipe sideways for the other images of the conversation, swipe
 * down (or back) to close, tap to hide the bars.
 */
export function ImageViewer() {
  const items = useViewer((s) => s.items);
  const index = useViewer((s) => s.index);
  const item = items[index];
  if (!item) return null;
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={closeViewer}>
      <StatusBar barStyle="light-content" />
      <Viewer key={item.attachment.id} />
    </Modal>
  );
}

function Viewer() {
  const items = useViewer((s) => s.items);
  const index = useViewer((s) => s.index);
  const item = items[index]!;
  const author = useNexus((s) => s.users[item.authorId]?.display_name ?? '');
  const { width, height } = useWindowDimensions();
  const [chrome, setChrome] = useState(true);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const dismiss = useRef(new Animated.Value(0)).current;
  // Committed values between gestures.
  const base = useRef({ scale: 1, x: 0, y: 0 });
  const gesture = useRef<{ pinchStart: number; mode: 'none' | 'pinch' | 'pan' | 'swipe' | 'dismiss' }>({
    pinchStart: 0,
    mode: 'none',
  });
  const lastTap = useRef(0);
  // Live scale while pinching (read back on release).
  const liveScale = useRef(1);
  useEffect(() => {
    const id = scale.addListener(({ value }) => {
      liveScale.current = value;
    });
    return () => scale.removeListener(id);
  }, [scale]);

  // Image box that fits the screen (contain).
  const box = useMemo(() => {
    const w = item.attachment.width ?? width;
    const h = item.attachment.height ?? height;
    const fit = Math.min(width / w, height / h);
    return { width: w * fit, height: h * fit };
  }, [item, width, height]);

  const clampPan = (s: number, x: number, y: number) => {
    const maxX = Math.max(0, (box.width * s - width) / 2);
    const maxY = Math.max(0, (box.height * s - height) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };

  const animateTo = (s: number, x: number, y: number) => {
    base.current = { scale: s, x, y };
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true, friction: 7 }),
      Animated.spring(tx, { toValue: x, useNativeDriver: true, friction: 7 }),
      Animated.spring(ty, { toValue: y, useNativeDriver: true, friction: 7 }),
    ]).start();
  };

  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < items.length) useViewer.setState({ index: next });
  };

  const onTap = (e: GestureResponderEvent) => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      if (base.current.scale > 1.05) animateTo(1, 0, 0);
      else {
        // Zoom into the tapped point.
        const s = 2.5;
        const { x, y } = clampPan(s, (width / 2 - e.nativeEvent.pageX) * (s - 1), (height / 2 - e.nativeEvent.pageY) * (s - 1));
        animateTo(s, x, y);
      }
      return;
    }
    lastTap.current = now;
    setTimeout(() => {
      if (lastTap.current === now) setChrome((c) => !c);
    }, DOUBLE_TAP_MS);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          gesture.current = { pinchStart: distance(e), mode: 'none' };
        },
        onPanResponderMove: (e, g: PanResponderGestureState) => {
          const st = gesture.current;
          const touches = e.nativeEvent.touches.length;
          if (touches >= 2) {
            if (st.mode !== 'pinch') {
              st.mode = 'pinch';
              st.pinchStart = distance(e) || 1;
            }
            const s = Math.max(0.8, Math.min(MAX_SCALE, (base.current.scale * distance(e)) / st.pinchStart));
            scale.setValue(s);
            return;
          }
          if (st.mode === 'pinch') return;
          if (st.mode === 'none' && Math.abs(g.dx) + Math.abs(g.dy) < 8) return;
          if (st.mode === 'none') {
            st.mode =
              base.current.scale > 1.05 ? 'pan' : Math.abs(g.dx) > Math.abs(g.dy) ? 'swipe' : g.dy > 0 ? 'dismiss' : 'pan';
          }
          if (st.mode === 'pan' && base.current.scale > 1.05) {
            const { x, y } = clampPan(base.current.scale, base.current.x + g.dx, base.current.y + g.dy);
            tx.setValue(x);
            ty.setValue(y);
          } else if (st.mode === 'swipe') {
            tx.setValue(g.dx);
          } else if (st.mode === 'dismiss') {
            ty.setValue(Math.max(0, g.dy));
            dismiss.setValue(Math.min(1, Math.max(0, g.dy) / 300));
          }
        },
        onPanResponderRelease: (e, g) => {
          const st = gesture.current;
          if (st.mode === 'none') {
            onTap(e);
            return;
          }
          if (st.mode === 'pinch') {
            // Read back the live scale and settle inside the limits.
            const s = Math.max(1, Math.min(MAX_SCALE, liveScale.current));
            if (s <= 1.05) animateTo(1, 0, 0);
            else {
              const { x, y } = clampPan(s, base.current.x, base.current.y);
              animateTo(s, x, y);
            }
          } else if (st.mode === 'pan') {
            const { x, y } = clampPan(base.current.scale, base.current.x + g.dx, base.current.y + g.dy);
            base.current = { ...base.current, x, y };
          } else if (st.mode === 'swipe') {
            if (g.dx < -80 || g.vx < -0.6) go(1);
            else if (g.dx > 80 || g.vx > 0.6) go(-1);
            Animated.spring(tx, { toValue: 0, useNativeDriver: true }).start();
          } else if (st.mode === 'dismiss') {
            if (g.dy > 120 || g.vy > 0.8) closeViewer();
            else
              Animated.parallel([
                Animated.spring(ty, { toValue: 0, useNativeDriver: true }),
                Animated.spring(dismiss, { toValue: 0, useNativeDriver: true }),
              ]).start();
          }
          st.mode = 'none';
        },
        onPanResponderTerminationRequest: () => false,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [box, index, items.length, width, height],
  );

  // Native driver animates opacity, not colors: fade a black layer instead.
  const bgOpacity = dismiss.interpolate({ inputRange: [0, 1], outputRange: [1, 0.2] });
  const a = item.attachment;
  return (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.black, { opacity: bgOpacity }]} />
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
        <View style={styles.center}>
          <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
            <Image
              source={{ uri: item.url }}
              style={{ width: box.width, height: box.height }}
              resizeMode="contain"
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setFailed(true);
              }}
            />
          </Animated.View>
          {loading && <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.accent} size="large" />}
          {failed && <Text style={styles.failed}>Não foi possível carregar a imagem.</Text>}
        </View>
      </View>

      {chrome && (
        <>
          <View style={styles.top}>
            <Pressable style={styles.round} onPress={closeViewer} accessibilityLabel="Fechar" hitSlop={8}>
              <Icon name="x" color="#fff" />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={1}>
                {author || a.file_name}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {formatDay(item.createdAt)} · {formatTime(item.createdAt)}
                {items.length > 1 ? `  ·  ${index + 1} de ${items.length}` : ''}
              </Text>
            </View>
            <Pressable
              style={styles.round}
              onPress={() => void Share.share({ message: item.url, title: a.file_name })}
              accessibilityLabel="Compartilhar"
              hitSlop={8}
            >
              <Icon name="share" color="#fff" size={20} />
            </Pressable>
            <Pressable
              style={styles.round}
              onPress={() => void Linking.openURL(item.url)}
              accessibilityLabel="Abrir no navegador"
              hitSlop={8}
            >
              <Icon name="external" color="#fff" size={20} />
            </Pressable>
          </View>
          {items.length > 1 && (
            <View style={styles.dots} pointerEvents="none">
              {items.length <= 12 ? (
                items.map((it, i) => <View key={it.attachment.id} style={[styles.dot, i === index && styles.dotOn]} />)
              ) : (
                <Text style={styles.sub}>
                  {index + 1} / {items.length}
                </Text>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  black: { backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 36,
    paddingBottom: space.md,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  title: { color: '#fff', fontWeight: '700', fontSize: 15 },
  sub: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  failed: { color: '#fff', position: 'absolute' },
  dots: {
    position: 'absolute',
    bottom: 28,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.35)' },
  dotOn: { backgroundColor: '#fff', width: 18 },
});
