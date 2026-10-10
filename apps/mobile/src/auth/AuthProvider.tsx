import type { Role } from '@apms/domain';
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { DEMO_USERS, type DemoUser } from '@/data/demo';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import { getErrorMessage } from '@/services/errors';
import { captureDatabasePlan, tracePerformanceSpan } from '@/services/performanceTrace';

export type AuthUser = { id: string; email: string; firstName: string; lastName: string; role: Role };
type AuthResult = { ok: true; user: AuthUser } | { ok: false; message: string } | { ok: false; mfaRequired: true; factorId: string };
export type MfaEnrollment = { factorId: string; qrCode: string; secret: string };
type AuthContextValue = {
  user: AuthUser | null; loading: boolean; configured: boolean; demoMode: boolean;
  signIn(email: string, password: string): Promise<AuthResult>;
  mfaFactorId: string | null;
  mfaEnabled: boolean;
  enrollMfa(): Promise<{ ok: true; enrollment: MfaEnrollment } | { ok: false; message: string }>;
  verifyMfa(code: string, factorId?: string): Promise<{ ok: boolean; message: string }>;
  disableMfa(): Promise<{ ok: boolean; message: string }>;
  signInWithGoogle(): Promise<{ ok: boolean; message: string }>;
  requestPasswordReset(email: string): Promise<{ ok: boolean; message: string }>;
  signOut(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const demoMode = process.env.EXPO_PUBLIC_DEMO_MODE === 'true';
const demoSessionKey = 'apms.demo.session';

type SessionResolution = { user: AuthUser | null; factorId: string | null; mfaEnabled: boolean };
const sessionResolutions = new Map<string, Promise<SessionResolution>>();

async function loadSupabaseUser(session: Session): Promise<AuthUser | null> {
  if (!supabase) return null;
  captureDatabasePlan('auth.profile', () => supabase!.from('profiles')
    .select('id,email,first_name,last_name,status,user_roles!user_roles_user_id_fkey!inner(roles!inner(key))')
    .eq('id', session.user.id)
    .single());
  const { data, error } = await tracePerformanceSpan<any>('auth.profile.load', () => supabase!
    .from('profiles')
    .select('id,email,first_name,last_name,status,user_roles!user_roles_user_id_fkey!inner(roles!inner(key))')
    .eq('id', session.user.id)
    .single());
  if (error || !data || data.status !== 'active') return null;
  const nested = data.user_roles as unknown as { roles: { key: Role } }[];
  const role = nested[0]?.roles?.key;
  return role ? { id: data.id, email: data.email, firstName: data.first_name, lastName: data.last_name, role } : null;
}

function resolveSupabaseSession(session: Session): Promise<SessionResolution> {
  const cached = sessionResolutions.get(session.access_token);
  if (cached) return cached;

  const resolution = tracePerformanceSpan('auth.session.resolve', async (): Promise<SessionResolution> => {
    if (!supabase) return { user: null, factorId: null, mfaEnabled: false };
    const [assuranceResult, factorsResult] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);
    const factor = factorsResult.data?.totp.find((candidate) => candidate.status === 'verified');
    const needsMfa = assuranceResult.data?.nextLevel === 'aal2'
      && assuranceResult.data.currentLevel !== 'aal2'
      && Boolean(factor);
    return {
      user: needsMfa ? null : await loadSupabaseUser(session),
      factorId: needsMfa ? factor!.id : null,
      mfaEnabled: Boolean(factor),
    };
  });

  sessionResolutions.set(session.access_token, resolution);
  // Auth emits a session event as sign-in/getSession resolves. Share only an
  // in-flight lookup; later auth events must re-read current profile and MFA state.
  void resolution.then(
    () => { if (sessionResolutions.get(session.access_token) === resolution) sessionResolutions.delete(session.access_token); },
    () => sessionResolutions.delete(session.access_token),
  );
  return resolution;
}

function fromDemo(user: DemoUser): AuthUser {
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role };
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let authEventSeen = false;
    let sessionRevision = 0;
    if (demoMode) {
      const savedId = globalThis.localStorage?.getItem(demoSessionKey);
      const saved = DEMO_USERS.find((candidate) => candidate.id === savedId);
      if (saved) setUser(fromDemo(saved));
      setLoading(false);
      return () => { active = false; };
    }
    if (!supabase) { setLoading(false); return () => { active = false; }; }
    const client = supabase;
    const applySession = async (session: Session | null) => {
      const revision = ++sessionRevision;
      if (!session) {
        setUser(null);
        setMfaFactorId(null);
        setMfaEnabled(false);
        return;
      }
      const resolution = await resolveSupabaseSession(session);
      if (!active || revision !== sessionRevision) return;
      setMfaEnabled(resolution.mfaEnabled);
      setMfaFactorId(resolution.factorId);
      setUser(resolution.user);
    };
    client.auth.getSession().then(async ({ data }) => {
      // onAuthStateChange can deliver a newer session while getSession is in
      // flight. In that case, let the event own the state update.
      if (active && !authEventSeen) await applySession(data.session);
      if (active) setLoading(false);
    }).catch(() => { if (active) setLoading(false); });
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      authEventSeen = true;
      void (async () => {
        if (!active) return;
        try {
          await applySession(session);
        } catch {
          if (active) {
            setUser(null);
            setMfaFactorId(null);
            setMfaEnabled(false);
          }
        } finally {
          if (active) setLoading(false);
        }
      })();
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const normalized = email.trim().toLowerCase();
    if (demoMode) {
      const found = DEMO_USERS.find((candidate) => candidate.email === normalized && candidate.password === password);
      if (!found) return { ok: false, message: 'The email or password is incorrect.' };
      const next = fromDemo(found); globalThis.localStorage?.setItem(demoSessionKey, found.id); setUser(next); return { ok: true, user: next };
    }
    if (!supabase) return { ok: false, message: 'APMS is not connected. Configure the Supabase variables in .env.' };
    const { data, error } = await tracePerformanceSpan('auth.password.sign-in', () => supabase!.auth.signInWithPassword({ email: normalized, password }));
    if (error || !data.session) return { ok: false, message: 'The email or password is incorrect.' };
    const resolution = await resolveSupabaseSession(data.session);
    setMfaEnabled(resolution.mfaEnabled);
    if (resolution.factorId) {
      setMfaFactorId(resolution.factorId);
      return { ok: false, mfaRequired: true, factorId: resolution.factorId };
    }
    const next = resolution.user;
    if (!next) {
      await supabase.auth.signOut();
      return { ok: false, message: 'This account is inactive or has no assigned APMS role.' };
    }
    setUser(next); return { ok: true, user: next };
  }, []);

  const verifyMfa = useCallback(async (code: string, factorId = mfaFactorId ?? undefined) => {
    if (!supabase || !factorId) return { ok: false, message: 'No MFA challenge is active.' };
    if (!/^\d{6}$/.test(code.trim())) return { ok: false, message: 'Enter the six-digit code from your authenticator app.' };
    const { data: challenge, error: challengeError } = await tracePerformanceSpan<any>('auth.mfa.challenge', () => supabase!.auth.mfa.challenge({ factorId }));
    if (challengeError || !challenge) return { ok: false, message: 'The MFA challenge could not be started. Try again.' };
    const { error } = await tracePerformanceSpan<any>('auth.mfa.verify', () => supabase!.auth.mfa.verify({ factorId, challengeId: challenge.id, code: code.trim() }));
    if (error) return { ok: false, message: 'That MFA code is invalid or expired.' };
    const { data: sessionData } = await supabase.auth.getSession();
    const next = sessionData.session ? await loadSupabaseUser(sessionData.session) : null;
    if (!next) return { ok: false, message: 'Your account is inactive or has no assigned APMS role.' };
    setMfaFactorId(null); setUser(next);
    setMfaEnabled(true);
    return { ok: true, message: 'MFA verified.' };
  }, [mfaFactorId]);

  const enrollMfa = useCallback(async () => {
    if (demoMode) return { ok: false as const, message: 'MFA is unavailable for development-only accounts.' };
    if (!supabase) return { ok: false as const, message: 'APMS is not connected.' };
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) return { ok: false as const, message: getErrorMessage(factorsError, 'MFA setup could not be started. Try again.') };
    if (factors?.totp.some((factor) => factor.status === 'verified')) return { ok: false as const, message: 'MFA is already enabled for this account.' };
    const friendlyName = `APMS authenticator ${Date.now()}`;
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
    if (error || !data?.id || !data.totp) {
      return { ok: false as const, message: getErrorMessage(error, 'MFA setup could not be started. Try again.') };
    }
    return { ok: true as const, enrollment: { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret } };
  }, []);

  const disableMfa = useCallback(async () => {
    if (!supabase) return { ok: false, message: 'APMS is not connected.' };
    const { data: factors, error } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp.find((candidate) => candidate.status === 'verified');
    if (error || !factor) return { ok: false, message: 'No active MFA factor was found.' };
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (!unenrollError) setMfaEnabled(false);
    return unenrollError ? { ok: false, message: 'MFA could not be disabled.' } : { ok: true, message: 'MFA has been disabled for this account.' };
  }, []);

  const signOut = useCallback(async () => { if (supabase) await supabase.auth.signOut(); if (demoMode) globalThis.localStorage?.removeItem(demoSessionKey); setUser(null); setMfaFactorId(null); }, []);
  const requestPasswordReset = useCallback(async (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !/^\S+@\S+\.\S+$/.test(normalized)) return { ok: false, message: 'Enter a valid institutional email address first.' };
    if (demoMode) return { ok: false, message: 'Password reset is unavailable for development-only accounts.' };
    if (!supabase) return { ok: false, message: 'APMS is not connected. No reset email was sent.' };
    const redirectTo = typeof globalThis.location === 'undefined' ? undefined : `${globalThis.location.origin}/`;
    const { error } = await supabase.auth.resetPasswordForEmail(normalized, { redirectTo });
    if (error) return { ok: false, message: 'A reset email could not be sent. Try again or contact the system operator.' };
    return { ok: true, message: 'If the account exists, password reset instructions have been sent.' };
  }, []);
  const signInWithGoogle = useCallback(async () => {
    if (demoMode) return { ok: false, message: 'Google sign-in is unavailable for development-only accounts.' };
    if (!supabase) return { ok: false, message: 'APMS is not connected. Google sign-in could not start.' };
    const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined' ? `${globalThis.location.origin}/` : Linking.createURL('/');
    const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: Platform.OS !== 'web' } });
    if (error) return { ok: false, message: 'Google sign-in could not start.' };
    if (Platform.OS !== 'web' && data.url) {
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== 'success') return { ok: false, message: 'Google sign-in was cancelled.' };
      const code = Linking.parse(result.url).queryParams?.code;
      if (typeof code !== 'string') return { ok: false, message: 'Google did not return a valid authorization code.' };
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) return { ok: false, message: 'Google sign-in could not be completed.' };
    }
    return { ok: true, message: 'Continue in the Google sign-in window.' };
  }, []);
  const value = useMemo(() => ({ user, loading, configured: isSupabaseConfigured, demoMode, signIn, mfaFactorId, mfaEnabled, enrollMfa, verifyMfa, disableMfa, signInWithGoogle, requestPasswordReset, signOut }), [user, loading, signIn, mfaFactorId, mfaEnabled, enrollMfa, verifyMfa, disableMfa, signInWithGoogle, requestPasswordReset, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
