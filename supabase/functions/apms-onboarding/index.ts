import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Sign in through your invitation email to continue.' }, 401)
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  const caller = callerData.user
  if (callerError || !caller) return json({ error: 'This invitation session is invalid or has expired. Ask the System Admin to send another invitation.' }, 401)
  if (!caller.email_confirmed_at) return json({ error: 'Confirm your email from the invitation before completing onboarding.' }, 403)

  let body: { takeoverEmail?: string | null }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const { data: profile, error: profileError } = await admin.from('profiles').select('status,onboarding_completed_at,email').eq('id', caller.id).maybeSingle()
  if (profileError || !profile) return json({ error: 'Your APMS account could not be found.' }, 404)
  if (profile.onboarding_completed_at) return json({ error: 'This account has already completed onboarding.' }, 409)
  if (profile.status !== 'active') return json({ error: 'This account is inactive. Contact the System Admin.' }, 403)
  const { data: assignment, error: roleError } = await admin.from('user_roles').select('scope_type,scope_id,roles!inner(key)').eq('user_id', caller.id).maybeSingle()
  if (roleError || !assignment) return json({ error: 'Your APMS role is not ready yet. Contact the System Admin.' }, 403)
  const role = (assignment.roles as unknown as { key: string }).key
  if (!['system_admin', 'academic_admin', 'faculty'].includes(role)) return json({ error: 'Your APMS role is not recognized.' }, 403)

  const { data: policyRows, error: policyError } = await admin.from('system_settings').select('key,value')
    .in('key', ['security.mfa_required', 'security.mfa_required_roles', 'security.mfa_required_departments'])
  if (policyError) return json({ error: 'Your two-step verification policy could not be checked. Try again.' }, 500)
  const policy = new Map((policyRows ?? []).map((row) => [row.key, row.value]))
  const roleRequirements = Array.isArray(policy.get('security.mfa_required_roles')) ? policy.get('security.mfa_required_roles') as unknown[] : []
  const departmentRequirements = Array.isArray(policy.get('security.mfa_required_departments')) ? policy.get('security.mfa_required_departments') as unknown[] : []
  const mfaRequired = policy.get('security.mfa_required') === true
    || roleRequirements.includes(role)
    || (assignment.scope_type === 'department' && departmentRequirements.includes(assignment.scope_id))

  const takeoverEmail = typeof body.takeoverEmail === 'string' ? body.takeoverEmail.trim().toLowerCase() : ''
  if (role === 'academic_admin') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(takeoverEmail)) return json({ error: 'Enter a valid takeover email for your department.' }, 400)
    if (takeoverEmail === profile.email.toLowerCase()) return json({ error: 'Use an email address different from your APMS sign-in email.' }, 400)
  }

  const { data: factorResult, error: factorError } = await admin.auth.admin.mfa.listFactors({ userId: caller.id })
  if (factorError) return json({ error: 'Your two-step verification could not be checked. Try again.' }, 500)
  if (mfaRequired && !factorResult?.factors.some((factor) => factor.status === 'verified')) return json({ error: 'Set up and verify an authenticator app before finishing onboarding.' }, 400)

  const { error: updateError } = await admin.from('profiles').update({
    takeover_email: role === 'academic_admin' ? takeoverEmail : null,
    onboarding_completed_at: new Date().toISOString(),
  }).eq('id', caller.id)
  if (updateError) return json({ error: 'Your onboarding details could not be saved. Try again.' }, 500)
  await admin.from('audit_logs').insert({ actor_id: caller.id, action: 'user.onboarding_completed', entity_type: 'profiles', entity_id: caller.id, after_data: { role, has_takeover_email: role === 'academic_admin' } })
  return json({ completed: true })
})
