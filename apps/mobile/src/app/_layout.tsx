import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AuthProvider } from '@/auth/AuthProvider';
import { ToastProvider } from '@/components/ui';

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><ToastProvider><AuthProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false, animation: 'fade' }} /></AuthProvider></ToastProvider></GestureHandlerRootView>;
}
