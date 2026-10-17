import type { Role } from '@apms/domain';

import { NAVIGATION } from '@/config/navigation';

const lastPortalRouteKey = 'apms.last-portal-route';

type RememberedPortalRoute = { role: Role; view: string };

export function rememberPortalRoute(role: string | undefined, view: string) {
  if (!role || !Object.prototype.hasOwnProperty.call(NAVIGATION, role)) return;
  const typedRole = role as Role;
  if (!NAVIGATION[typedRole].some((item) => item.key === view)) return;

  try {
    globalThis.localStorage?.setItem(lastPortalRouteKey, JSON.stringify({ role: typedRole, view }));
  } catch {
    // Route memory is a convenience; storage can be unavailable in private mode.
  }
}

export function getRememberedPortalPath(role: Role): `/portal/${Role}/${string}` | null {
  try {
    const saved = globalThis.localStorage?.getItem(lastPortalRouteKey);
    if (!saved) return null;
    const route = JSON.parse(saved) as Partial<RememberedPortalRoute>;
    if (route.role !== role || typeof route.view !== 'string') return null;
    if (!NAVIGATION[role].some((item) => item.key === route.view)) return null;
    return `/portal/${role}/${route.view}`;
  } catch {
    return null;
  }
}

export function clearRememberedPortalRoute() {
  try {
    globalThis.localStorage?.removeItem(lastPortalRouteKey);
  } catch {
    // Ignore unavailable storage during sign-out.
  }
}
