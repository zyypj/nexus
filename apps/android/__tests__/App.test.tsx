import { applyFrame, initialState } from '@nexus/shared';

// The shared state logic is tested in packages/shared; this smoke test makes
// sure Metro/Jest resolve the linked workspace packages from the Android app.
test('shared store is importable from the Android app', () => {
  const s = initialState();
  expect(applyFrame(s, { t: 'TYPING_START', d: { conversation_id: 'c', user_id: 'u' } }).typing?.c?.u).toBeGreaterThan(0);
});
