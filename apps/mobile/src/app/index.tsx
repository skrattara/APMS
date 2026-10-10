import type { Role } from "@apms/domain";
import { Redirect, useRouter, type Href } from "expo-router";
import { useState } from "react";
import {
  Image,
  ImageBackground,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppIcon } from "@/components/Icon";
import { colors } from "@/theme/tokens";
import { tracePerformanceEvent } from "@/services/performanceTrace";

const rememberedEmailKey = "apms.remembered.email";
function homePath(role: Role): Href {
  if (role === "faculty") return "/portal/faculty/overview";
  if (role === "academic_admin") return "/portal/academic_admin/overview";
  return "/portal/system_admin/overview";
}

export default function LoginPage() {
  const router = useRouter();
  const {
    user,
    loading,
    signIn,
    mfaFactorId,
    verifyMfa,
    signOut,
    signInWithGoogle,
    requestPasswordReset,
    configured,
    demoMode,
  } = useAuth();
  const [email, setEmail] = useState(
    () => globalThis.localStorage?.getItem(rememberedEmailKey) ?? "",
  );
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState("");
  const [remember, setRemember] = useState(() =>
    Boolean(globalThis.localStorage?.getItem(rememberedEmailKey)),
  );
  const submit = async () => {
    setError("");
    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    tracePerformanceEvent('login.submit');
    setSubmitting(true);
    const result = await signIn(email, password);
    setSubmitting(false);
    if (!result.ok) {
      tracePerformanceEvent('login.rejected', { mfaRequired: 'mfaRequired' in result });
      if ('mfaRequired' in result) return;
      setError(result.message);
      return;
    }
    if (remember)
      globalThis.localStorage?.setItem(
        rememberedEmailKey,
        email.trim().toLowerCase(),
      );
    else globalThis.localStorage?.removeItem(rememberedEmailKey);
    tracePerformanceEvent('login.authenticated', { role: result.user.role });
    router.replace(homePath(result.user.role));
  };
  const googleSignIn = async () => {
    setError("");
    setSubmitting(true);
    const result = await signInWithGoogle();
    setSubmitting(false);
    if (!result.ok) setError(result.message);
  };
  const submitMfa = async () => {
    setMfaError(""); setSubmitting(true);
    const result = await verifyMfa(mfaCode, mfaFactorId ?? undefined);
    setSubmitting(false);
    if (!result.ok) { tracePerformanceEvent('login.mfa.rejected'); setMfaError(result.message); return; }
    tracePerformanceEvent('login.mfa.authenticated');
    setMfaCode("");
  };
  if (loading)
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Loading APMS…</Text>
      </View>
    );
  if (user) return <Redirect href={homePath(user.role)} />;
  if (mfaFactorId) return (
    <View style={styles.challengePage}>
      <View style={styles.challengeCard}>
        <Image source={require("../../assets/apms/login-background.jpeg")} style={styles.logo} />
        <Text style={styles.challengeTitle}>Verify your identity</Text>
        <Text style={styles.challengeHelp}>Enter the six-digit code from your authenticator app to continue to APMS.</Text>
        <TextInput value={mfaCode} onChangeText={(value) => setMfaCode(value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" keyboardType="number-pad" maxLength={6} autoFocus style={styles.mfaInput} accessibilityLabel="MFA verification code" />
        {mfaError ? <Text accessibilityRole="alert" style={styles.error}>{mfaError}</Text> : null}
        <Pressable accessibilityRole="button" disabled={submitting || mfaCode.length !== 6} onPress={() => void submitMfa()} style={[styles.signIn, (submitting || mfaCode.length !== 6) && styles.disabled]}><Text style={styles.signInText}>{submitting ? "Verifying…" : "Verify code"}</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => void signOut()} style={styles.cancelMfa}><Text style={styles.forgot}>Cancel and sign out</Text></Pressable>
      </View>
    </View>
  );

  return (
    <ImageBackground
      source={require("../../assets/apms/login-optimized.jpg")}
      resizeMode="cover"
      fadeDuration={0}
      style={styles.page}
      imageStyle={styles.backgroundImage}
    >
      <View style={styles.tint} />
      <ScrollView
        contentContainerStyle={styles.center}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <View style={styles.header}>
            <Image
              source={require("../../assets/apms/login-background.jpeg")}
              style={styles.logo}
            />
            <Text style={styles.title}>APMS</Text>
            <View style={styles.captionRow}>
              <AppIcon name="assistant" size={13} color="#6A7282" />
              <Text style={styles.caption}>AI-Powered Student Evaluation</Text>
            </View>
          </View>
          <View style={styles.form}>
            <Text style={styles.label}>Email</Text>
            <View style={styles.inputShell}>
              <AppIcon name="email" size={16} color="#94A3B8" />
              <NativeInput
                value={email}
                onChangeText={setEmail}
                placeholder="Enter your email"
                secure={false}
              />
            </View>
            <Text style={styles.label}>Password</Text>
            <View style={styles.inputShell}>
              <AppIcon name="password" size={16} color="#94A3B8" />
              <NativeInput
                value={password}
                onChangeText={setPassword}
                placeholder="Enter your password"
                secure={!passwordVisible}
              />
              <Pressable
                accessibilityLabel={
                  passwordVisible ? "Hide password" : "Show password"
                }
                onPress={() => setPasswordVisible((value) => !value)}
                style={styles.eyeButton}
              >
                <AppIcon
                  name={passwordVisible ? "visibilityOff" : "visibility"}
                  size={17}
                  color="#94A3B8"
                />
              </Pressable>
            </View>
            <View style={styles.meta}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: remember }}
                onPress={() => setRemember((value) => !value)}
                style={styles.rememberRow}
              >
                <View
                  style={[styles.checkbox, remember && styles.checkboxChecked]}
                >
                  {remember ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
                <Text style={styles.remember}>Remember me</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void requestPasswordReset(email).then((result) =>
                    setError(result.message),
                  )
                }
              >
                <Text style={styles.forgot}>Forgot password?</Text>
              </Pressable>
            </View>
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={submitting}
              onPress={() => void submit()}
              style={({ pressed }) => [
                styles.signIn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              <Text style={styles.signInText}>
                {submitting ? "Signing In…" : "Sign In"}
              </Text>
            </Pressable>
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              disabled={submitting}
              onPress={() => void googleSignIn()}
              style={({ pressed }) => [
                styles.googleButton,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              <Text style={styles.googleText}>Continue with Google</Text>
            </Pressable>
          </View>
          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {demoMode ? "240+" : "Secure"}
              </Text>
              <Text style={styles.statLabel}>
                {demoMode ? "Students" : "Academic records"}
              </Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {demoMode ? "15+" : "Scoped"}
              </Text>
              <Text style={styles.statLabel}>
                {demoMode ? "Faculty" : "Role access"}
              </Text>
            </View>
          </View>
          {!configured && !demoMode ? (
            <Text style={styles.config}>
              Database connection required. Configure the variables in .env.
            </Text>
          ) : null}
          <Text style={styles.copyright}>
            © 2026 APMS. All rights reserved.
          </Text>
        </View>
      </ScrollView>
    </ImageBackground>
  );
}

function NativeInput({
  value,
  onChangeText,
  placeholder,
  secure,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secure: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      autoCapitalize="none"
      secureTextEntry={secure}
      placeholder={placeholder}
      placeholderTextColor="#717182"
      style={styles.input}
    />
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    minHeight: Platform.OS === "web" ? ("100vh" as never) : 826,
    backgroundColor: "#4A1E15",
  },
  backgroundImage: { width: "100%", height: "100%" },
  tint: { position: "absolute", inset: 0, backgroundColor: "#4A1E15B3" },
  center: {
    flexGrow: 1,
    minHeight: 826,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
  },
  card: {
    width: 384,
    minHeight: 564,
    maxWidth: "92%",
    backgroundColor: "#FFFFFFF2",
    borderWidth: 1,
    borderColor: "#FFFFFF33",
    borderRadius: 16,
    paddingHorizontal: 28,
    paddingTop: 28,
    paddingBottom: 18,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 25 },
    elevation: 12,
  },
  header: { height: 109, alignItems: "center" },
  logo: {
    width: 48,
    height: 48,
    borderRadius: 15,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  title: {
    color: "#101828",
    fontSize: 18,
    lineHeight: 28,
    fontWeight: "500",
    marginTop: 6,
  },
  captionRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  caption: { color: "#6A7282", fontSize: 11, lineHeight: 17 },
  form: { marginTop: 8 },
  label: {
    color: "#4A5565",
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    marginBottom: 6,
    marginTop: 10,
  },
  inputShell: {
    height: 36,
    borderRadius: 8,
    backgroundColor: "#F3F3F5",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
    height: 36,
    paddingVertical: 4,
    color: colors.text,
    fontSize: 14,
  },
  eyeButton: {
    width: 26,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  meta: {
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rememberRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  checkbox: {
    width: 14,
    height: 14,
    borderWidth: 1,
    borderColor: "#6A7282",
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkmark: { color: "#FFF", fontSize: 10, lineHeight: 12 },
  remember: { color: "#6A7282", fontSize: 11, fontWeight: "500" },
  forgot: { color: colors.brand, fontSize: 11 },
  error: { color: colors.danger, fontSize: 10, marginBottom: 5 },
  signIn: {
    height: 36,
    backgroundColor: colors.brand,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
  },
  signInText: {
    color: "#FFF",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "500",
  },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.55 },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginVertical: 8,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#E5E7EB" },
  dividerText: { color: "#99A1AF", fontSize: 10 },
  googleButton: {
    height: 36,
    borderWidth: 1,
    borderColor: "#D1D5DB",
    backgroundColor: "#FFF",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  googleText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  stats: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderColor: "#F3F4F6",
    flexDirection: "row",
  },
  stat: { flex: 1, alignItems: "center" },
  statValue: { color: colors.brand, fontSize: 18, lineHeight: 28 },
  statLabel: { color: "#99A1AF", fontSize: 10, lineHeight: 15 },
  config: {
    color: colors.warning,
    textAlign: "center",
    fontSize: 8,
    marginTop: 5,
  },
  copyright: {
    color: "#D1D5DC",
    textAlign: "center",
    fontSize: 10,
    lineHeight: 15,
    marginTop: 2,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.canvas,
  },
  loadingText: { color: colors.brand, fontWeight: "600" },
  challengePage: { flex: 1, minHeight: Platform.OS === "web" ? ("100vh" as never) : 826, alignItems: "center", justifyContent: "center", backgroundColor: colors.canvas, padding: 24 },
  challengeCard: { width: 384, maxWidth: "100%", backgroundColor: "#FFF", borderRadius: 16, padding: 28, alignItems: "center", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  challengeTitle: { color: "#101828", fontSize: 20, fontWeight: "700", marginTop: 16 },
  challengeHelp: { color: "#667085", fontSize: 13, lineHeight: 20, textAlign: "center", marginVertical: 12 },
  mfaInput: { width: "100%", height: 48, borderWidth: 1, borderColor: "#D0D5DD", borderRadius: 8, textAlign: "center", letterSpacing: 8, fontSize: 22, color: colors.text, marginBottom: 10 },
  cancelMfa: { padding: 14 },
});
