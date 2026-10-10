import { useLocalSearchParams, useRouter } from 'expo-router';

import { RouteGuard } from '@/auth/RouteGuard';
import { isRole, NAVIGATION, ROLE_HOME } from '@/config/navigation';
import { AppPortalScreen } from '@/screens/AppPortalScreen';
import { RouteStatusScreen } from '@/components/RouteStatusScreen';

export default function RoleViewRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ role?: string; view?: string }>();
  if (!isRole(params.role)) return <RouteStatusScreen kind="not-found" onReturn={() => router.replace('/')} />;
  const view = typeof params.view === 'string' ? params.view : ROLE_HOME[params.role];
  if (view === 'data-generator' && !__DEV__) return <RouteStatusScreen kind="not-found" onReturn={() => router.replace('/')} />;
  if (!NAVIGATION[params.role].some((item) => item.key === view)) return <RouteStatusScreen kind="not-found" onReturn={() => router.replace('/')} />;
  return <RouteGuard role={params.role}><AppPortalScreen role={params.role} screen={view} /></RouteGuard>;
}
