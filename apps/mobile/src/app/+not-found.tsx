import { useRouter } from "expo-router";

import { RouteStatusScreen } from "@/components/RouteStatusScreen";

export default function NotFoundRoute() {
  const router = useRouter();
  return <RouteStatusScreen kind="not-found" onReturn={() => router.replace("/")} />;
}
