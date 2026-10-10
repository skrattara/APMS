import type { ReactNode } from "react";
import { Redirect } from "expo-router";
import { StyleSheet, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { Button, PageState } from "@/components/ui";
import { colors } from "@/theme/tokens";

export function RouteStatusScreen({
  kind,
  onReturn,
}: {
  kind: "not-found" | "forbidden";
  onReturn: () => void;
}) {
  const { user, loading } = useAuth();
  const forbidden = kind === "forbidden";
  const action: ReactNode = (
    <Button
      label={forbidden ? "Return to my dashboard" : "Go to home"}
      icon="home"
      onPress={onReturn}
    />
  );

  return (
    <View style={styles.screen}>
      {loading ? (
        <PageState kind="loading" title="Checking access" message="Please wait while we verify your session." />
      ) : !user ? (
        <Redirect href="/" />
      ) : (
      <PageState
        kind={forbidden ? "denied" : "error"}
        title={forbidden ? "Access denied" : "Page not found"}
        message={forbidden
          ? "You don’t have permission to view this page. Return to your dashboard to continue."
          : "We couldn’t find that page. Check the address or return to the home screen."}
        action={action}
      />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", backgroundColor: colors.canvas },
});
