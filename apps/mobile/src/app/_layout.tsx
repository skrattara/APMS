import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AuthProvider } from '@/auth/AuthProvider';
import { ToastProvider } from '@/components/ui';

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><AuthProvider><ToastProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false, animation: 'fade' }} /></ToastProvider></AuthProvider></GestureHandlerRootView>;
}
