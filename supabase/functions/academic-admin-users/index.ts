import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type RequestBody = {
  action: 'list' | 'invite' | 'resend_invitation'
  userId?: string
  email?: string
  firstName?: string
  lastName?: string
  employeeId?: string
  role?: 'faculty' | 'academic_admin'
  redirectTo?: string
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const callerClient = createClient(url, anonKey, { auth: { persistSession: false } })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(authorization.slice('Bearer '.length))
  if (callerError || !callerData.user) return json({ error: 'Invalid session' }, 401)
  const callerId = callerData.user.id

  let body: RequestBody
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  const { data: assignment, error: assignmentError } = await admin.from('user_roles')
    .select('scope_id,scope_type,valid_from,valid_until,profiles!user_roles_user_id_fkey!inner(status),roles!inner(key)')
    .eq('user_id', callerId).eq('scope_type', 'department').eq('roles.key', 'academic_admin').maybeSingle()
  const profile = (assignment as any)?.profiles
  if (assignmentError || !assignment || profile?.status !== 'active' || !assignment.scope_id || new Date(assignment.valid_from).getTime() > Date.now() || (assignment.valid_until && new Date(assignment.valid_until).getTime() <= Date.now())) {
    return json({ error: 'Active Academic Admin department access is required' }, 403)
  }
  const departmentId = assignment.scope_id as string

  const { data: inviteSetting } = await admin.from('system_settings').select('value').eq('key', 'academic_admins.can_invite_academic_admins').maybeSingle()
  const canInviteAcademicAdmins = inviteSetting?.value === true || inviteSetting?.value === 'true'
  const { data: facultyInviteSetting } = await admin.from('system_settings').select('value').eq('key', 'academic_admins.can_invite_faculty').maybeSingle()
  const canInviteFaculty = facultyInviteSetting?.value !== false && facultyInviteSetting?.value !== 'false'

  const onboardingUrl = (value?: string) => {
    if (!value) return null
    try {
      const parsed = new URL(value)
      return ['http:', 'https:', 'apms:'].includes(parsed.protocol) && parsed.pathname.endsWith('/onboarding') ? parsed : null
    } catch { return null }
  }

  if (body.action === 'list') {
    const { data: users, error } = await admin.from('user_roles')
      .select('user_id,scope_type,scope_id,valid_from,valid_until,roles!inner(key,name),profiles!user_roles_user_id_fkey!inner(id,email,first_name,last_name,status,onboarding_completed_at)')
      .eq('scope_type', 'department').eq('scope_id', departmentId).in('roles.key', ['faculty', 'academic_admin'])
      .order('created_at', { ascending: false })
    if (error) return json({ error: error.message }, 500)
    const members = (users ?? []).filter((row: any) => new Date(row.valid_from).getTime() <= Date.now() && (!row.valid_until || new Date(row.valid_until).getTime() > Date.now()))
      .map((row: any) => {
        const member = row.profiles
        const role = row.roles?.key
        return {
          id: member.id,
          email: member.email,
          firstName: member.first_name,
          lastName: member.last_name,
          role,
          roleName: row.roles?.name ?? (role === 'faculty' ? 'Faculty' : 'Academic Admin'),
          status: !member.onboarding_completed_at && member.status === 'active' ? 'invited' : member.status,
          onboardingComplete: Boolean(member.onboarding_completed_at),
        }
      })
    return json({ users: members, canInviteAcademicAdmins, canInviteFaculty })
  }

  if (body.action === 'invite') {
    const role = body.role ?? 'faculty'
    if (!body.firstName?.trim() || !body.lastName?.trim() || !body.email?.trim()) return json({ error: 'First name, last name, and email are required' }, 400)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return json({ error: 'Enter a valid account email address' }, 400)
    if (role !== 'faculty' && role !== 'academic_admin') return json({ error: 'Choose Faculty or Academic Admin' }, 400)
    if (role === 'academic_admin' && !canInviteAcademicAdmins) return json({ error: 'The System Admin has not enabled Academic Admin invitations' }, 403)
    if (role === 'faculty' && !canInviteFaculty) return json({ error: 'The System Admin has disabled Faculty invitations' }, 403)
    if (role === 'faculty' && !body.employeeId?.trim()) return json({ error: 'Faculty employee ID is required' }, 400)
    const redirectTo = onboardingUrl(body.redirectTo)
    if (!redirectTo) return json({ error: 'A valid APMS onboarding destination is required' }, 400)

    const normalizedEmail = body.email.trim().toLowerCase()
    const firstName = body.firstName.trim()
    const lastName = body.lastName.trim()
    const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(normalizedEmail, {
      data: { first_name: firstName, last_name: lastName, apms_role: role },
      redirectTo: redirectTo.toString(),
    })
    if (inviteError || !invitation.user) return json({ error: inviteError?.message ?? 'The invitation could not be sent' }, 400)
    const userId = invitation.user.id
    try {
      const { error: metadataError } = await admin.auth.admin.updateUserById(userId, { app_metadata: { apms_role: role } })
      if (metadataError) throw metadataError
      const { error: profileError } = await admin.from('profiles').insert({ id: userId, email: normalizedEmail, first_name: firstName, last_name: lastName, status: 'active', takeover_email: null, onboarding_completed_at: null })
      if (profileError) throw profileError
      const { error: roleError } = await admin.rpc('admin_assign_user_role', {
        p_user_id: userId,
        p_role_key: role,
        p_department_id: departmentId,
        p_employee_id: role === 'faculty' ? body.employeeId?.trim() : null,
        p_granted_by: callerId,
      })
      if (roleError) throw roleError
      await admin.from('audit_logs').insert({ actor_id: callerId, action: 'user.created_by_academic_admin', entity_type: 'profiles', entity_id: userId, after_data: { role, scope_id: departmentId } })
      return json({ userId, invited: true })
    } catch (cause) {
      await admin.auth.admin.deleteUser(userId)
      return json({ error: cause instanceof Error ? cause.message : 'Account invitation setup failed' }, 400)
    }
  }

  if (body.action === 'resend_invitation') {
    if (!body.userId) return json({ error: 'User ID is required' }, 400)
    const redirectTo = onboardingUrl(body.redirectTo)
    if (!redirectTo) return json({ error: 'A valid APMS onboarding destination is required' }, 400)
    const { data: member, error: memberError } = await admin.from('user_roles')
      .select('user_id,roles!inner(key),profiles!user_roles_user_id_fkey!inner(id,email,status,onboarding_completed_at)')
      .eq('user_id', body.userId).eq('scope_type', 'department').eq('scope_id', departmentId).in('roles.key', ['faculty', 'academic_admin']).maybeSingle()
    const memberProfile = (member as any)?.profiles
    if (memberError || !member || !memberProfile) return json({ error: 'This account is not in your department' }, 404)
    if ((member as any).roles?.key === 'academic_admin' && !canInviteAcademicAdmins) return json({ error: 'The System Admin has disabled Academic Admin invitations' }, 403)
    if ((member as any).roles?.key === 'faculty' && !canInviteFaculty) return json({ error: 'The System Admin has disabled Faculty invitations' }, 403)
    if (memberProfile.status !== 'active' || memberProfile.onboarding_completed_at) return json({ error: 'Only active accounts that have not completed onboarding can receive another invitation' }, 409)
    const { error: resendError } = await admin.auth.resend({ type: 'signup', email: memberProfile.email, options: { emailRedirectTo: redirectTo.toString() } })
    if (resendError) return json({ error: resendError.message }, 400)
    await admin.from('audit_logs').insert({ actor_id: callerId, action: 'user.invitation_resent_by_academic_admin', entity_type: 'profiles', entity_id: memberProfile.id, after_data: { email: memberProfile.email, scope_id: departmentId } })
    return json({ userId: memberProfile.id, invitationSent: true })
  }

  return json({ error: 'Unsupported action' }, 400)
})
