import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AuthProvider } from '@/auth/AuthProvider';
import { Button, PageState, ToastProvider } from '@/components/ui';
import { colors } from '@/theme/tokens';

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><ToastProvider><BrowserRuntimeGuard><AuthProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false, animation: 'fade' }} /></AuthProvider></BrowserRuntimeGuard></ToastProvider></GestureHandlerRootView>;
}

async function checkWebAssemblyRuntime() {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.instantiate !== 'function') return false;
  // A tiny module that exports answer() -> 42 verifies compilation and execution.
  const probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11]);
  try {
    const { instance } = await WebAssembly.instantiate(probe);
    const answer = (instance.exports as { answer?: () => number }).answer;
    return typeof answer === 'function' && answer() === 42;
  } catch {
    return false;
  }
}

function BrowserRuntimeGuard({ children }: { children: React.ReactNode }) {
  const [runtime, setRuntime] = useState<'checking' | 'supported' | 'unsupported'>(Platform.OS === 'web' ? 'checking' : 'supported');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let active = true;
    void checkWebAssemblyRuntime().then((supported) => {
      if (active) setRuntime(supported ? 'supported' : 'unsupported');
    });
    return () => { active = false; };
  }, [retry]);
  if (runtime === 'supported') return children;
  return <View style={styles.runtimeScreen}>
    <PageState
      kind={runtime === 'checking' ? 'loading' : 'error'}
      title={runtime === 'checking' ? 'Checking browser support' : 'Browser support required'}
      message={runtime === 'checking'
        ? 'Please wait while we check whether WebAssembly can run in this browser.'
        : 'APMS could not run WebAssembly in this browser. Enable JavaScript and WebAssembly (and JavaScript JIT, if your browser offers that setting) in the browser settings, then try again. You can also open APMS in a supported browser.'}
      action={runtime === 'unsupported' ? <Button label="Check again" variant="secondary" onPress={() => { setRuntime('checking'); setRetry((value) => value + 1); }} /> : undefined}
    />
  </View>;
}

const styles = StyleSheet.create({ runtimeScreen: { flex: 1, justifyContent: 'center', backgroundColor: colors.canvas } });
