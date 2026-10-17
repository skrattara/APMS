import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { RouteGuard } from '@/auth/RouteGuard';
import { isRole, NAVIGATION, ROLE_HOME } from '@/config/navigation';
import { AppPortalScreen } from '@/screens/AppPortalScreen';
import { RouteStatusScreen } from '@/components/RouteStatusScreen';
import { rememberPortalRoute } from '@/auth/routeMemory';

export default function RoleViewRoute() {
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ role?: string; view?: string }>();
  const view = typeof params.view === 'string' ? params.view : params.role && isRole(params.role) ? ROLE_HOME[params.role] : 'overview';
  useEffect(() => {
    if (user && user.role === params.role) rememberPortalRoute(params.role, view);
  }, [params.role, user, view]);
  if (!isRole(params.role)) return <RouteStatusScreen kind="not-found" onReturn={() => router.replace('/')} />;
  if (view === 'data-generator' && !__DEV__) return <RouteStatusScreen kind="not-found" onReturn={() => router.replace('/')} />;
  if (!NAVIGATION[params.role].some((item) => item.key === view)) return <RouteStatusScreen kind="not-found" onReturn={() => router.replace('/')} />;
  return <RouteGuard role={params.role}><AppPortalScreen role={params.role} screen={view} /></RouteGuard>;
}
