import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { colors } from '@/theme/tokens';

export default function ResetPasswordPage() {
  const router = useRouter();
  const { loading, passwordRecovery, passwordRecoveryError, clearPasswordRecoveryError, requestPasswordReset, updatePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const submit = async () => {
    setError('');
    setNotice('');
    if (password.length < 12) {
      setError('Use at least 12 characters for your new password.');
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      const result = await updatePassword(password);
      if (result.ok) {
        setPassword('');
        setConfirmation('');
        setNotice(result.message);
      } else {
        setError(result.message);
      }
    } catch {
      setError('The password could not be updated. Request a new reset link and try again.');
    } finally {
      setSaving(false);
    }
  };

  const sendNewLink = async () => {
    setError('');
    setNotice('');
    setSending(true);
    try {
      const result = await requestPasswordReset(email);
      if (result.ok) setNotice(result.message);
      else setError(result.message);
    } catch {
      setError('The reset email could not be sent. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.page}>
      <View style={styles.card}>
        <Text style={styles.brand}>APMS</Text>
        <Text accessibilityRole="header" style={styles.title}>Reset your password</Text>
        {loading ? <Text style={styles.copy}>Verifying your reset link…</Text> : notice ? <>
          <Text accessibilityRole="alert" style={styles.success}>{notice}</Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.button}><Text style={styles.buttonText}>Continue to APMS</Text></Pressable>
        </> : passwordRecovery ? <>
          <Text style={styles.copy}>Choose a new password for your account. It must contain at least 12 characters.</Text>
          <Text style={styles.label}>New password</Text>
          <TextInput value={password} onChangeText={setPassword} autoCapitalize="none" autoComplete="new-password" secureTextEntry style={styles.input} accessibilityLabel="New password" />
          <Text style={styles.label}>Confirm new password</Text>
          <TextInput value={confirmation} onChangeText={setConfirmation} autoCapitalize="none" autoComplete="new-password" secureTextEntry style={styles.input} accessibilityLabel="Confirm new password" />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Pressable accessibilityRole="button" disabled={saving} onPress={() => void submit()} style={[styles.button, saving && styles.disabled]}><Text style={styles.buttonText}>{saving ? 'Updating…' : 'Update password'}</Text></Pressable>
        </> : <>
          <Text style={styles.copy}>{passwordRecoveryError ?? 'This reset link is invalid or has expired.'} Enter your email address and we’ll send you a new link.</Text>
          <Text style={styles.label}>Account email</Text>
          <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" style={styles.input} accessibilityLabel="Account email" />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {notice ? <Text accessibilityRole="alert" style={styles.success}>{notice}</Text> : null}
          {!notice ? <Pressable accessibilityRole="button" disabled={sending} onPress={() => void sendNewLink()} style={[styles.button, sending && styles.disabled]}><Text style={styles.buttonText}>{sending ? 'Sending…' : 'Send a new reset link'}</Text></Pressable> : null}
          <Pressable accessibilityRole="button" onPress={() => { clearPasswordRecoveryError(); router.replace('/'); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Return to sign in</Text></Pressable>
        </>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: Platform.OS === 'web' ? ('100vh' as never) : 700, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: '#F5F5F7' },
  card: { width: 420, maxWidth: '100%', gap: 12, padding: 28, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  brand: { color: colors.brand, fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  copy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  label: { color: colors.text, fontSize: 12, fontWeight: '600', marginTop: 4 },
  input: { height: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surfaceMuted, color: colors.text, fontSize: 14 },
  error: { color: colors.danger, fontSize: 12, lineHeight: 18 },
  success: { color: colors.success, fontSize: 12, lineHeight: 18 },
  button: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.brand },
  buttonText: { color: '#FFF', fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.6 },
  secondaryButton: { minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { color: colors.brand, fontSize: 13, fontWeight: '600' },
});
