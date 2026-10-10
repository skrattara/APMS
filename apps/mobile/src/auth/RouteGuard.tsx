import type { Role } from '@apms/domain';
import { Redirect, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { PropsWithChildren } from 'react';

import { useAuth } from './AuthProvider';
import { RouteStatusScreen } from '@/components/RouteStatusScreen';
import { colors } from '@/theme/tokens';

export function RouteGuard({ role, children }: PropsWithChildren<{ role: Role }>) {
  const router = useRouter();
  const { user, loading } = useAuth();
  if (loading) return <View style={styles.loading}><ActivityIndicator color={colors.brand} size="large" /></View>;
  if (!user) return <Redirect href="/" />;
  if (user.role !== role) return <RouteStatusScreen kind="forbidden" onReturn={() => router.replace(`/portal/${user.role}/overview`)} />;
  return children;
}

const styles = StyleSheet.create({ loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas } });
