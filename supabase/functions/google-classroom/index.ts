import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'npm:jose@5.9.6'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
const GOOGLE_API = 'https://classroom.googleapis.com/v1'
const PAGE_SIZE = 100
const MAX_GOOGLE_CALLS_PER_RUN = 70
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>()

type Body = {
  action?: string
  classId?: string
  courseId?: string
  courseworkId?: string
  assessmentId?: string
  sourceMin?: number
  sourceMax?: number
  targetMin?: number
  targetMax?: number
}
type Link = { class_record_id: string; google_course_id: string; google_course_name: string; google_account_email: string; linked_by: string | null; status: string; push_registration_id: string | null; push_registered_until: string | null }

const requiredEnv = (name: string) => {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Google Classroom integration is not configured (${name}).`)
  return value
}
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value))
const unb64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const utf8 = new TextEncoder()

async function tokenKey() {
  const material = utf8.encode(requiredEnv('GOOGLE_CLASSROOM_TOKEN_ENCRYPTION_KEY'))
  if (material.byteLength < 32) throw new Error('GOOGLE_CLASSROOM_TOKEN_ENCRYPTION_KEY must contain at least 32 characters.')
  const digest = await crypto.subtle.digest('SHA-256', material)
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encryptToken(token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(), utf8.encode(token))
  return { ciphertext: b64(new Uint8Array(encrypted)), iv: b64(iv) }
}
async function decryptToken(row: { refresh_token_ciphertext: string; refresh_token_iv: string }) {
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.refresh_token_iv) }, await tokenKey(), unb64(row.refresh_token_ciphertext))
  return new TextDecoder().decode(decrypted)
}

function supabaseClients() {
  const url = requiredEnv('SUPABASE_URL')
  const service = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? ''
  return {
    admin: createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } }),
    user: createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } }),
    service,
  }
}

function safeAppOrigin(value: string | null | undefined) {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed.origin !== value || (!localHttp && parsed.protocol !== 'https:')) return ''
    return parsed.origin
  } catch { return '' }
}

function allowedAppOrigins() {
  return new Set((Deno.env.get('APMS_ALLOWED_APP_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && safeAppOrigin(value) === value))
}

function trustedAppOrigin(value: string | null | undefined) {
  const origin = safeAppOrigin(value)
  return origin && allowedAppOrigins().has(origin) ? origin : ''
}

function callbackPage(message: string, success = false, requestedOrigin?: string | null) {
  // Only send the OAuth result to an explicitly allowed APMS origin.
  const safeOrigin = trustedAppOrigin(requestedOrigin)
  const type = success ? 'apms-google-classroom-connected' : 'apms-google-classroom-error'
  const safeMessage = JSON.stringify(message)
  const returnLink = safeOrigin ? `<a href="${safeOrigin}/">Return to APMS</a>` : ''
  const notifyOpener = safeOrigin ? `if(window.opener){window.opener.postMessage({type:${JSON.stringify(type)},message:${safeMessage}},${JSON.stringify(safeOrigin)});window.close()}` : ''
  return new Response(`<!doctype html><meta charset="utf-8"><title>Google Classroom</title><main style="font:16px system-ui;max-width:520px;margin:12vh auto;padding:24px;text-align:center"><h2>${success ? 'Google Classroom connected' : 'Could not connect Google Classroom'}</h2><p>${message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>${returnLink}</main><script>${notifyOpener}</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

async function handleOAuthCallback(request: Request) {
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  let callbackOrigin: string | null = null
  if (url.searchParams.has('error')) {
    if (state) {
      try {
        const { admin } = supabaseClients()
        const { data } = await admin.from('google_classroom_oauth_states').select('app_origin').eq('state', state).maybeSingle()
        callbackOrigin = data?.app_origin ?? null
        await admin.from('google_classroom_oauth_states').delete().eq('state', state)
      } catch { /* Show the cancellation even if state cleanup is unavailable. */ }
    }
    return callbackPage('Google authorization was cancelled or denied.', false, callbackOrigin)
  }
  const code = url.searchParams.get('code')
  if (!code || !state) return callbackPage('The authorization response is incomplete.')
  try {
    const { admin } = supabaseClients()
    const { data: stateRow, error: stateError } = await admin.from('google_classroom_oauth_states').select('user_id,app_origin,expires_at').eq('state', state).maybeSingle()
    callbackOrigin = stateRow?.app_origin ?? null
    await admin.from('google_classroom_oauth_states').delete().eq('state', state)
    if (stateError || !stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) return callbackPage('This authorization link expired. Return to APMS and connect again.', false, callbackOrigin)
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: requiredEnv('GOOGLE_CLASSROOM_CLIENT_ID'), client_secret: requiredEnv('GOOGLE_CLASSROOM_CLIENT_SECRET'), redirect_uri: requiredEnv('GOOGLE_CLASSROOM_REDIRECT_URI'), grant_type: 'authorization_code' }),
    })
    const tokens = await response.json().catch(() => ({}))
    if (!response.ok || typeof tokens.access_token !== 'string') return callbackPage('Google could not complete authorization. Return to APMS and try again.', false, stateRow.app_origin)
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(' ') : []
    const neededScopes = ['https://www.googleapis.com/auth/classroom.courses.readonly', 'https://www.googleapis.com/auth/classroom.rosters.readonly', 'https://www.googleapis.com/auth/classroom.coursework.students.readonly', 'https://www.googleapis.com/auth/classroom.push-notifications']
    if (neededScopes.some((scope) => !scopes.includes(scope))) return callbackPage('Google did not grant all read-only Classroom permissions. Reconnect and approve the requested permissions.', false, stateRow.app_origin)
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } })
    const profile = await profileResponse.json().catch(() => ({}))
    if (!profileResponse.ok || typeof profile.email !== 'string' || profile.email_verified !== true) return callbackPage('Google could not verify the connected account email.', false, stateRow.app_origin)
    let refreshToken = tokens.refresh_token
    if (typeof refreshToken !== 'string') {
      const { data: existing } = await admin.from('google_classroom_connections').select('refresh_token_ciphertext,refresh_token_iv').eq('user_id', stateRow.user_id).maybeSingle()
      if (existing) refreshToken = await decryptToken(existing)
    }
    if (typeof refreshToken !== 'string') return callbackPage('Google did not return a refresh token. Revoke APMS access in your Google Account, then try connecting again.', false, stateRow.app_origin)
    const encrypted = await encryptToken(refreshToken)
    const { error } = await admin.from('google_classroom_connections').upsert({ user_id: stateRow.user_id, google_email: profile.email.toLowerCase(), refresh_token_ciphertext: encrypted.ciphertext, refresh_token_iv: encrypted.iv, granted_scopes: scopes, connected_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) throw new Error('The secured Google connection could not be saved.')
    return callbackPage(`Connected as ${profile.email}. Return to APMS to link a class.`, true, stateRow.app_origin)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Google Classroom connection failed.'
    return callbackPage(message.slice(0, 300), false, callbackOrigin)
  }
}

async function requireAssignedFaculty(admin: any, userId: string, classId: string) {
  const [{ data: profile }, { data: assignments, error }] = await Promise.all([
    admin.from('profiles').select('id,status').eq('id', userId).maybeSingle(),
    admin.from('faculty_assignments').select('class_record_id,faculty_profiles!inner(profile_id,status)').eq('class_record_id', classId).eq('status', 'active').eq('faculty_profiles.profile_id', userId).eq('faculty_profiles.status', 'active'),
  ])
  if (error) throw new Error('Class access could not be verified.')
  if (profile?.status !== 'active' || !assignments?.length) throw new Error('Only a faculty member assigned to this class can manage its Classroom link.')
}

async function getConnection(admin: any, userId: string) {
  const { data, error } = await admin.from('google_classroom_connections').select('*').eq('user_id', userId).maybeSingle()
  if (error) throw new Error('The Google Classroom connection could not be loaded.')
  if (!data) throw new Error('Connect a Google Classroom account first.')
  return data
}

async function refreshGoogleAccess(admin: any, userId: string, force = false) {
  const cached = accessTokenCache.get(userId)
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return { accessToken: cached.token, connection: null }
  const connection = await getConnection(admin, userId)
  const refreshToken = await decryptToken(connection)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: requiredEnv('GOOGLE_CLASSROOM_CLIENT_ID'), client_secret: requiredEnv('GOOGLE_CLASSROOM_CLIENT_SECRET'), refresh_token: refreshToken, grant_type: 'refresh_token' }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || typeof result.access_token !== 'string') {
    if (result.error === 'invalid_grant') {
      await admin.from('google_classroom_connections').delete().eq('user_id', userId)
      await admin.from('google_classroom_class_links').update({ status: 'error', last_error: 'Google authorization expired or was revoked. Reconnect the account.' }).eq('linked_by', userId)
      throw new Error('Google authorization expired or was revoked. Reconnect the account.')
    }
    throw new Error('Google could not refresh the connection. Try reconnecting the account.')
  }
  accessTokenCache.set(userId, { token: result.access_token, expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000 })
  return { accessToken: result.access_token as string, connection }
}

function retryable(status: number) { return status === 429 || status >= 500 }
async function googleRequest(admin: any, userId: string, url: string, init: RequestInit = {}, budget?: { calls: number; max: number }) {
  let { accessToken } = await refreshGoogleAccess(admin, userId)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (budget && budget.calls >= budget.max) throw new Error('Google Classroom sync request budget reached; APMS will continue on the next scheduled sync.')
    if (budget) budget.calls += 1
    const response = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${accessToken}` } })
    if (response.status === 401 && attempt === 0) {
      const refreshed = await refreshGoogleAccess(admin, userId, true)
      accessToken = refreshed.accessToken
      continue
    }
    if (response.ok) return response.json()
    const payload = await response.json().catch(() => ({}))
    if (retryable(response.status) && attempt < 4) {
      const retryAfter = Number(response.headers.get('Retry-After'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : Math.min(1000 * (2 ** attempt) + Math.random() * 1000, 30_000)
      await new Promise((resolve) => setTimeout(resolve, delay))
      continue
    }
    if (response.status === 403) throw new Error('Google denied access. Confirm that the connected account is a teacher in this Classroom course and has granted APMS the required read-only permissions.')
    if (response.status === 404) throw new Error('The Google Classroom course, coursework, or submission no longer exists or is no longer available.')
    if (response.status === 429 || payload?.error?.status === 'RESOURCE_EXHAUSTED') throw new Error('Google Classroom is rate limiting requests. APMS will retry during the next sync.')
    const googleMessage = typeof payload?.error?.message === 'string' ? payload.error.message : ''
    throw new Error(googleMessage ? `Google Classroom request failed: ${googleMessage.slice(0, 240)}` : `Google Classroom request failed (${response.status}).`)
  }
  throw new Error('Google Classroom is temporarily unavailable. APMS will retry during the next sync.')
}

async function listAllGooglePages(admin: any, userId: string, url: string, collection: string, maxPages = 100, budget?: { calls: number; max: number }) {
  const rows: any[] = []
  let pageToken = ''
  for (let page = 0; page < maxPages; page += 1) {
    const pageUrl = new URL(url)
    pageUrl.searchParams.set('pageSize', String(PAGE_SIZE))
    if (pageToken) pageUrl.searchParams.set('pageToken', pageToken)
    const payload = await googleRequest(admin, userId, pageUrl.toString(), {}, budget)
    rows.push(...(Array.isArray(payload?.[collection]) ? payload[collection] : []))
    pageToken = typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : ''
    if (!pageToken) return rows
  }
  throw new Error(`The Google Classroom response is too large to safely load (${maxPages * PAGE_SIZE} records). Retry the operation or narrow its scope.`)
}

async function getCourse(admin: any, userId: string, courseId: string) {
  return googleRequest(admin, userId, `${GOOGLE_API}/courses/${encodeURIComponent(courseId)}`)
}

async function refreshStudentLinks(admin: any, userId: string, link: Link, budget?: { calls: number; max: number }) {
  const [googleStudents, { data: enrollments, error: enrollmentError }] = await Promise.all([
    listAllGooglePages(admin, userId, `${GOOGLE_API}/courses/${encodeURIComponent(link.google_course_id)}/students`, 'students', 100, budget),
    admin.from('enrollments').select('id,students!inner(email)').eq('class_record_id', link.class_record_id).eq('status', 'active'),
  ])
  if (enrollmentError) throw new Error('APMS class roster could not be loaded.')
  const byEmail = new Map<string, string>()
  for (const enrollment of enrollments ?? []) {
    const student = Array.isArray(enrollment.students) ? enrollment.students[0] : enrollment.students
    const email = String(student?.email ?? '').trim().toLowerCase()
    if (email && !byEmail.has(email)) byEmail.set(email, enrollment.id)
  }
  const rows = googleStudents.filter((student) => typeof student?.userId === 'string').map((student) => {
    const email = typeof student.profile?.emailAddress === 'string' ? student.profile.emailAddress.trim().toLowerCase() : null
    const enrollmentId = email ? byEmail.get(email) ?? null : null
    return { class_record_id: link.class_record_id, google_user_id: student.userId, google_email: email, enrollment_id: enrollmentId, matched_at: enrollmentId ? new Date().toISOString() : null, updated_at: new Date().toISOString() }
  })
  for (let offset = 0; offset < rows.length; offset += 500) {
    const { error } = await admin.from('google_classroom_student_links').upsert(rows.slice(offset, offset + 500), { onConflict: 'class_record_id,google_user_id' })
    if (error) throw new Error('Student identities could not be matched to the APMS roster.')
  }
  return rows
}

async function saveSubmissionResults(admin: any, userId: string, link: Link, assessmentLink: any, submissions: any[], budget?: { calls: number; max: number }) {
  const userIds = [...new Set(submissions.map((item) => item.userId).filter((value) => typeof value === 'string'))]
  let identityRows: any[] = []
  if (userIds.length) {
    const { data, error } = await admin.from('google_classroom_student_links').select('google_user_id,enrollment_id').eq('class_record_id', link.class_record_id).in('google_user_id', userIds)
    if (error) throw new Error('Classroom student mapping could not be loaded.')
    identityRows = data ?? []
    const missing = userIds.filter((id) => !identityRows.some((row) => row.google_user_id === id))
    if (missing.length) {
      await refreshStudentLinks(admin, userId, link, budget)
      const { data: refreshed, error: refreshError } = await admin.from('google_classroom_student_links').select('google_user_id,enrollment_id').eq('class_record_id', link.class_record_id).in('google_user_id', userIds)
      if (refreshError) throw new Error('Classroom student mapping could not be refreshed.')
      identityRows = refreshed ?? []
    }
  }
  const identityMap = new Map(identityRows.map((row) => [row.google_user_id, row.enrollment_id]))
  const updates: any[] = []
  const removals: string[] = []
  let unmatched = 0
  for (const submission of submissions) {
    const enrollmentId = identityMap.get(submission.userId)
    if (!enrollmentId) { unmatched += 1; continue }
    const assigned = Number(submission.assignedGrade)
    if (submission.assignedGrade == null || !Number.isFinite(assigned)) { removals.push(enrollmentId); continue }
    const sourceMin = Number(assessmentLink.source_min_score)
    const sourceMax = Number(assessmentLink.source_max_score)
    const targetMin = Number(assessmentLink.target_min_score)
    const targetMax = Number(assessmentLink.target_max_score)
    const ratio = Math.min(1, Math.max(0, (assigned - sourceMin) / (sourceMax - sourceMin)))
    const mapped = Math.round((targetMin + ratio * (targetMax - targetMin)) * 100) / 100
    updates.push({ assessment_id: assessmentLink.assessment_id, enrollment_id: enrollmentId, score: mapped, source: 'google_classroom', approval_status: 'approved', recorded_by: link.linked_by })
  }
  if (updates.length && !link.linked_by) throw new Error('Reconnect this Classroom link from an assigned faculty account before syncing grades.')
  const enrollmentIds = [...new Set(updates.map((item) => item.enrollment_id))]
  let existingRows: any[] = []
  for (let offset = 0; offset < enrollmentIds.length; offset += 500) {
    const { data, error } = await admin.from('assessment_results').select('enrollment_id,score,source').eq('assessment_id', assessmentLink.assessment_id).in('enrollment_id', enrollmentIds.slice(offset, offset + 500))
    if (error) throw new Error('Existing APMS scores could not be checked before synchronization.')
    existingRows.push(...(data ?? []))
  }
  const existingByEnrollment = new Map(existingRows.map((row) => [row.enrollment_id, row]))
  const changedUpdates = updates.filter((row) => {
    const existing = existingByEnrollment.get(row.enrollment_id)
    return !existing || Math.abs(Number(existing.score) - row.score) >= 0.005
  })
  let synced = updates.length - changedUpdates.length
  let failed = 0
  const updateBatch = async (batch: any[]) => {
    const { error } = await admin.from('assessment_results').upsert(batch, { onConflict: 'assessment_id,enrollment_id' })
    if (!error) { synced += batch.length; return }
    if (batch.length > 1) {
      const middle = Math.ceil(batch.length / 2)
      await updateBatch(batch.slice(0, middle))
      await updateBatch(batch.slice(middle))
    } else {
      failed += 1
    }
  }
  for (let i = 0; i < changedUpdates.length; i += 100) await updateBatch(changedUpdates.slice(i, i + 100))
  for (const enrollmentId of removals) {
    if (!link.linked_by) { failed += 1; continue }
    const { error } = await admin.from('assessment_results').delete().eq('assessment_id', assessmentLink.assessment_id).eq('enrollment_id', enrollmentId).eq('source', 'google_classroom')
    if (error) failed += 1
  }
  return { synced, failed, unmatched, removed: removals.length - failed }
}

async function syncAssessment(admin: any, link: Link, assessmentLink: any, submissionId: string | null, budget: { calls: number; max: number }) {
  const url = submissionId
    ? `${GOOGLE_API}/courses/${encodeURIComponent(link.google_course_id)}/courseWork/${encodeURIComponent(assessmentLink.google_coursework_id)}/studentSubmissions/${encodeURIComponent(submissionId)}`
    : `${GOOGLE_API}/courses/${encodeURIComponent(link.google_course_id)}/courseWork/${encodeURIComponent(assessmentLink.google_coursework_id)}/studentSubmissions`
  let rows: any[] = []
  if (submissionId) {
    if (budget.calls >= budget.max) return { deferred: true, synced: 0, failed: 0, unmatched: 0, removed: 0 }
    rows = [await googleRequest(admin, link.linked_by!, url, {}, budget)]
  } else {
    let pageToken = assessmentLink.sync_page_token ?? ''
    let nextToken = pageToken
    let deferred = false
    do {
      if (budget.calls >= budget.max) { deferred = true; break }
      const pageUrl = new URL(url)
      pageUrl.searchParams.set('pageSize', String(PAGE_SIZE))
      if (pageToken) pageUrl.searchParams.set('pageToken', pageToken)
      const payload = await googleRequest(admin, link.linked_by!, pageUrl.toString(), {}, budget)
      rows.push(...(Array.isArray(payload?.studentSubmissions) ? payload.studentSubmissions : []))
      nextToken = typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : ''
      pageToken = nextToken
    } while (nextToken && budget.calls < budget.max)
    const result = await saveSubmissionResults(admin, link.linked_by!, link, assessmentLink, rows, budget)
    await admin.from('google_classroom_assessment_links').update({ sync_page_token: nextToken || null }).eq('id', assessmentLink.id)
    return { ...result, deferred: deferred || Boolean(nextToken), complete: !deferred && !nextToken }
  }
  const result = await saveSubmissionResults(admin, link.linked_by!, link, assessmentLink, rows, budget)
  return { ...result, deferred: false, complete: true }
}

async function registerPush(admin: any, userId: string, link: Link, budget?: { calls: number; max: number }) {
  const topicName = Deno.env.get('GOOGLE_CLASSROOM_PUBSUB_TOPIC')
  if (!topicName) return { ok: false, message: 'Automatic push sync is not configured; APMS will use the scheduled sync.' }
  try {
    const registration = await googleRequest(admin, userId, `${GOOGLE_API}/registrations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed: { feedType: 'COURSE_WORK_CHANGES', courseWorkChangesInfo: { courseId: link.google_course_id } }, cloudPubsubTopic: { topicName } }),
    }, budget)
    await admin.from('google_classroom_class_links').update({ push_registration_id: registration.registrationId, push_registered_until: registration.expiryTime, last_error: null }).eq('class_record_id', link.class_record_id)
    return { ok: true }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Push notifications could not be registered.'
    await admin.from('google_classroom_class_links').update({ last_error: message.slice(0, 500) }).eq('class_record_id', link.class_record_id)
    return { ok: false, message }
  }
}

async function syncClass(admin: any, link: Link, targetCourseworkId?: string, submissionId?: string, budget = { calls: 0, max: MAX_GOOGLE_CALLS_PER_RUN }) {
  if (!link.linked_by) throw new Error('Reconnect this Classroom link from an assigned faculty account before syncing grades.')
  const { data: assessmentLinks, error } = await admin.from('google_classroom_assessment_links').select('*').eq('class_record_id', link.class_record_id).eq('enabled', true).order('created_at')
  if (error) throw new Error('The linked APMS assessments could not be loaded.')
  const targets = (assessmentLinks ?? []).filter((row: any) => !targetCourseworkId || row.google_coursework_id === targetCourseworkId)
  let synced = 0, failed = 0, unmatched = 0, removed = 0, deferred = false
  for (const target of targets) {
    const result = await syncAssessment(admin, link, target, submissionId ?? null, budget)
    synced += result.synced; failed += result.failed; unmatched += result.unmatched; removed += result.removed
    deferred ||= result.deferred
    await admin.from('google_classroom_assessment_links').update({ last_synced_at: new Date().toISOString(), last_error: result.failed ? `${result.failed} grade update(s) were rejected, often because an APMS grade deadline has passed.` : null }).eq('id', target.id)
  }
  const completionTime = new Date().toISOString()
  await admin.from('google_classroom_class_links').update({ last_synced_at: completionTime, last_error: failed ? `${failed} grade update(s) failed. Check APMS grade deadlines and sync status.` : deferred ? 'Sync is continuing in the next scheduled run.' : null }).eq('class_record_id', link.class_record_id)
  return { synced, failed, unmatched, removed, deferred, apiCalls: budget.calls, registered: false }
}

async function ownerCanSync(admin: any, link: Link) {
  if (!link.linked_by) return false
  const [{ data: profile }, { data: assignments, error }] = await Promise.all([
    admin.from('profiles').select('status').eq('id', link.linked_by).maybeSingle(),
    admin.from('faculty_assignments').select('class_record_id,faculty_profiles!inner(profile_id,status)').eq('class_record_id', link.class_record_id).eq('status', 'active').eq('faculty_profiles.profile_id', link.linked_by).eq('faculty_profiles.status', 'active'),
  ])
  return !error && profile?.status === 'active' && Boolean(assignments?.length)
}

async function verifyPubSub(request: Request) {
  const audience = requiredEnv('GOOGLE_CLASSROOM_PUBSUB_AUDIENCE')
  const serviceEmail = requiredEnv('GOOGLE_CLASSROOM_PUBSUB_SERVICE_ACCOUNT')
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) throw new Error('Push subscription identity is missing.')
  const { payload } = await jwtVerify(authorization.slice(7), jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience })
  if (payload.email !== serviceEmail || payload.email_verified !== true) throw new Error('Push subscription identity is not authorized.')
}

async function handlePush(request: Request) {
  await verifyPubSub(request)
  const body = await request.json().catch(() => null)
  const encoded = body?.message?.data
  if (typeof encoded !== 'string') return new Response(null, { status: 204 })
  let event: any
  try { event = JSON.parse(new TextDecoder().decode(unb64(encoded))) } catch { return new Response(null, { status: 204 }) }
  const courseId = event?.resourceId?.courseId
  if (typeof courseId !== 'string') return new Response(null, { status: 204 })
  const { admin } = supabaseClients()
  const { data: link } = await admin.from('google_classroom_class_links').select('*').eq('google_course_id', courseId).eq('status', 'active').maybeSingle()
  if (!link) return new Response(null, { status: 204 })
  if (!await ownerCanSync(admin, link)) {
    await admin.from('google_classroom_class_links').update({ status: 'paused', last_error: 'The connecting faculty account is inactive or no longer assigned to this class.' }).eq('class_record_id', link.class_record_id)
    return new Response(null, { status: 204 })
  }
  const collection = event.collection
  if (collection !== 'courses.courseWork.studentSubmissions' && collection !== 'courses.courseWork') return new Response(null, { status: 204 })
  const courseworkId = event?.resourceId?.courseWorkId ?? event?.resourceId?.id
  const submissionId = collection === 'courses.courseWork.studentSubmissions' ? event?.resourceId?.id : undefined
  try {
    const summary = await syncClass(admin, link, typeof courseworkId === 'string' ? courseworkId : undefined, typeof submissionId === 'string' ? submissionId : undefined)
    return json({ received: true, ...summary })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Google Classroom sync failed.'
    const authRevoked = /authorization expired|authorization was revoked/i.test(message)
    await admin.from('google_classroom_class_links').update({ status: authRevoked ? 'error' : 'active', last_error: message.slice(0, 500) }).eq('class_record_id', link.class_record_id)
    return json({ error: message }, 500)
  }
}

async function handleRequest(request: Request) {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method === 'GET') return await handleOAuthCallback(request)
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const authorization = request.headers.get('Authorization')
    if (request.headers.has('ce-type') || request.headers.has('ce-id')) return await handlePush(request)
    try {
      const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (bearerToken && (decodeJwt(bearerToken).iss === 'https://accounts.google.com' || decodeJwt(bearerToken).iss === 'accounts.google.com')) return await handlePush(request)
    } catch { /* Supabase access tokens are verified below. */ }
    const { admin, user, service } = supabaseClients()
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const isScheduled = token === service || request.headers.get('apikey') === service
    if (isScheduled) {
      const input = await request.json().catch(() => ({}))
      if (input.action !== 'scheduled') return json({ error: 'Unsupported scheduled operation' }, 400)
      const { data: links, error } = await admin.from('google_classroom_class_links').select('*').in('status', ['active', 'paused']).order('last_synced_at', { ascending: true, nullsFirst: true }).limit(1000)
      if (error) return json({ error: 'Scheduled Classroom links could not be loaded.' }, 500)
      const results = []
      const budget = { calls: 0, max: MAX_GOOGLE_CALLS_PER_RUN }
      for (const link of links ?? []) {
        if (!link.linked_by) continue
        if (budget.calls >= budget.max) break
        if (!await ownerCanSync(admin, link)) {
          await admin.from('google_classroom_class_links').update({ status: 'paused', last_error: 'The connecting faculty account is inactive or no longer assigned to this class.' }).eq('class_record_id', link.class_record_id)
          continue
        }
        if (link.status === 'paused') await admin.from('google_classroom_class_links').update({ status: 'active', last_error: null }).eq('class_record_id', link.class_record_id)
        try {
          const expiry = link.push_registered_until ? new Date(link.push_registered_until).getTime() : 0
          if (expiry < Date.now() + 24 * 60 * 60 * 1000) await registerPush(admin, link.linked_by, link, budget)
          results.push({ classId: link.class_record_id, ...(await syncClass(admin, link, undefined, undefined, budget)) })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Classroom sync failed.'
          const invalidGrant = /authorization expired|authorization was revoked/i.test(message)
          await admin.from('google_classroom_class_links').update({ status: invalidGrant ? 'error' : 'active', last_error: message.slice(0, 500) }).eq('class_record_id', link.class_record_id)
          results.push({ classId: link.class_record_id, error: message })
        }
      }
      return json({ processed: results.length, results })
    }
    if (!token) return json({ error: 'Authentication required' }, 401)
    const { data: auth, error: authError } = await user.auth.getUser(token)
    if (authError || !auth.user) return json({ error: 'Invalid session' }, 401)
    let input: Body
    try { input = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
    const userId = auth.user.id

    if (input.action === 'oauth-start') {
      const state = crypto.randomUUID() + crypto.randomUUID()
      const appOrigin = trustedAppOrigin(request.headers.get('Origin'))
      if (!appOrigin) return json({ error: 'Google Classroom can only be connected from an approved APMS origin.' }, 403)
      const { error } = await admin.from('google_classroom_oauth_states').insert({ state, user_id: userId, app_origin: appOrigin || null, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() })
      if (error) return json({ error: 'Google account authorization could not be started.' }, 500)
      const callback = requiredEnv('GOOGLE_CLASSROOM_REDIRECT_URI')
      const scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/classroom.courses.readonly', 'https://www.googleapis.com/auth/classroom.rosters.readonly', 'https://www.googleapis.com/auth/classroom.coursework.students.readonly', 'https://www.googleapis.com/auth/classroom.push-notifications']
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({ client_id: requiredEnv('GOOGLE_CLASSROOM_CLIENT_ID'), redirect_uri: callback, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state }).toString()
      return json({ authorizationUrl: url.toString() })
    }
    if (input.action === 'oauth-callback') return json({ error: 'This callback is only available through the configured GET redirect.' }, 405)
    if (input.action === 'courses') {
      const { data: connection } = await admin.from('google_classroom_connections').select('google_email').eq('user_id', userId).maybeSingle()
      if (!connection) return json({ connected: false, courses: [] })
      const courses = await listAllGooglePages(admin, userId, `${GOOGLE_API}/courses?teacherId=me&courseStates=ACTIVE`, 'courses', 25)
      return json({ connected: true, email: connection.google_email, courses: courses.filter((course) => course.courseState === 'ACTIVE').map(({ id, name, section, enrollmentCode }: any) => ({ id, name, section, enrollmentCode })) })
    }
    if (input.action === 'status' || input.action === 'link-class' || input.action === 'coursework' || input.action === 'link-assessment' || input.action === 'unlink-class' || input.action === 'sync') {
      if (!input.classId) return json({ error: 'Select an APMS class first.' }, 400)
      await requireAssignedFaculty(admin, userId, input.classId)
      const { data: classRow, error: classError } = await admin.from('class_records').select('id').eq('id', input.classId).maybeSingle()
      if (classError || !classRow) return json({ error: 'The APMS class could not be found.' }, 404)
      if (input.action === 'status') {
        const [{ data: connection }, { data: link }, { data: assessmentLinks }] = await Promise.all([
          admin.from('google_classroom_connections').select('google_email').eq('user_id', userId).maybeSingle(),
          admin.from('google_classroom_class_links').select('class_record_id,google_course_id,google_course_name,google_account_email,status,last_synced_at,last_error,linked_by').eq('class_record_id', input.classId).maybeSingle(),
          admin.from('google_classroom_assessment_links').select('id,assessment_id,google_coursework_id,google_coursework_title,source_max_score,source_min_score,target_min_score,target_max_score,enabled,last_synced_at,last_error').eq('class_record_id', input.classId).order('created_at'),
        ])
        return json({ connected: Boolean(connection), email: connection?.google_email ?? null, link: link ?? null, assessments: assessmentLinks ?? [] })
      }
      if (input.action === 'link-class') {
        if (typeof input.courseId !== 'string') return json({ error: 'Choose a Google Classroom course.' }, 400)
        const course = await getCourse(admin, userId, input.courseId)
        if (!course?.id || course.courseState !== 'ACTIVE') return json({ error: 'Choose an active Google Classroom course.' }, 400)
        const { data: existingLink, error: existingLinkError } = await admin.from('google_classroom_class_links').select('linked_by,google_course_id,google_course_name').eq('class_record_id', input.classId).maybeSingle()
        if (existingLinkError) return json({ error: 'The existing Classroom link could not be checked.' }, 500)
        if (existingLink && (existingLink.linked_by !== userId || existingLink.google_course_id !== course.id)) return json({ error: `This APMS class is already linked to ${existingLink.google_course_name}. Unlink it before choosing another course.` }, 409)
        const connection = await getConnection(admin, userId)
        const row = { class_record_id: input.classId, google_course_id: course.id, google_course_name: [course.name, course.section].filter(Boolean).join(' · '), google_account_email: connection.google_email, linked_by: userId, status: 'active', last_error: null }
        const { data: saved, error } = await admin.from('google_classroom_class_links').upsert(row, { onConflict: 'class_record_id' }).select('*').single()
        if (error) return json({ error: error.code === '23505' ? 'That Google Classroom course is already linked to another APMS class.' : 'The class link could not be saved.' }, 409)
        await refreshStudentLinks(admin, userId, saved)
        const push = await registerPush(admin, userId, saved)
        return json({ link: saved, push })
      }
      const { data: link, error: linkError } = await admin.from('google_classroom_class_links').select('*').eq('class_record_id', input.classId).maybeSingle()
      if (linkError) return json({ error: 'Class link could not be loaded.' }, 500)
      if (!link) return json({ error: 'Link this APMS class to Google Classroom first.' }, 409)
      if (link.linked_by !== userId) return json({ error: 'Only the faculty member who connected this Google account can change its link. Ask them to reconnect or unlink it first.' }, 403)
      if (input.action === 'unlink-class') {
        if (link.push_registration_id) {
          try { await googleRequest(admin, userId, `${GOOGLE_API}/registrations/${encodeURIComponent(link.push_registration_id)}`, { method: 'DELETE' }) }
          catch { /* Registration expiry is bounded; unlinking APMS must still succeed. */ }
        }
        const { error } = await admin.from('google_classroom_class_links').delete().eq('class_record_id', input.classId)
        if (error) return json({ error: 'The class link could not be removed.' }, 500)
        return json({ unlinked: true })
      }
      if (input.action === 'coursework') {
        const items = await listAllGooglePages(admin, userId, `${GOOGLE_API}/courses/${encodeURIComponent(link.google_course_id)}/courseWork?courseWorkStates=PUBLISHED`, 'courseWork', 25)
        return json({ coursework: items.map((item) => ({ id: item.id, title: item.title, maxPoints: item.maxPoints ?? 0, state: item.state })) })
      }
      if (input.action === 'link-assessment') {
        if (!input.assessmentId || !input.courseworkId) return json({ error: 'Choose an APMS assessment and Google Classroom coursework.' }, 400)
        const { data: assessment, error: assessmentError } = await admin.from('assessments').select('id,class_record_id,title,maximum_score').eq('id', input.assessmentId).eq('class_record_id', input.classId).maybeSingle()
        if (assessmentError || !assessment) return json({ error: 'The APMS assessment does not belong to this class.' }, 400)
        const coursework = await googleRequest(admin, userId, `${GOOGLE_API}/courses/${encodeURIComponent(link.google_course_id)}/courseWork/${encodeURIComponent(input.courseworkId)}`)
        const sourceMax = Number(coursework.maxPoints)
        if (!Number.isFinite(sourceMax) || sourceMax <= 0) return json({ error: 'This Google Classroom coursework has no positive maximum score. Only graded coursework can be linked.' }, 400)
        const sourceMin = input.sourceMin ?? 0
        const sourceLimit = input.sourceMax ?? sourceMax
        const targetMin = input.targetMin ?? 0
        const targetMax = input.targetMax ?? Number(assessment.maximum_score)
        if (![sourceMin, sourceLimit, targetMin, targetMax].every(Number.isFinite) || sourceMin < 0 || sourceLimit <= sourceMin || sourceLimit > sourceMax || targetMin < 0 || targetMax <= targetMin || targetMax > Number(assessment.maximum_score)) return json({ error: 'Enter valid source and target score ranges within each assessment’s maximum score.' }, 400)
        const { error } = await admin.from('google_classroom_assessment_links').upsert({ class_record_id: input.classId, assessment_id: input.assessmentId, google_course_id: link.google_course_id, google_coursework_id: coursework.id, google_coursework_title: coursework.title, source_max_score: sourceLimit, source_min_score: sourceMin, target_min_score: targetMin, target_max_score: targetMax, enabled: true, last_error: null, sync_page_token: null }, { onConflict: 'assessment_id' })
        if (error) return json({ error: error.code === '23505' ? 'That Google Classroom coursework is already linked to another APMS assessment.' : 'The assessment link could not be saved.' }, 409)
        let initialSync: any
        try {
          initialSync = await syncClass(admin, { ...link, linked_by: userId }, coursework.id)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'The first grade sync could not be completed.'
          initialSync = { error: message, deferred: true, synced: 0, failed: 0, unmatched: 0, removed: 0 }
          await admin.from('google_classroom_assessment_links').update({ last_error: message.slice(0, 500) }).eq('assessment_id', input.assessmentId)
          await admin.from('google_classroom_class_links').update({ status: /authorization expired|authorization was revoked/i.test(message) ? 'error' : 'active', last_error: message.slice(0, 500) }).eq('class_record_id', input.classId)
        }
        return json({ linked: true, initialSync })
      }
      if (input.action === 'sync') {
        try {
          const result = await syncClass(admin, link)
          return json(result)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Google Classroom sync failed.'
          await admin.from('google_classroom_class_links').update({ status: /authorization expired|authorization was revoked/i.test(message) ? 'error' : 'active', last_error: message.slice(0, 500) }).eq('class_record_id', input.classId)
          throw cause
        }
      }
    }
    return json({ error: 'Unsupported Google Classroom operation.' }, 400)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Google Classroom operation failed.'
    const status = /only a faculty|assigned to this class|only the faculty/i.test(message) ? 403 : /connect a Google/i.test(message) ? 409 : /not configured/i.test(message) ? 503 : 400
    return json({ error: message }, status)
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin')
  if (origin && !trustedAppOrigin(origin)) {
    return new Response('Origin is not allowed.', { status: 403, headers: { 'Vary': 'Origin' } })
  }
  const response = await handleRequest(request)
  const headers = new Headers(response.headers)
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Vary', 'Origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
})
