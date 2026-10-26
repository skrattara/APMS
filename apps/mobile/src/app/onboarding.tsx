import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { useAuth, type MfaEnrollment } from '@/auth/AuthProvider';
import { colors } from '@/theme/tokens';

const steps = ['Confirm email', 'Set password', 'Two-step verification', 'Takeover email'];

export default function OnboardingPage() {
  const router = useRouter();
  const { user, loading, authError, mfaEnabled, mfaRequired, enrollMfa, verifyMfa, setOnboardingPassword, completeOnboarding, signOut } = useAuth();
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [takeoverEmail, setTakeoverEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const needsTakeoverEmail = user?.role === 'academic_admin';
  const visibleSteps = needsTakeoverEmail ? steps : steps.slice(0, 3);
  const passwordRules = [
    { label: 'At least 12 characters', met: password.length >= 12, required: true },
    { label: 'Upper and lowercase letters', met: /[a-z]/.test(password) && /[A-Z]/.test(password), required: false },
    { label: 'A number', met: /\d/.test(password), required: false },
    { label: 'A symbol', met: /[^A-Za-z0-9]/.test(password), required: false },
  ];
  const passwordStrengthScore = passwordRules.filter((rule) => rule.met).length;
  const passwordStrength = !password ? 'Not entered' : password.length < 12 ? 'Too short' : passwordStrengthScore <= 1 ? 'Fair' : passwordStrengthScore === 2 ? 'Good' : 'Strong';
  const passwordStrengthColor = !password ? colors.textMuted : password.length < 12 ? colors.danger : passwordStrengthScore <= 1 ? colors.warning : passwordStrengthScore === 2 ? colors.info : colors.success;

  if (loading) return <View style={styles.loading}><ActivityIndicator color={colors.brand} size="large" /><Text style={styles.muted}>Checking your invitation…</Text></View>;
  if (!user) return (
    <View style={styles.page}><View style={styles.card}>
      <Text style={styles.brand}>APMS</Text><Text accessibilityRole="header" style={styles.title}>Invitation link needed</Text>
      <Text style={styles.copy}>{authError ?? 'Open the onboarding link from your APMS invitation email. Invitation links can only be used once and may expire.'}</Text>
      <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.secondaryButton}><Text style={styles.secondaryText}>Return to sign in</Text></Pressable>
    </View></View>
  );
  if (user.onboardingComplete) return <Redirect href={user.role === 'faculty' ? '/portal/faculty/overview' : user.role === 'academic_admin' ? '/portal/academic_admin/overview' : '/portal/system_admin/overview'} />;

  const startMfa = async () => {
    setError(''); setNotice(''); setBusy(true);
    const result = await enrollMfa();
    setBusy(false);
    if (result.ok) setEnrollment(result.enrollment); else setError(result.message);
  };

  const savePassword = async () => {
    setError(''); setNotice('');
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setBusy(true);
    const result = await setOnboardingPassword(password);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setPassword(''); setConfirmation(''); setNotice('Password saved.'); setStep(2);
  };

  const verifyAuthenticator = async () => {
    if (!enrollment) return;
    setError(''); setBusy(true);
    const result = await verifyMfa(code, enrollment.factorId);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setEnrollment(null); setCode(''); setNotice('Authenticator app verified.');
  };

  const finish = async () => {
    setError(''); setNotice(''); setBusy(true);
    const result = await completeOnboarding(needsTakeoverEmail ? takeoverEmail : undefined);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    router.replace(user.role === 'faculty' ? '/portal/faculty/overview' : user.role === 'academic_admin' ? '/portal/academic_admin/overview' : '/portal/system_admin/overview');
  };

  const canContinue = step === 0 ? user.emailConfirmed : step === 2 ? mfaEnabled || !mfaRequired : step === 3 ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(takeoverEmail.trim()) : false;

  return <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <View style={styles.card}>
      <Text style={styles.brand}>APMS ACCOUNT SETUP</Text>
      <Text accessibilityRole="header" style={styles.title}>Welcome, {user.firstName}</Text>
      <Text style={styles.copy}>Complete these steps to secure your account and access APMS. Signed in as {user.email}.</Text>
      <View style={styles.progress} accessibilityRole="progressbar" accessibilityValue={{ now: step + 1, min: 1, max: visibleSteps.length }}>
        {visibleSteps.map((label, index) => <View key={label} style={styles.progressItem}><View style={[styles.progressDot, index <= step && styles.progressDotActive]}><Text style={[styles.progressNumber, index <= step && styles.progressNumberActive]}>{index + 1}</Text></View><Text style={[styles.progressLabel, index === step && styles.progressLabelActive]}>{label}</Text></View>)}
      </View>

      {step === 0 ? <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>Confirm your email</Text>
        {user.emailConfirmed ? <View style={styles.confirmed}><Text style={styles.confirmedIcon}>✓</Text><View style={{ flex: 1 }}><Text style={styles.confirmedTitle}>Email confirmed</Text><Text style={styles.copy}>{user.email} was verified through your invitation link.</Text></View></View> : <Text style={styles.copy}>Open the verification link in your APMS invitation email, then return here. Refresh this page after confirming.</Text>}
      </View> : null}

      {step === 1 ? <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>Set your password</Text><Text style={styles.copy}>Choose a password with at least 12 characters.</Text>
        <Text style={styles.label}>New password</Text><TextInput value={password} onChangeText={setPassword} autoCapitalize="none" autoComplete="new-password" secureTextEntry style={styles.input} accessibilityLabel="New password" />
        <Text style={styles.label}>Confirm password</Text><TextInput value={confirmation} onChangeText={setConfirmation} autoCapitalize="none" autoComplete="new-password" secureTextEntry style={styles.input} accessibilityLabel="Confirm password" />
        <View style={styles.passwordStrength} accessibilityLabel={`Password strength: ${passwordStrength}`}>
          <View style={styles.passwordStrengthHeader}><Text style={styles.passwordStrengthTitle}>Password strength</Text><Text style={[styles.passwordStrengthValue, { color: passwordStrengthColor }]}>{passwordStrength}</Text></View>
          <View style={styles.passwordStrengthMeter}>{passwordRules.map((rule, index) => <View key={rule.label} style={[styles.passwordStrengthSegment, index < passwordStrengthScore && { backgroundColor: passwordStrengthColor }]} />)}</View>
          <View style={styles.passwordRules}>{passwordRules.map((rule) => <View key={rule.label} style={styles.passwordRule}><Text style={[styles.passwordRuleMark, rule.met && styles.passwordRuleMarkMet]}>{rule.met ? '✓' : '○'}</Text><Text style={styles.passwordRuleText}>{rule.label}{rule.required ? ' · required' : ''}</Text></View>)}</View>
        </View>
      </View> : null}

      {step === 2 ? <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>Configure two-step verification</Text><Text style={styles.copy}>{mfaRequired ? 'Your organization requires an authenticator app. Verify it now to finish account setup.' : 'Use an authenticator app for an extra layer of sign-in security. You can skip this step because it is not currently required for your account.'}</Text>
        {enrollment ? <>
          <View style={styles.qrCode} accessibilityLabel="Authenticator setup QR code"><QRCode value={enrollment.uri} size={180} quietZone={10} backgroundColor="#FFFFFF" color="#101828" ecl="M" /></View>
          <Text style={styles.copy}>If you cannot scan the code, enter this setup key manually:</Text><Text selectable style={styles.secret}>{enrollment.secret}</Text>
          <Text style={styles.label}>Six-digit code</Text><TextInput value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} style={[styles.input, styles.codeInput]} accessibilityLabel="Six-digit authenticator code" />
          <Pressable accessibilityRole="button" disabled={busy || code.length !== 6} onPress={() => void verifyAuthenticator()} style={[styles.button, (busy || code.length !== 6) && styles.disabled]}><Text style={styles.buttonText}>{busy ? 'Verifying…' : 'Verify authenticator'}</Text></Pressable>
        </> : mfaEnabled ? <View style={styles.confirmed}><Text style={styles.confirmedIcon}>✓</Text><View style={{ flex: 1 }}><Text style={styles.confirmedTitle}>Authenticator enabled</Text><Text style={styles.copy}>Your account will ask for an authenticator code when you sign in.</Text></View></View> : <Pressable accessibilityRole="button" disabled={busy} onPress={() => void startMfa()} style={[styles.button, busy && styles.disabled]}><Text style={styles.buttonText}>{busy ? 'Preparing…' : 'Set up authenticator app'}</Text></Pressable>}
      </View> : null}

      {step === 3 ? <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>Add a department takeover email</Text><Text style={styles.copy}>This alternate address will be used to invite the next Academic Admin if your department needs an account handover. Use an address different from your APMS sign-in email.</Text>
        <Text style={styles.label}>Takeover email</Text><TextInput value={takeoverEmail} onChangeText={setTakeoverEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" style={styles.input} accessibilityLabel="Department takeover email" />
      </View> : null}

      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <View style={styles.actions}>
        {step > 0 ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setError(''); setNotice(''); setStep((value) => value - 1); }} style={styles.secondaryButton}><Text style={styles.secondaryText}>Back</Text></Pressable> : null}
        {step < 1 ? <Pressable accessibilityRole="button" disabled={!canContinue} onPress={() => { setError(''); setStep(1); }} style={[styles.button, !canContinue && styles.disabled]}><Text style={styles.buttonText}>Continue</Text></Pressable> : null}
        {step === 1 ? <Pressable accessibilityRole="button" disabled={busy || password.length < 12 || !confirmation} onPress={() => void savePassword()} style={[styles.button, (busy || password.length < 12 || !confirmation) && styles.disabled]}><Text style={styles.buttonText}>{busy ? 'Saving…' : 'Save password'}</Text></Pressable> : null}
        {step === 2 && (mfaEnabled || !mfaRequired) ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => needsTakeoverEmail ? setStep(3) : void finish()} style={[styles.button, busy && styles.disabled]}><Text style={styles.buttonText}>{needsTakeoverEmail ? (mfaEnabled ? 'Continue' : 'Skip for now') : busy ? 'Finishing…' : mfaEnabled ? 'Finish setup' : 'Skip and finish setup'}</Text></Pressable> : null}
        {step === 3 ? <Pressable accessibilityRole="button" disabled={busy || !canContinue} onPress={() => void finish()} style={[styles.button, (busy || !canContinue) && styles.disabled]}><Text style={styles.buttonText}>{busy ? 'Finishing…' : 'Finish setup'}</Text></Pressable> : null}
      </View>
      <Pressable accessibilityRole="button" onPress={() => void signOut()} style={styles.signOut}><Text style={styles.secondaryText}>Sign out</Text></Pressable>
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, minHeight: Platform.OS === 'web' ? ('100vh' as never) : 700, justifyContent: 'center', alignItems: 'center', padding: 16, backgroundColor: colors.canvas },
  loading: { flex: 1, gap: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.canvas },
  card: { width: 640, maxWidth: '100%', gap: 11, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  brand: { color: colors.brand, fontSize: 12, fontWeight: '800', letterSpacing: 1.1 }, title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  copy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 }, muted: { color: colors.textMuted, fontSize: 13 },
  progress: { flexDirection: 'row', gap: 6, marginVertical: 4 }, progressItem: { flex: 1, alignItems: 'center', gap: 5 },
  progressDot: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border }, progressDotActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  progressNumber: { color: colors.textMuted, fontSize: 12, fontWeight: '700' }, progressNumberActive: { color: colors.surface }, progressLabel: { textAlign: 'center', color: colors.textMuted, fontSize: 10 }, progressLabelActive: { color: colors.brand, fontWeight: '700' },
  stepContent: { gap: 8, padding: 14, borderRadius: 10, backgroundColor: colors.surfaceMuted }, stepTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  passwordStrength: { gap: 6, marginTop: 2 }, passwordStrengthHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, passwordStrengthTitle: { color: colors.textMuted, fontSize: 11, fontWeight: '600' }, passwordStrengthValue: { fontSize: 11, fontWeight: '700' }, passwordStrengthMeter: { flexDirection: 'row', gap: 5 }, passwordStrengthSegment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border }, passwordRules: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4 }, passwordRule: { flexDirection: 'row', alignItems: 'center', gap: 4 }, passwordRuleMark: { color: colors.textMuted, fontSize: 11, fontWeight: '700' }, passwordRuleMarkMet: { color: colors.success }, passwordRuleText: { color: colors.textMuted, fontSize: 10 },
  confirmed: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 9, borderWidth: 1, borderColor: '#B7E4D3', backgroundColor: '#EFFAF5' }, confirmedIcon: { color: colors.success, fontSize: 22, fontWeight: '800' }, confirmedTitle: { color: colors.text, fontWeight: '700', marginBottom: 3 },
  label: { color: colors.text, fontSize: 12, fontWeight: '600', marginTop: 4 }, input: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, color: colors.text, fontSize: 14 }, codeInput: { width: 180, alignSelf: 'center', textAlign: 'center', letterSpacing: 5, fontSize: 20 },
  qrCode: { width: 200, height: 200, alignSelf: 'center', justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 8 }, secret: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 1, textAlign: 'center' },
  error: { color: colors.danger, fontSize: 12, lineHeight: 18 }, notice: { color: colors.success, fontSize: 12 }, actions: { flexDirection: 'row', gap: 10 },
  button: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.brand }, buttonText: { color: '#FFF', fontSize: 13, fontWeight: '700' }, disabled: { opacity: 0.5 },
  secondaryButton: { minHeight: 44, minWidth: 110, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, secondaryText: { color: colors.brand, fontSize: 13, fontWeight: '600' }, signOut: { alignSelf: 'center', padding: 8 },
});
