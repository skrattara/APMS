import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type CoreRole = 'system_admin' | 'academic_admin' | 'faculty'
type RequestBody = {
  action: 'list' | 'create' | 'update' | 'delete' | 'resend_invitation' | 'send_password_reset'
  userIds?: string[]
  takeoverEmails?: Record<string, string>
  forceDeleteAcademicAdminWithoutTakeover?: boolean
  forceDeleteLinkedRecords?: boolean
  userId?: string
  email?: string
  redirectTo?: string
  firstName?: string
  lastName?: string
  role?: CoreRole
  status?: 'active' | 'inactive' | 'suspended'
  departmentId?: string
  employeeId?: string
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
  const token = authorization.slice('Bearer '.length)
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const userClient = createClient(url, anonKey, { auth: { persistSession: false } })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: callerData, error: callerError } = await userClient.auth.getUser(token)
  if (callerError || !callerData.user) return json({ error: 'Invalid session' }, 401)
  const callerId = callerData.user.id
  const { data: authorizationRow } = await admin
    .from('user_roles')
    .select('roles!inner(key),profiles!user_roles_user_id_fkey!inner(status)')
    .eq('user_id', callerId)
    .eq('roles.key', 'system_admin')
    .eq('profiles.status', 'active')
    .maybeSingle()
  if (!authorizationRow) return json({ error: 'System Admin permission required' }, 403)

  let body: RequestBody
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }

  if (body.action === 'list') {
    const { data: authPage, error: authError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    if (authError) return json({ error: authError.message }, 500)
    const ids = authPage.users.map((user) => user.id)
    const { data: profiles, error: profileError } = await admin
      .from('profiles')
      .select('id,email,first_name,last_name,status,last_login_at,takeover_email,onboarding_completed_at,user_roles!user_roles_user_id_fkey(roles(key,name),scope_type,scope_id)')
      .in('id', ids)
    if (profileError) return json({ error: profileError.message }, 500)
    const authById = new Map(authPage.users.map((user) => [user.id, user]))
    return json({ users: (profiles ?? []).map((profile: any) => ({
      id: profile.id,
      email: profile.email,
      firstName: profile.first_name,
      lastName: profile.last_name,
      status: !profile.onboarding_completed_at && profile.status === 'active' ? 'invited' : profile.status,
      lastLoginAt: profile.last_login_at ?? authById.get(profile.id)?.last_sign_in_at ?? null,
      takeoverEmail: profile.takeover_email ?? null,
      onboardingComplete: Boolean(profile.onboarding_completed_at),
      role: profile.user_roles?.[0]?.roles?.key ?? null,
      roleName: profile.user_roles?.[0]?.roles?.name ?? null,
      scopeType: profile.user_roles?.[0]?.scope_type ?? null,
      scopeId: profile.user_roles?.[0]?.scope_id ?? null,
    })) })
  }

  const allowedRoles: CoreRole[] = ['system_admin', 'academic_admin', 'faculty']
  if (body.role && !allowedRoles.includes(body.role)) return json({ error: 'Invalid core role' }, 400)

  if (body.action === 'create') {
    if (!body.email || !body.firstName || !body.lastName || !body.role) return json({ error: 'Email, name, and role are required' }, 400)
    if (!/^\S+@\S+\.\S+$/.test(body.email.trim())) return json({ error: 'Enter a valid account email address' }, 400)
    if (body.role !== 'system_admin' && !body.departmentId) return json({ error: 'Department scope is required for academic users' }, 400)
    if (body.role === 'faculty' && !body.employeeId) return json({ error: 'Faculty employee ID is required' }, 400)
    if (!body.redirectTo) return json({ error: 'The onboarding link destination is required' }, 400)
    let redirectTo: URL
    try { redirectTo = new URL(body.redirectTo) } catch { return json({ error: 'The onboarding link destination is invalid' }, 400) }
    if (!['http:', 'https:', 'apms:'].includes(redirectTo.protocol) || !redirectTo.pathname.endsWith('/onboarding')) return json({ error: 'The onboarding link destination must point to the APMS onboarding page' }, 400)
    const normalizedEmail = body.email.trim().toLowerCase()
    const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(normalizedEmail, {
      data: { first_name: body.firstName.trim(), last_name: body.lastName.trim(), apms_role: body.role },
      redirectTo: redirectTo.toString(),
    })
    if (inviteError || !invitation.user) return json({ error: inviteError?.message ?? 'Account invitation could not be sent' }, 400)
    const userId = invitation.user.id
    try {
      const { error: metadataError } = await admin.auth.admin.updateUserById(userId, { app_metadata: { apms_role: body.role } })
      if (metadataError) throw metadataError
      const { error: profileError } = await admin.from('profiles').insert({ id: userId, email: normalizedEmail, first_name: body.firstName.trim(), last_name: body.lastName.trim(), status: 'active', takeover_email: null, onboarding_completed_at: null })
      if (profileError) throw profileError
      const { error: assignmentError } = await admin.rpc('admin_assign_user_role', {
        p_user_id: userId, p_role_key: body.role, p_department_id: body.departmentId ?? null,
        p_employee_id: body.employeeId ?? null, p_granted_by: callerId,
      })
      if (assignmentError) throw assignmentError
      await admin.from('audit_logs').insert({ actor_id: callerId, action: 'user.created', entity_type: 'profiles', entity_id: userId, after_data: { role: body.role, scope_id: body.departmentId ?? null } })
      return json({ userId, invited: true })
    } catch (cause) {
      await admin.auth.admin.deleteUser(userId)
      return json({ error: cause instanceof Error ? cause.message : 'Account provisioning failed' }, 400)
    }
  }

  if (body.action === 'resend_invitation') {
    if (!body.userId) return json({ error: 'User ID is required' }, 400)
    if (!body.redirectTo) return json({ error: 'The onboarding link destination is required' }, 400)
    let redirectTo: URL
    try { redirectTo = new URL(body.redirectTo) } catch { return json({ error: 'The onboarding link destination is invalid' }, 400) }
    if (!['http:', 'https:', 'apms:'].includes(redirectTo.protocol) || !redirectTo.pathname.endsWith('/onboarding')) return json({ error: 'The onboarding link destination must point to the APMS onboarding page' }, 400)

    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('id,email,first_name,last_name,status,onboarding_completed_at')
      .eq('id', body.userId).maybeSingle()
    if (profileError || !profile) return json({ error: 'The account could not be found' }, 404)
    if (profile.status !== 'active' || profile.onboarding_completed_at) return json({ error: 'Only active accounts that have not completed onboarding can receive another invitation' }, 409)

    const { error: resendError } = await admin.auth.resend({
      type: 'signup',
      email: profile.email,
      options: { emailRedirectTo: redirectTo.toString() },
    })
    if (resendError) return json({ error: resendError.message }, 400)
    await admin.from('audit_logs').insert({ actor_id: callerId, action: 'user.invitation_resent', entity_type: 'profiles', entity_id: profile.id, after_data: { email: profile.email } })
    return json({ userId: profile.id, invitationSent: true })
  }

  if (body.action === 'send_password_reset') {
    if (!body.userId) return json({ error: 'User ID is required' }, 400)
    if (!body.redirectTo) return json({ error: 'The password reset destination is required' }, 400)
    let redirectTo: URL
    try { redirectTo = new URL(body.redirectTo) } catch { return json({ error: 'The password reset destination is invalid' }, 400) }
    if (!['http:', 'https:', 'apms:'].includes(redirectTo.protocol) || !redirectTo.pathname.endsWith('/reset-password')) return json({ error: 'The destination must point to the APMS password reset page' }, 400)

    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('id,email,status,onboarding_completed_at')
      .eq('id', body.userId).maybeSingle()
    if (profileError || !profile) return json({ error: 'The account could not be found' }, 404)
    if (profile.status !== 'active' || !profile.onboarding_completed_at) return json({ error: 'Password reset links are available for active accounts that have completed onboarding' }, 409)

    const { error: resetError } = await userClient.auth.resetPasswordForEmail(profile.email, { redirectTo: redirectTo.toString() })
    if (resetError) return json({ error: resetError.message }, 400)
    await admin.from('audit_logs').insert({ actor_id: callerId, action: 'user.password_reset_requested', entity_type: 'profiles', entity_id: profile.id, after_data: { email: profile.email } })
    return json({ userId: profile.id, passwordResetSent: true })
  }

  if (body.action === 'update') {
    if (!body.userId) return json({ error: 'User ID is required' }, 400)
    if (body.userId === callerId && body.status && body.status !== 'active') return json({ error: 'You cannot deactivate your own active System Admin session' }, 400)
    const updates: Record<string, unknown> = {}
    if (body.status) updates.status = body.status
    if (body.firstName) updates.first_name = body.firstName.trim()
    if (body.lastName) updates.last_name = body.lastName.trim()
    if (Object.keys(updates).length) {
      const { error } = await admin.from('profiles').update(updates).eq('id', body.userId)
      if (error) return json({ error: error.message }, 400)
    }
    if (body.role) {
      if (body.role !== 'system_admin' && !body.departmentId) return json({ error: 'Department scope is required' }, 400)
      const { error: assignmentError } = await admin.rpc('admin_assign_user_role', {
        p_user_id: body.userId, p_role_key: body.role, p_department_id: body.departmentId ?? null,
        p_employee_id: body.employeeId ?? null, p_granted_by: callerId,
      })
      if (assignmentError) return json({ error: assignmentError.message }, 400)
      await admin.auth.admin.updateUserById(body.userId, { app_metadata: { apms_role: body.role } })
    }
    await admin.from('audit_logs').insert({ actor_id: callerId, action: 'user.updated', entity_type: 'profiles', entity_id: body.userId, after_data: { role: body.role, status: body.status } })
    return json({ userId: body.userId })
  }

  if (body.action === 'delete') {
    const userIds = [...new Set((body.userIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0))]
    if (!userIds.length) return json({ error: 'Select at least one account to delete' }, 400)
    const { data: systemAdminRole, error: roleError } = await admin.from('roles').select('id').eq('key', 'system_admin').maybeSingle()
    if (roleError) return json({ error: roleError.message }, 500)
    const { data: academicAdminRole, error: academicRoleError } = await admin.from('roles').select('id').eq('key', 'academic_admin').maybeSingle()
    if (academicRoleError) return json({ error: academicRoleError.message }, 500)
    const { data: academicAssignments, error: academicAssignmentsError } = academicAdminRole
      ? await admin.from('user_roles').select('user_id,scope_id').eq('role_id', academicAdminRole.id).eq('scope_type', 'department')
      : { data: [], error: null }
    if (academicAssignmentsError) return json({ error: academicAssignmentsError.message }, 500)
    const academicUserIds = [...new Set((academicAssignments ?? []).map((row) => row.user_id))]
    const { data: activeAcademicProfiles, error: academicProfilesError } = academicUserIds.length
      ? await admin.from('profiles').select('id,takeover_email').in('id', academicUserIds).eq('status', 'active')
      : { data: [], error: null }
    if (academicProfilesError) return json({ error: academicProfilesError.message }, 500)
    const activeAcademicIds = new Set((activeAcademicProfiles ?? []).map((profile) => profile.id))
    const savedTakeoverEmailByUserId = new Map((activeAcademicProfiles ?? []).map((profile) => [profile.id, typeof profile.takeover_email === 'string' ? profile.takeover_email.trim().toLowerCase() : '']))
    const academicAdminsByDepartment = new Map<string, string[]>()
    for (const assignment of academicAssignments ?? []) {
      if (!assignment.scope_id || !activeAcademicIds.has(assignment.user_id)) continue
      academicAdminsByDepartment.set(assignment.scope_id, [...(academicAdminsByDepartment.get(assignment.scope_id) ?? []), assignment.user_id])
    }
    const takeoverDepartments = [...academicAdminsByDepartment.entries()]
      .filter(([, admins]) => admins.length > 0 && admins.every((id) => userIds.includes(id)))
    const forcedTakeoverDepartments = body.forceDeleteAcademicAdminWithoutTakeover === true ? takeoverDepartments : []
    const forcedAcademicAdminIds = new Set(forcedTakeoverDepartments.flatMap(([, admins]) => admins))
    const takeoverEmails = body.takeoverEmails ?? {}
    const resolvedTakeoverEmails = new Map<string, string>()
    for (const [departmentId] of takeoverDepartments.filter(([id]) => !forcedTakeoverDepartments.some(([forcedId]) => forcedId === id))) {
      const departmentAdmins = academicAdminsByDepartment.get(departmentId) ?? []
      const savedEmails = [...new Set(departmentAdmins.map((id) => savedTakeoverEmailByUserId.get(id)).filter((email): email is string => Boolean(email)))]
      const email = takeoverEmails[departmentId]?.trim().toLowerCase() || (savedEmails.length === 1 ? savedEmails[0] : '')
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid takeover email is required for each department whose active Academic Admins are all being deleted.' }, 400)
      resolvedTakeoverEmails.set(departmentId, email)
    }
    const normalizedTakeoverEmails = takeoverDepartments.filter(([id]) => !forcedTakeoverDepartments.some(([forcedId]) => forcedId === id)).map(([departmentId]) => [departmentId, resolvedTakeoverEmails.get(departmentId)!] as const)
    if (new Set(normalizedTakeoverEmails.map(([, email]) => email)).size !== normalizedTakeoverEmails.length) return json({ error: 'Use a different takeover email for each department.' }, 400)

    const createdTakeovers: { departmentId: string; email: string }[] = []
    const createdTakeoverIds: string[] = []
    const rollbackTakeovers = async () => {
      for (const id of createdTakeoverIds) await admin.auth.admin.deleteUser(id)
    }
    for (const [departmentId, email] of normalizedTakeoverEmails) {
      const configuredOnboardingUrl = body.redirectTo || Deno.env.get('APMS_ONBOARDING_URL')
      const requestOrigin = request.headers.get('origin')?.replace(/\/$/, '')
      const redirectTo = configuredOnboardingUrl || (requestOrigin ? `${requestOrigin}/onboarding?flow=invite` : null)
      let onboardingRedirect: URL | null = null
      try { onboardingRedirect = redirectTo ? new URL(redirectTo) : null } catch { onboardingRedirect = null }
      if (!onboardingRedirect || !['http:', 'https:', 'apms:'].includes(onboardingRedirect.protocol) || !onboardingRedirect.pathname.endsWith('/onboarding')) {
        await rollbackTakeovers()
        return json({ error: 'A valid APMS onboarding link destination is required for department takeover invitations.' }, 400)
      }
      const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, { data: { first_name: 'Academic', last_name: 'Admin', apms_role: 'academic_admin' }, redirectTo: onboardingRedirect.toString() })
      if (inviteError || !invitation.user) {
        await rollbackTakeovers()
        return json({ error: inviteError?.message ?? `Could not create the takeover account for ${email}.` }, 400)
      }
      const replacementId = invitation.user.id
      createdTakeoverIds.push(replacementId)
      try {
        const { error: appMetadataError } = await admin.auth.admin.updateUserById(replacementId, { app_metadata: { apms_role: 'academic_admin' } })
        if (appMetadataError) throw appMetadataError
        const { error: profileError } = await admin.from('profiles').insert({ id: replacementId, email, first_name: 'Academic', last_name: 'Admin', status: 'active', takeover_email: null, onboarding_completed_at: null })
        if (profileError) throw profileError
        const { error: assignmentError } = await admin.rpc('admin_assign_user_role', { p_user_id: replacementId, p_role_key: 'academic_admin', p_department_id: departmentId, p_granted_by: callerId })
        if (assignmentError) throw assignmentError
        await admin.from('audit_logs').insert({ actor_id: callerId, action: 'user.created', entity_type: 'profiles', entity_id: replacementId, after_data: { role: 'academic_admin', scope_id: departmentId, takeover_for: 'department_admin_deletion' } })
        createdTakeovers.push({ departmentId, email })
      } catch (cause) {
        await rollbackTakeovers()
        return json({ error: cause instanceof Error ? cause.message : `Could not finish creating the takeover account for ${email}.` }, 400)
      }
    }

    const deletedUserIds: string[] = []
    const failed: { userId: string; error: string }[] = []
    const linkedRecordsDeletedUserIds: string[] = []
    for (const userId of userIds) {
      if (systemAdminRole) {
        const { data: assignment, error: assignmentError } = await admin.from('user_roles').select('user_id').eq('user_id', userId).eq('role_id', systemAdminRole.id).maybeSingle()
        if (assignmentError) { failed.push({ userId, error: assignmentError.message }); continue }
        if (assignment) {
          const { data: assignments, error: adminsError } = await admin.from('user_roles').select('user_id').eq('role_id', systemAdminRole.id)
          if (adminsError) { failed.push({ userId, error: adminsError.message }); continue }
          const adminIds = [...new Set((assignments ?? []).map((row) => row.user_id))]
          const { count, error: activeCountError } = await admin.from('profiles').select('id', { count: 'exact', head: true }).in('id', adminIds).eq('status', 'active')
          if (activeCountError) { failed.push({ userId, error: activeCountError.message }); continue }
          const { data: targetProfile, error: targetProfileError } = await admin.from('profiles').select('status').eq('id', userId).maybeSingle()
          if (targetProfileError) { failed.push({ userId, error: targetProfileError.message }); continue }
          if (targetProfile?.status === 'active' && (count ?? 0) <= 1) {
            failed.push({ userId, error: 'The last active System Admin account must remain available.' })
            continue
          }
        }
      }
      if (body.forceDeleteLinkedRecords === true) {
        const { data: linkedBackups, error: backupsError } = await admin
          .from('backups')
          .select('storage_path')
          .eq('created_by', userId)
          .not('storage_path', 'is', null)
        if (backupsError) {
          failed.push({ userId, error: backupsError.message })
          continue
        }
        const backupPaths = [...new Set((linkedBackups ?? []).map((backup) => backup.storage_path).filter((path): path is string => typeof path === 'string' && path.length > 0))]
        let storageCleanupFailed = false
        for (let index = 0; index < backupPaths.length; index += 100) {
          const { error: storageError } = await admin.storage.from('apms-backups').remove(backupPaths.slice(index, index + 100))
          if (storageError) {
            failed.push({ userId, error: `Could not remove linked backup files: ${storageError.message}` })
            storageCleanupFailed = true
            break
          }
        }
        if (storageCleanupFailed) continue

        const { data: deletedLinkedRecordCount, error: linkedRecordsError } = await admin.rpc('admin_purge_profile_restrict_references', { p_user_id: userId, p_force_delete_linked_records: true })
        if (linkedRecordsError) {
          failed.push({ userId, error: linkedRecordsError.message })
          continue
        }
        if (Number(deletedLinkedRecordCount) > 0) linkedRecordsDeletedUserIds.push(userId)
      }
      const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
      if (deleteError) {
        failed.push({ userId, error: deleteError.message })
        continue
      }
      deletedUserIds.push(userId)
      await admin.from('audit_logs').insert({ actor_id: callerId === userId ? null : callerId, action: 'user.deleted', entity_type: 'profiles', entity_id: userId, after_data: { deleted: true, force_deleted_without_takeover: forcedAcademicAdminIds.has(userId), force_deleted_linked_records: body.forceDeleteLinkedRecords === true } })
    }
    const deletedUserIdSet = new Set(deletedUserIds)
    const forcedDepartments = forcedTakeoverDepartments
      .filter(([, admins]) => admins.every((id) => deletedUserIdSet.has(id)))
      .map(([departmentId]) => departmentId)
    return json({ deletedUserIds, failed, createdTakeovers, forcedDepartments, linkedRecordsDeletedUserIds })
  }

  return json({ error: 'Unsupported action' }, 400)
})
