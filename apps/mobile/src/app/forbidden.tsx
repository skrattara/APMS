import { useRouter } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import { RouteStatusScreen } from "@/components/RouteStatusScreen";

export default function ForbiddenRoute() {
  const router = useRouter();
  const { user } = useAuth();
  return (
    <RouteStatusScreen
      kind="forbidden"
      onReturn={() => router.replace(user ? `/portal/${user.role}/overview` : "/")}
    />
  );
}
