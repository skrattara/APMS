import type { Role } from '@apms/domain';
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { DEMO_USERS, type DemoUser } from '@/data/demo';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import { getErrorMessage } from '@/services/errors';
import { clearRememberedPortalRoute } from '@/auth/routeMemory';

export type AuthUser = { id: string; email: string; firstName: string; lastName: string; role: Role; emailConfirmed: boolean; onboardingComplete: boolean };
type AuthResult = { ok: true; user: AuthUser } | { ok: false; message: string } | { ok: false; mfaRequired: true; factorId: string } | { ok: false; mfaSetupRequired: true };
export type MfaEnrollment = { factorId: string; uri: string; secret: string };
type AuthContextValue = {
  user: AuthUser | null; loading: boolean; configured: boolean; demoMode: boolean;
  authError: string | null;
  clearAuthError(): void;
  passwordRecovery: boolean;
  passwordRecoveryError: string | null;
  clearPasswordRecoveryError(): void;
  updatePassword(newPassword: string): Promise<{ ok: boolean; message: string }>;
  setOnboardingPassword(newPassword: string): Promise<{ ok: boolean; message: string }>;
  completeOnboarding(takeoverEmail?: string): Promise<{ ok: boolean; message: string }>;
  signIn(email: string, password: string): Promise<AuthResult>;
  mfaFactorId: string | null;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  mfaSetupRequired: boolean;
  enrollMfa(): Promise<{ ok: true; enrollment: MfaEnrollment } | { ok: false; message: string }>;
  beginMfaReconfiguration(): Promise<{ ok: true; enrollment: MfaEnrollment; oldFactorId: string } | { ok: false; message: string; verifyFactorId?: string }>;
  removeReplacedMfaFactor(factorId: string): Promise<{ ok: boolean; message: string }>;
  cancelMfaEnrollment(factorId: string): Promise<void>;
  verifyMfa(code: string, factorId?: string): Promise<{ ok: boolean; message: string }>;
  disableMfa(): Promise<{ ok: boolean; message: string }>;
  signInWithGoogle(): Promise<{ ok: boolean; message: string }>;
  requestPasswordReset(email: string): Promise<{ ok: boolean; message: string }>;
  signOut(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const demoMode = process.env.EXPO_PUBLIC_DEMO_MODE === 'true';
const demoSessionKey = 'apms.demo.session';

type SessionResolution = { user: AuthUser | null; factorId: string | null; mfaEnabled: boolean; mfaRequired: boolean; mfaSetupRequired: boolean };
const sessionResolutions = new Map<string, Promise<SessionResolution>>();

function recoveryLinkErrorFromCurrentUrl(): string | null {
  if (Platform.OS !== 'web' || typeof globalThis.location === 'undefined') return null;
  const hash = globalThis.location.hash;
  if (!hash.startsWith('#')) return null;
  return new URLSearchParams(hash.slice(1)).get('error_code') === 'otp_expired'
    ? 'This password reset link has expired or has already been used.'
    : null;
}

function authCallbackErrorFromCurrentUrl(): string | null {
  if (Platform.OS !== 'web' || typeof globalThis.location === 'undefined') return null;
  const query = new URLSearchParams(globalThis.location.search);
  const hash = globalThis.location.hash.startsWith('#') ? new URLSearchParams(globalThis.location.hash.slice(1)) : new URLSearchParams();
  const error = hash.get('error') ?? query.get('error');
  const errorCode = hash.get('error_code') ?? query.get('error_code');
  if (!error && !errorCode) return null;
  if (errorCode === 'otp_expired') return null;
  if (error === 'access_denied' || errorCode === 'access_denied') return 'Google sign-in was cancelled or denied. Try again or sign in with your APMS account.';
  return 'Google sign-in could not be completed. Try again or sign in with your APMS account.';
}

async function loadSupabaseUser(session: Session): Promise<AuthUser | null> {
  if (!supabase) return null;
  let data: any = null;
  let error: { code?: string } | null = null;
  // Supabase sends the invite as soon as its Auth user is created. Give the
  // account-provisioning Edge Function a moment to attach the APMS profile and
  // role before resolving the invitation's just-created session.
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const result = await supabase
      .from('profiles')
      .select('id,email,first_name,last_name,status,onboarding_completed_at,user_roles!user_roles_user_id_fkey!inner(roles!inner(key))')
      .eq('id', session.user.id)
      .single();
    data = result.data;
    error = result.error;
    if (!error || error.code !== 'PGRST116' || attempt === 6) break;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  // Other failures (network, API, schema) must not be mistaken for an invalid session.
  if (error) { if (error.code === 'PGRST116') return null; throw error; }
  if (!data || data.status !== 'active') return null;
  const nested = data.user_roles as unknown as { roles: { key: Role } }[];
  const role = nested[0]?.roles?.key;
  return role ? { id: data.id, email: data.email, firstName: data.first_name, lastName: data.last_name, role, emailConfirmed: Boolean(session.user.email_confirmed_at), onboardingComplete: Boolean(data.onboarding_completed_at) } : null;
}

function resolveSupabaseSession(session: Session): Promise<SessionResolution> {
  const cached = sessionResolutions.get(session.access_token);
  if (cached) return cached;

  const resolution = (async (): Promise<SessionResolution> => {
    if (!supabase) return { user: null, factorId: null, mfaEnabled: false, mfaRequired: false, mfaSetupRequired: false };
    const [assuranceResult, factorsResult] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);
    if (assuranceResult.error) throw assuranceResult.error;
    if (factorsResult.error) throw factorsResult.error;
    const factor = factorsResult.data?.totp.find((candidate) => candidate.status === 'verified');
    const profileUser = await loadSupabaseUser(session);
    const policyResult = await supabase.functions.invoke('auth-mfa-policy');
    if (policyResult.error || policyResult.data?.error) throw policyResult.error ?? new Error(policyResult.data.error);
    const mfaRequired = policyResult.data?.required === true;
    const needsMfa = mfaRequired && assuranceResult.data?.nextLevel === 'aal2'
      && assuranceResult.data.currentLevel !== 'aal2'
      && Boolean(factor);
    const mfaSetupRequired = mfaRequired && !factor && Boolean(profileUser?.onboardingComplete);
    return {
      user: needsMfa || mfaSetupRequired ? null : profileUser,
      factorId: needsMfa ? factor!.id : null,
      mfaEnabled: Boolean(factor),
      mfaRequired,
      mfaSetupRequired,
    };
  })();

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
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role, emailConfirmed: true, onboardingComplete: true };
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [passwordRecoveryError, setPasswordRecoveryError] = useState<string | null>(recoveryLinkErrorFromCurrentUrl);
  const [authError, setAuthError] = useState<string | null>(authCallbackErrorFromCurrentUrl);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let authEventSeen = false;
    let sessionRevision = 0;
    let deepLinkCleanup: (() => void) | undefined;
    const readRecoveryLinkError = () => {
      const message = recoveryLinkErrorFromCurrentUrl();
      if (!message || typeof globalThis.location === 'undefined') return;
      setPasswordRecoveryError(message);
      globalThis.history?.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);
    };
    const readAuthCallbackError = () => {
      const message = authCallbackErrorFromCurrentUrl();
      if (!message || typeof globalThis.location === 'undefined') return;
      setAuthError(message);
      // OAuth errors arrive in the fragment. Remove it so a refresh does not
      // repeatedly replay the same failed callback.
      globalThis.history?.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);
    };
    if (demoMode) {
      const savedId = globalThis.localStorage?.getItem(demoSessionKey);
      const saved = DEMO_USERS.find((candidate) => candidate.id === savedId);
      if (saved) setUser(fromDemo(saved));
      setLoading(false);
      return () => { active = false; };
    }
    if (!supabase) { setLoading(false); return () => { active = false; }; }
    const client = supabase;
    readRecoveryLinkError();
    readAuthCallbackError();
    if (Platform.OS === 'web' && typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('hashchange', readRecoveryLinkError);
      globalThis.addEventListener('hashchange', readAuthCallbackError);
    }
    const handledRecoveryUrls = new Set<string>();
    const restoreRecoveryFromUrl = async (url: string | null) => {
      if (Platform.OS === 'web' || !url || handledRecoveryUrls.has(url)) return;
      handledRecoveryUrls.add(url);
      const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
      const fragment = new URLSearchParams(hash);
      const query = Linking.parse(url).queryParams ?? {};
      const type = fragment.get('type') ?? (typeof query.type === 'string' ? query.type : null);
      const code = fragment.get('code') ?? (typeof query.code === 'string' ? query.code : null);
      const onboardingCallback = url.includes('/onboarding') || url.startsWith('apms://onboarding');
      if (active && code && (onboardingCallback || type === 'invite')) {
        try {
          const { error } = await client.auth.exchangeCodeForSession(code);
          if (error && active) setAuthError('This invitation link has expired or has already been used. Ask the System Admin to send another invitation.');
        } catch {
          if (active) setAuthError('This invitation link could not be verified. Ask the System Admin to send another invitation.');
        }
        return;
      }
      const errorCode = fragment.get('error_code') ?? (typeof query.error_code === 'string' ? query.error_code : null);
      const callbackError = fragment.get('error_description') ?? (typeof query.error_description === 'string' ? query.error_description : null);
      if (active && onboardingCallback && (errorCode || callbackError)) {
        setAuthError('This invitation link has expired or could not be verified. Ask the System Admin to send another invitation.');
        return;
      }
      if (errorCode === 'otp_expired') {
        setPasswordRecoveryError('This password reset link has expired or has already been used.');
        return;
      }
      const accessToken = fragment.get('access_token') ?? (typeof query.access_token === 'string' ? query.access_token : null);
      const refreshToken = fragment.get('refresh_token') ?? (typeof query.refresh_token === 'string' ? query.refresh_token : null);
      if (!active || !['recovery', 'invite', 'signup'].includes(type ?? '') || !accessToken || !refreshToken) return;
      if (type === 'recovery') setPasswordRecovery(true);
      try {
        const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (error && active) setPasswordRecovery(false);
      } catch {
        if (active) setPasswordRecovery(false);
      }
    };
    if (Platform.OS !== 'web') {
      void Linking.getInitialURL().then(restoreRecoveryFromUrl).catch(() => undefined);
      const urlListener = Linking.addEventListener('url', ({ url }) => { void restoreRecoveryFromUrl(url); });
      // Continue below using the same cleanup so the deep-link listener cannot outlive auth state.
      const cleanupAuthListener = () => urlListener.remove();
      // Retain this cleanup alongside the Supabase subscription below.
      deepLinkCleanup = cleanupAuthListener;
    }
    const applySession = async (session: Session | null) => {
      const revision = ++sessionRevision;
      if (!session) {
        setUser(null);
        setMfaFactorId(null);
        setMfaEnabled(false);
        setMfaRequired(false);
        setMfaSetupRequired(false);
        return;
      }
      const resolution = await resolveSupabaseSession(session);
      if (!active || revision !== sessionRevision) return;
      const googleIdentity = session.user.app_metadata?.provider === 'google'
        || (Array.isArray(session.user.app_metadata?.providers) && session.user.app_metadata.providers.includes('google'));
      if (googleIdentity && !resolution.user && !resolution.factorId && !resolution.mfaSetupRequired) {
        setUser(null);
        setAuthError('This Google account does not have an active APMS account. Ask an APMS administrator to create or activate your account, then try again.');
        // Supabase may create an Auth identity during OAuth when sign-ups are
        // enabled. End its local session so it cannot enter the app without a
        // provisioned APMS profile and role.
        void client.auth.signOut({ scope: 'local' }).catch(() => undefined);
        return;
      }
      setMfaEnabled(resolution.mfaEnabled);
      setMfaRequired(resolution.mfaRequired);
      setMfaSetupRequired(resolution.mfaSetupRequired);
      setMfaFactorId(resolution.factorId);
      setUser(resolution.user);
    };
    client.auth.getSession().then(async ({ data }) => {
      // onAuthStateChange can deliver a newer session while getSession is in
      // flight. In that case, let the event own the state update.
      if (active && !authEventSeen) await applySession(data.session);
      if (active) setLoading(false);
    }).catch(() => { if (active) setLoading(false); });
    const { data: listener } = client.auth.onAuthStateChange((event, session) => {
      authEventSeen = true;
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      void (async () => {
        if (!active) return;
        try {
          await applySession(session);
        } catch {
          // A failed profile/MFA refresh is not proof that Supabase ended the
          // session. Keep the last resolved identity and let the next refresh
          // or explicit auth event retry instead of redirecting to login.
        } finally {
          if (active) setLoading(false);
        }
      })();
    });
    return () => { active = false; listener.subscription.unsubscribe(); deepLinkCleanup?.(); if (Platform.OS === 'web' && typeof globalThis.removeEventListener === 'function') { globalThis.removeEventListener('hashchange', readRecoveryLinkError); globalThis.removeEventListener('hashchange', readAuthCallbackError); } };
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const normalized = email.trim().toLowerCase();
    if (demoMode) {
      const found = DEMO_USERS.find((candidate) => candidate.email === normalized && candidate.password === password);
      if (!found) return { ok: false, message: 'The email or password is incorrect.' };
      const next = fromDemo(found); globalThis.localStorage?.setItem(demoSessionKey, found.id); setPasswordRecovery(false); setUser(next); return { ok: true, user: next };
    }
    if (!supabase) return { ok: false, message: 'APMS is not connected. Configure the Supabase variables in .env.' };
    const { data, error } = await supabase.auth.signInWithPassword({ email: normalized, password });
    if (error || !data.session) return { ok: false, message: 'The email or password is incorrect.' };
    let resolution: SessionResolution;
    try {
      resolution = await resolveSupabaseSession(data.session);
    } catch (cause) {
      return { ok: false, message: getErrorMessage(cause, 'Your account could not be verified right now. Please try again.') };
    }
    setMfaEnabled(resolution.mfaEnabled);
    setMfaRequired(resolution.mfaRequired);
    setMfaSetupRequired(resolution.mfaSetupRequired);
    if (resolution.factorId) {
      setMfaFactorId(resolution.factorId);
      return { ok: false, mfaRequired: true, factorId: resolution.factorId };
    }
    if (resolution.mfaSetupRequired) {
      setMfaSetupRequired(true);
      setUser(null);
      return { ok: false, mfaSetupRequired: true };
    }
    const next = resolution.user;
    if (!next) {
      await supabase.auth.signOut({ scope: 'local' });
      return { ok: false, message: 'This account is inactive or has no assigned APMS role.' };
    }
    setPasswordRecovery(false); setUser(next); return { ok: true, user: next };
  }, []);

  const verifyMfa = useCallback(async (code: string, factorId = mfaFactorId ?? undefined) => {
    if (!supabase || !factorId) return { ok: false, message: 'No MFA challenge is active.' };
    if (!/^\d{6}$/.test(code.trim())) return { ok: false, message: 'Enter the six-digit code from your authenticator app.' };
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
    if (challengeError || !challenge) return { ok: false, message: 'The MFA challenge could not be started. Try again.' };
    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code: code.trim() });
    if (error) return { ok: false, message: 'That MFA code is invalid or expired.' };
    const { data: sessionData } = await supabase.auth.getSession();
    const next = sessionData.session ? await loadSupabaseUser(sessionData.session) : null;
    if (!next) return { ok: false, message: 'Your account is inactive or has no assigned APMS role.' };
    setMfaFactorId(null); setUser(next);
    setMfaEnabled(true);
    setMfaSetupRequired(false);
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
    return { ok: true as const, enrollment: { factorId: data.id, uri: data.totp.uri, secret: data.totp.secret } };
  }, []);

  const beginMfaReconfiguration = useCallback(async () => {
    if (demoMode) return { ok: false as const, message: 'MFA reconfiguration is unavailable for development-only accounts.' };
    if (!supabase) return { ok: false as const, message: 'APMS is not connected.' };
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) return { ok: false as const, message: getErrorMessage(factorsError, 'Your authenticator could not be checked.') };
    const oldFactor = factors?.totp.find((factor) => factor.status === 'verified');
    if (!oldFactor) return { ok: false as const, message: 'No verified authenticator app was found for this account.' };
    const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError) return { ok: false as const, message: getErrorMessage(assuranceError, 'Your session could not be verified.') };
    if (assurance.currentLevel !== 'aal2') return { ok: false as const, message: 'Verify your current authenticator app to continue.', verifyFactorId: oldFactor.id };
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `APMS authenticator replacement ${Date.now()}` });
    if (error || !data?.id || !data.totp) return { ok: false as const, message: getErrorMessage(error, 'A replacement authenticator could not be set up.') };
    return { ok: true as const, oldFactorId: oldFactor.id, enrollment: { factorId: data.id, uri: data.totp.uri, secret: data.totp.secret } };
  }, []);

  const removeReplacedMfaFactor = useCallback(async (factorId: string) => {
    if (!supabase) return { ok: false, message: 'APMS is not connected.' };
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) return { ok: false, message: getErrorMessage(error, 'The previous authenticator could not be removed.') };
    setMfaEnabled(true);
    return { ok: true, message: 'The previous authenticator was removed.' };
  }, []);

  const cancelMfaEnrollment = useCallback(async (factorId: string) => {
    if (!supabase) return;
    await supabase.auth.mfa.unenroll({ factorId });
  }, []);

  const disableMfa = useCallback(async () => {
    if (!supabase) return { ok: false, message: 'APMS is not connected.' };
    const policy = await supabase.functions.invoke('auth-mfa-policy');
    if (policy.error || policy.data?.error) return { ok: false, message: 'The MFA policy could not be checked. Try again.' };
    if (policy.data?.required === true) { setMfaRequired(true); return { ok: false, message: 'Your account is required to use two-step verification by your system administrator.' }; }
    setMfaRequired(false);
    const { data: factors, error } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp.find((candidate) => candidate.status === 'verified');
    if (error || !factor) return { ok: false, message: 'No active MFA factor was found.' };
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (!unenrollError) setMfaEnabled(false);
    return unenrollError ? { ok: false, message: 'MFA could not be disabled.' } : { ok: true, message: 'MFA has been disabled for this account.' };
  }, []);

  const clearPasswordRecoveryError = useCallback(() => setPasswordRecoveryError(null), []);
  const clearAuthError = useCallback(() => setAuthError(null), []);
  const signOut = useCallback(async () => { clearRememberedPortalRoute(); setPasswordRecovery(false); setPasswordRecoveryError(null); setAuthError(null); if (supabase) await supabase.auth.signOut({ scope: 'local' }); if (demoMode) globalThis.localStorage?.removeItem(demoSessionKey); setUser(null); setMfaFactorId(null); setMfaRequired(false); setMfaSetupRequired(false); }, []);
  const requestPasswordReset = useCallback(async (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !/^\S+@\S+\.\S+$/.test(normalized)) return { ok: false, message: 'Enter a valid institutional email address first.' };
    if (demoMode) return { ok: false, message: 'Password reset is unavailable for development-only accounts.' };
    if (!supabase) return { ok: false, message: 'APMS is not connected. No reset email was sent.' };
    const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined' ? `${globalThis.location.origin}/` : Linking.createURL('/');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(normalized, { redirectTo });
      if (error) return { ok: false, message: 'A reset email could not be sent. Try again or contact the system operator.' };
      setPasswordRecoveryError(null);
      return { ok: true, message: 'If the account exists, password reset instructions have been sent.' };
    } catch {
      return { ok: false, message: 'A reset email could not be sent. Check your connection and try again.' };
    }
  }, []);
  const updatePassword = useCallback(async (newPassword: string) => {
    if (!supabase) return { ok: false, message: 'APMS is not connected. The password was not changed.' };
    if (newPassword.length < 12) return { ok: false, message: 'Use at least 12 characters for your new password.' };
    if (!passwordRecovery) return { ok: false, message: 'This password reset link is invalid or has expired. Request a new link and try again.' };
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) return { ok: false, message: getErrorMessage(error, 'The password could not be updated. Request a new reset link and try again.') };
      setPasswordRecovery(false);
      return { ok: true, message: 'Your password has been reset. You can continue to APMS.' };
    } catch (cause) {
      return { ok: false, message: getErrorMessage(cause, 'The password could not be updated. Check your connection and try again.') };
    }
  }, [passwordRecovery]);
  const setOnboardingPassword = useCallback(async (newPassword: string) => {
    if (!supabase || !user || user.onboardingComplete) return { ok: false, message: 'Open your active invitation to set an onboarding password.' };
    if (newPassword.length < 12) return { ok: false, message: 'Use at least 12 characters for your password.' };
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      return error ? { ok: false, message: getErrorMessage(error, 'The password could not be saved. Try again.') } : { ok: true, message: 'Password saved.' };
    } catch (cause) { return { ok: false, message: getErrorMessage(cause, 'The password could not be saved. Check your connection and try again.') }; }
  }, [user]);
  const completeOnboarding = useCallback(async (takeoverEmail?: string) => {
    if (!supabase || !user || user.onboardingComplete) return { ok: false, message: 'Open your active invitation to complete onboarding.' };
    try {
      const { data, error } = await supabase.functions.invoke('apms-onboarding', { body: { takeoverEmail: takeoverEmail?.trim() || null } });
      if (error || data?.error) return { ok: false, message: getErrorMessage(error, data?.error ?? 'Your onboarding details could not be saved. Try again.') };
      const { data: sessionData } = await supabase.auth.getSession();
      const next = sessionData.session ? await loadSupabaseUser(sessionData.session) : null;
      if (!next) return { ok: false, message: 'Onboarding was saved, but the account session needs to be refreshed. Sign in again.' };
      setUser(next);
      return { ok: true, message: 'Onboarding complete.' };
    } catch (cause) { return { ok: false, message: getErrorMessage(cause, 'Your onboarding details could not be saved. Try again.') }; }
  }, [user]);
  const signInWithGoogle = useCallback(async () => {
    if (demoMode) return { ok: false, message: 'Google sign-in is unavailable for development-only accounts.' };
    if (!supabase) return { ok: false, message: 'APMS is not connected. Google sign-in could not start.' };
    const redirectTo = Platform.OS === 'web' && typeof globalThis.location !== 'undefined' ? `${globalThis.location.origin}/` : Linking.createURL('/');
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: Platform.OS !== 'web' } });
      if (error || !data.url) return { ok: false, message: getErrorMessage(error, 'Google sign-in could not start. Check your connection or contact the system operator.') };
      if (Platform.OS === 'web') return { ok: true, message: 'Continue in the Google sign-in window.' };

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type === 'cancel' || result.type === 'dismiss') return { ok: false, message: 'Google sign-in was cancelled. You can try again or sign in with your APMS account.' };
      if (result.type !== 'success' || !result.url) return { ok: false, message: 'Google sign-in did not return a response. Try again.' };

      const parsed = Linking.parse(result.url);
      const params = parsed.queryParams ?? {};
      const hashParams = result.url.includes('#') ? new URLSearchParams(result.url.slice(result.url.indexOf('#') + 1)) : new URLSearchParams();
      const callbackError = hashParams.get('error_description') ?? hashParams.get('error') ?? (typeof params.error_description === 'string' ? params.error_description : typeof params.error === 'string' ? params.error : null);
      if (callbackError) return { ok: false, message: 'Google sign-in was cancelled or could not be completed. Try again or sign in with your APMS account.' };

      const code = hashParams.get('code') ?? (typeof params.code === 'string' ? params.code : null);
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) return { ok: false, message: getErrorMessage(exchangeError, 'Google sign-in could not be completed. The link may have expired; try again.') };
      } else {
        const accessToken = hashParams.get('access_token') ?? (typeof params.access_token === 'string' ? params.access_token : null);
        const refreshToken = hashParams.get('refresh_token') ?? (typeof params.refresh_token === 'string' ? params.refresh_token : null);
        if (!accessToken || !refreshToken) return { ok: false, message: 'Google did not return a usable sign-in response. Check the Supabase redirect settings and try again.' };
        const { error: sessionError } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (sessionError) return { ok: false, message: getErrorMessage(sessionError, 'Google sign-in could not be completed. The link may have expired; try again.') };
      }
      return { ok: true, message: 'Google sign-in completed.' };
    } catch (cause) {
      return { ok: false, message: getErrorMessage(cause, 'Google sign-in could not be completed. Check your connection and try again.') };
    }
  }, []);
  const value = useMemo(() => ({ user, loading, configured: isSupabaseConfigured, demoMode, authError, clearAuthError, signIn, passwordRecovery, passwordRecoveryError, clearPasswordRecoveryError, updatePassword, setOnboardingPassword, completeOnboarding, mfaFactorId, mfaEnabled, mfaRequired, mfaSetupRequired, enrollMfa, beginMfaReconfiguration, removeReplacedMfaFactor, cancelMfaEnrollment, verifyMfa, disableMfa, signInWithGoogle, requestPasswordReset, signOut }), [user, loading, authError, clearAuthError, signIn, passwordRecovery, passwordRecoveryError, clearPasswordRecoveryError, updatePassword, setOnboardingPassword, completeOnboarding, mfaFactorId, mfaEnabled, mfaRequired, mfaSetupRequired, enrollMfa, beginMfaReconfiguration, removeReplacedMfaFactor, cancelMfaEnrollment, verifyMfa, disableMfa, signInWithGoogle, requestPasswordReset, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
