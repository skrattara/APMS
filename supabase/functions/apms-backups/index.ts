import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
const tables = [
  'roles','permissions','departments','academic_terms','programs','subjects','year_levels','profiles','role_permissions','user_roles',
  'faculty_profiles','program_sections','students','class_record_templates','class_records','class_record_versions','invitations','faculty_assignments',
  'enrollments','criteria_sets','criteria_nodes','grading_systems','evaluation_systems','evaluation_criteria_systems','class_evaluation_criteria',
  'faculty_class_evaluation_systems','academic_admin_class_evaluation_systems','user_evaluation_systems','academic_guidelines','assessments',
  'assessment_results','attendance_sessions','attendance_records','grader_assignments','grader_submissions','grader_reviews','model_versions',
  'prediction_criteria','performance_evaluations','prediction_runs','performance_predictions','feedback_templates','feedback_records','notifications',
  'notification_preferences','delivery_attempts','events','integrations','import_jobs','import_job_rows','grade_encoding_deadlines',
  'grade_encoding_deadline_requests','class_requests','subject_requests','program_requests','audit_logs','access_logs','system_logs','ai_model_usage',
  'gradebook_assessment_version_names','gradebook_score_versions','synthetic_data_batches','system_settings',
]
const b64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
const unb64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
async function passwordKey(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
function remapBackupUserIds(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value.toLowerCase()) ?? value
  if (Array.isArray(value)) return value.map((item) => remapBackupUserIds(item, idMap))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapBackupUserIds(item, idMap)]))
  }
  return value
}
async function recreateBackupAuthUsers(admin: any, snapshot: { tables: Record<string, unknown> }, currentUserId: string) {
  const profiles = snapshot.tables.profiles
  if (!Array.isArray(profiles)) return [] as string[]

  const assignments = Array.isArray(snapshot.tables.user_roles) ? snapshot.tables.user_roles as Record<string, unknown>[] : []
  const roleKeys = new Map<string, string>()
  for (const role of (Array.isArray(snapshot.tables.roles) ? snapshot.tables.roles : []) as Record<string, unknown>[]) {
    if (typeof role.id === 'string' && typeof role.key === 'string') roleKeys.set(role.id, role.key)
  }
  const roleByUserId = new Map<string, string>()
  for (const assignment of assignments) {
    const userId = typeof assignment.user_id === 'string' ? assignment.user_id.toLowerCase() : ''
    const roleKey = typeof assignment.role_id === 'string' ? roleKeys.get(assignment.role_id) : undefined
    if (userId && roleKey && ['system_admin', 'academic_admin', 'faculty'].includes(roleKey)) roleByUserId.set(userId, roleKey)
  }

  // Keep the signed-in admin's current profile and permissions intact.
  snapshot.tables.profiles = profiles.filter((profile: any) => typeof profile?.id !== 'string' || profile.id.toLowerCase() !== currentUserId.toLowerCase())
  if (Array.isArray(snapshot.tables.user_roles)) {
    snapshot.tables.user_roles = assignments.filter((assignment) => typeof assignment.user_id !== 'string' || assignment.user_id.toLowerCase() !== currentUserId.toLowerCase())
  }

  const recreated: string[] = []
  const seen = new Set<string>()
  const idMap = new Map<string, string>()
  const findUserByEmail = async (email: string) => {
    for (let page = 1; ; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw new Error(`Could not check for an existing account with ${email}: ${error.message}`)
      const match = data.users.find((user: any) => user.email?.toLowerCase() === email)
      if (match) return match
      if (data.users.length < 1000) return null
    }
  }
  try {
    for (const profile of snapshot.tables.profiles as Record<string, unknown>[]) {
      const userId = typeof profile.id === 'string' ? profile.id : ''
      const oldId = userId.toLowerCase()
      const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : ''
      if (!userId || !email) throw new Error('The backup contains an account profile without a user ID or email address.')
      if (seen.has(oldId)) continue
      seen.add(oldId)

      const { data: existing, error: lookupError } = await admin.auth.admin.getUserById(userId)
      if (existing?.user) {
        idMap.set(oldId, existing.user.id)
        if (typeof existing.user.email === 'string') profile.email = existing.user.email
        if (!existing.user.email_confirmed_at) {
          profile.onboarding_completed_at = null
          if (profile.status === 'invited' || profile.status === 'active') profile.status = 'active'
        }
        continue
      }
      if (lookupError && lookupError.status !== 404) throw new Error(`Could not check the saved account ${email}: ${lookupError.message}`)

      const role = roleByUserId.get(oldId)
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: {
          ...(typeof profile.first_name === 'string' ? { first_name: profile.first_name } : {}),
          ...(typeof profile.last_name === 'string' ? { last_name: profile.last_name } : {}),
        },
        app_metadata: { apms_backup_source_user_id: userId, ...(role ? { apms_role: role } : {}) },
      })
      if (createError || !created.user) {
        const existingByEmail = await findUserByEmail(email)
        const restoredSourceId = existingByEmail?.app_metadata?.apms_backup_source_user_id
        if (!existingByEmail || typeof restoredSourceId !== 'string' || restoredSourceId.toLowerCase() !== oldId) {
          throw new Error(`Could not recreate ${email} without credentials: ${createError?.message ?? 'account creation failed'}`)
        }
        idMap.set(oldId, existingByEmail.id)
        profile.email = existingByEmail.email ?? profile.email
        if (!existingByEmail.email_confirmed_at) {
          profile.onboarding_completed_at = null
          if (profile.status === 'invited' || profile.status === 'active') profile.status = 'active'
        }
        continue
      }
      recreated.push(created.user.id)
      idMap.set(oldId, created.user.id)
      profile.onboarding_completed_at = null
      if (profile.status === 'invited' || profile.status === 'active') profile.status = 'active'
    }
  } catch (cause) {
    for (const userId of recreated) await admin.auth.admin.deleteUser(userId)
    throw cause
  }
  snapshot.tables = remapBackupUserIds(snapshot.tables, idMap) as Record<string, unknown>
  return recreated
}
async function restoreSnapshot(client: any, snapshot: { tables: Record<string, unknown> }) {
  let restoredRows = 0
  for (const table of tables) {
    const records = snapshot.tables[table]
    if (records == null) continue
    if (!Array.isArray(records)) throw new Error(`Invalid row collection for ${table}.`)
    let batch: unknown[] = []
    let batchBytes = 0
    const applyBatch = async () => {
      if (!batch.length) return
      const payload = { format: 'apms-json-backup', tables: { [table]: batch } }
      const { data, error } = await client.rpc('restore_apms_json_backup', { p_data: payload })
      if (error) throw new Error(`Could not restore ${table}: ${error.message}`)
      restoredRows += Number(data?.restored_rows ?? 0)
      batch = []
      batchBytes = 0
    }
    for (const record of records) {
      const recordBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength
      if (recordBytes > 8 * 1024 * 1024) throw new Error(`A record in ${table} exceeds the 8 MB restore limit.`)
      if (batch.length && batchBytes + recordBytes > 2 * 1024 * 1024) await applyBatch()
      batch.push(record)
      batchBytes += recordBytes
    }
    await applyBatch()
  }
  return restoredRows
}
async function generateBackup(admin: any, createdBy: string, password: string | null, scheduleId?: string) {
  const fileName = `apms-backup-${new Date().toISOString().replaceAll(':', '-')}.json`
  const path = `${createdBy}/${crypto.randomUUID()}/${fileName}`
  const { data: backup, error: insertError } = await admin.from('backups').insert({ scope: 'full', status: 'running', created_by: createdBy, file_name: fileName, encryption: password ? 'AES-256-GCM' : 'none', schedule_id: scheduleId ?? null }).select('id').single()
  if (insertError || !backup) throw new Error(insertError?.message ?? 'Backup could not be started')
  try {
    const snapshot: Record<string, unknown> = { format: 'apms-json-backup', version: 1, created_at: new Date().toISOString(), tables: {} }
    const tableData = snapshot.tables as Record<string, unknown[]>
    let estimatedSnapshotBytes = 0
    for (const table of tables) {
      const records: unknown[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin.from(table).select('*').range(from, from + 999)
        if (error) throw new Error(`Could not back up ${table}: ${error.message}`)
        for (const record of data ?? []) {
          estimatedSnapshotBytes += new TextEncoder().encode(JSON.stringify(record)).byteLength
          if (estimatedSnapshotBytes > 40 * 1024 * 1024) throw new Error('This database snapshot exceeds the current 40 MB processing limit.')
        }
        records.push(...(data ?? []))
        if (!data || data.length < 1000) break
        if (records.length > 250_000) throw new Error(`Backup row limit reached while reading ${table}.`)
      }
      tableData[table] = records
    }
    const plain = new TextEncoder().encode(JSON.stringify(snapshot))
    if (plain.byteLength > 40 * 1024 * 1024) throw new Error('This backup exceeds the current 40 MB processing limit.')
    let file: string
    if (password) {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const key = await passwordKey(password, salt)
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
      file = JSON.stringify({ format: 'apms-encrypted-json-backup', version: 1, algorithm: 'PBKDF2-SHA256/AES-256-GCM', iterations: 210000, salt: b64(salt), iv: b64(iv), ciphertext: b64(encrypted) })
    } else {
      file = new TextDecoder().decode(plain)
    }
    const bytes = new TextEncoder().encode(file)
    const checksumBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const checksum = [...checksumBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const { error: uploadError } = await admin.storage.from('apms-backups').upload(path, bytes, { contentType: 'application/json', upsert: false })
    if (uploadError) throw uploadError
    const { error: updateError } = await admin.from('backups').update({ status: 'completed', storage_path: path, checksum, size_bytes: bytes.byteLength, completed_at: new Date().toISOString() }).eq('id', backup.id)
    if (updateError) throw updateError
    await admin.from('audit_logs').insert({ actor_id: createdBy, action: 'backup.created', entity_type: 'backups', entity_id: backup.id, after_data: { size_bytes: bytes.byteLength, checksum, scheduled: Boolean(scheduleId) } })
    return { id: backup.id, fileName, sizeBytes: bytes.byteLength, checksum, path }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Backup creation failed'
    await admin.from('backups').update({ status: 'failed', safe_error: message.slice(0, 500), completed_at: new Date().toISOString() }).eq('id', backup.id)
    throw cause
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  let input: { action?: string; password?: string; storagePath?: string; fileName?: string; backupId?: string }
  try { input = await request.json() } catch { return json({ error: 'Invalid JSON request' }, 400) }
  const authorization = request.headers.get('Authorization')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const schedulerToken = Deno.env.get('BACKUP_SCHEDULER_TOKEN')
  const scheduledCall = input.action === 'scheduled' && (
    (!!schedulerToken && request.headers.get('x-apms-backup-token') === schedulerToken)
    || authorization === `Bearer ${serviceKey}`
  )
  if (!scheduledCall && !authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
  const token = authorization?.slice('Bearer '.length) ?? ''
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const userClient = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: auth, error: authError } = scheduledCall ? { data: { user: null }, error: null } : await userClient.auth.getUser(token)
  if (authError || (!scheduledCall && !auth.user)) return json({ error: 'Invalid session' }, 401)
  if (!scheduledCall) {
    const { data: role } = await admin.from('user_roles').select('roles!inner(key),profiles!user_roles_user_id_fkey!inner(status)').eq('user_id', auth.user!.id).eq('roles.key', 'system_admin').eq('profiles.status', 'active').maybeSingle()
    if (!role) return json({ error: 'Active System Admin permission required' }, 403)
  }

  if (input.action === 'scheduled' && scheduledCall) {
    const configuredPassword = Deno.env.get('BACKUP_ENCRYPTION_KEY') ?? ''
    const password = configuredPassword.length >= 12 ? configuredPassword : null
    const { data: due, error: scheduleError } = await admin.from('backup_schedules').select('*').eq('enabled', true).lte('next_run_at', new Date().toISOString())
    if (scheduleError) return json({ error: scheduleError.message }, 500)
    const results: unknown[] = []
    for (const schedule of due ?? []) {
      const next = new Date()
      if (schedule.frequency === 'daily') next.setUTCDate(next.getUTCDate() + 1)
      else if (schedule.frequency === 'weekly') next.setUTCDate(next.getUTCDate() + 7)
      else next.setUTCMonth(next.getUTCMonth() + 1)
      try {
        const backup = await generateBackup(admin, schedule.created_by, password, schedule.id)
        await admin.from('backup_schedules').update({ last_run_at: new Date().toISOString(), last_backup_id: backup.id, next_run_at: next.toISOString(), updated_at: new Date().toISOString() }).eq('id', schedule.id)
        const cutoff = new Date(Date.now() - Number(schedule.retention_days) * 86_400_000).toISOString()
        const { data: expired } = await admin.from('backups').select('id,storage_path').eq('schedule_id', schedule.id).eq('status', 'completed').lt('created_at', cutoff)
        for (const item of expired ?? []) {
          if (item.storage_path) await admin.storage.from('apms-backups').remove([item.storage_path])
          await admin.from('backups').update({ status: 'deleted', storage_path: null }).eq('id', item.id)
        }
        results.push({ id: backup.id, status: 'completed' })
      } catch (cause) {
        await admin.from('backup_schedules').update({ last_run_at: new Date().toISOString(), next_run_at: next.toISOString(), updated_at: new Date().toISOString() }).eq('id', schedule.id)
        results.push({ scheduleId: schedule.id, status: 'failed', error: cause instanceof Error ? cause.message : 'Backup failed' })
      }
    }
    return json({ processed: results.length, results })
  }
  if (scheduledCall) return json({ error: 'Unsupported scheduled operation' }, 400)

  if (input.action === 'reset_application_data') {
    const callerId = auth.user!.id
    const usersToDelete: { id: string; email: string | null }[] = []
    for (let page = 1; ; page += 1) {
      const { data: authPage, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      if (listError) return json({ error: `Could not list accounts before the reset: ${listError.message}` }, 500)
      usersToDelete.push(...authPage.users.filter((user) => user.id !== callerId).map((user) => ({ id: user.id, email: user.email ?? null })))
      if (authPage.users.length < 1000) break
    }

    const { data: reset, error: resetError } = await admin.rpc('reset_apms_application_data', { p_actor_id: callerId })
    if (resetError) return json({ error: resetError.message }, 500)

    const deletedUserIds: string[] = []
    const failed: { userId: string; email: string | null; error: string }[] = []
    for (let offset = 0; offset < usersToDelete.length; offset += 10) {
      const batch = usersToDelete.slice(offset, offset + 10)
      const results = await Promise.all(batch.map(async (user) => {
        const { error } = await admin.auth.admin.deleteUser(user.id)
        return error ? { ...user, error: error.message } : { ...user, error: null }
      }))
      for (const result of results) {
        if (result.error) failed.push({ userId: result.id, email: result.email, error: result.error })
        else deletedUserIds.push(result.id)
      }
    }

    return json({
      reset: reset?.reset === true,
      deleted_auth_accounts: deletedUserIds.length,
      failed_auth_account_deletions: failed,
    })
  }

  if (input.action === 'create') {
    const password = input.password ?? ''
    if (password.length > 0 && password.length < 12) return json({ error: 'Use a backup password with at least 12 characters, or leave it empty for an unencrypted backup.' }, 400)
    try {
      const backup = await generateBackup(admin, auth.user!.id, password || null)
      const { data: signed, error: signedError } = await admin.storage.from('apms-backups').createSignedUrl(backup.path, 300)
      if (signedError || !signed) throw signedError ?? new Error('Could not create backup download link')
      return json({ id: backup.id, fileName: backup.fileName, sizeBytes: backup.sizeBytes, checksum: backup.checksum, downloadUrl: signed.signedUrl })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Backup creation failed'
      return json({ error: message }, 500)
    }
  }

  if (input.action === 'delete_selected') {
    const backupIds = [...new Set(Array.isArray(input.backupIds) ? input.backupIds.filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) : [])]
    if (!backupIds.length || backupIds.length > 100) return json({ error: 'Select between 1 and 100 backups to delete.' }, 400)
    const deletedIds: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of backupIds) {
      const { data: backup, error: lookupError } = await admin.from('backups').select('status,storage_path').eq('id', id).maybeSingle()
      if (lookupError || !backup) {
        failed.push({ id, error: lookupError?.message ?? 'Backup was not found.' })
        continue
      }
      if (['running', 'queued'].includes(backup.status)) {
        failed.push({ id, error: 'A backup that is still in progress cannot be deleted.' })
        continue
      }
      if (backup.storage_path) {
        const { error: storageError } = await admin.storage.from('apms-backups').remove([backup.storage_path])
        if (storageError) {
          failed.push({ id, error: storageError.message })
          continue
        }
      }
      const { error: updateError } = await admin.from('backups').update({ status: 'deleted', storage_path: null }).eq('id', id)
      if (updateError) {
        failed.push({ id, error: updateError.message })
        continue
      }
      deletedIds.push(id)
    }
    if (deletedIds.length) {
      await admin.from('audit_logs').insert({ actor_id: auth.user!.id, action: 'backup.deleted', entity_type: 'backups', after_data: { backup_ids: deletedIds } })
    }
    return json({ deletedIds, failed })
  }

  if (input.action === 'restore') {
    let storagePath = input.storagePath
    let password = input.password ?? ''
    let isStoredScheduledBackup = false
    let storedBackupCreatedAt: string | null = null
    if (input.backupId && !storagePath && !password) {
      const { data: storedBackup, error: backupError } = await admin.from('backups').select('storage_path,schedule_id,status,created_at').eq('id', input.backupId).maybeSingle()
      if (backupError || !storedBackup?.storage_path || !storedBackup.schedule_id || storedBackup.status !== 'completed') return json({ error: 'This scheduled backup cannot be restored from its stored copy.' }, 404)
      storagePath = storedBackup.storage_path
      storedBackupCreatedAt = storedBackup.created_at
      password = Deno.env.get('BACKUP_ENCRYPTION_KEY') ?? ''
      isStoredScheduledBackup = true
    }
    if (!storagePath || (input.fileName && !input.fileName.endsWith('.json'))) return json({ error: 'Choose an APMS JSON backup.' }, 400)
    const { data: restore, error: restoreInsertError } = await admin.from('backup_restores').insert({ backup_id: input.backupId ?? null, initiated_by: auth.user!.id, reason: 'System Admin initiated JSON restore', status: 'running' }).select('id').single()
    if (restoreInsertError || !restore) return json({ error: restoreInsertError?.message ?? 'Restore could not be started' }, 500)
    let recreatedAuthUserIds: string[] = []
    try {
      const { data: blob, error: downloadError } = await admin.storage.from('apms-backups').download(storagePath)
      if (downloadError || !blob) throw downloadError ?? new Error('Uploaded backup could not be read')
      if (blob.size > 110 * 1024 * 1024) throw new Error('This backup exceeds the current 110 MB restore limit.')
      const checksumBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
      const checksum = [...checksumBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      const { error: checksumUpdateError } = await admin.from('backup_restores').update({ checksum }).eq('id', restore.id)
      if (checksumUpdateError) throw checksumUpdateError
      const envelope = JSON.parse(await blob.text())
      let snapshot: any
      if (envelope.format === 'apms-encrypted-json-backup' && envelope.algorithm === 'PBKDF2-SHA256/AES-256-GCM' && envelope.iterations === 210000) {
        if (password.length < 12) throw new Error(isStoredScheduledBackup ? 'The scheduled backup encryption key is not configured.' : 'Enter the password used to encrypt this backup.')
        const key = await passwordKey(password, unb64(envelope.salt))
        let plaintext: ArrayBuffer
        try { plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, key, unb64(envelope.ciphertext)) }
        catch { throw new Error('The backup password is incorrect or the file is damaged.') }
        snapshot = JSON.parse(new TextDecoder().decode(plaintext))
      } else if (envelope.format === 'apms-json-backup') {
        snapshot = envelope
      } else {
        throw new Error('The selected file is not a supported APMS JSON backup.')
      }
      if (snapshot.format !== 'apms-json-backup' || snapshot.version !== 1 || !snapshot.tables) throw new Error('The backup contents are invalid or unsupported.')
      const parsedBackupCreatedAt = typeof snapshot.created_at === 'string' ? Date.parse(snapshot.created_at) : Number.NaN
      const backupCreatedAt = Number.isFinite(parsedBackupCreatedAt) ? new Date(parsedBackupCreatedAt).toISOString() : storedBackupCreatedAt
      const { error: sourceTimeUpdateError } = await admin.from('backup_restores').update({ backup_created_at: backupCreatedAt }).eq('id', restore.id)
      if (sourceTimeUpdateError) throw sourceTimeUpdateError
      recreatedAuthUserIds = await recreateBackupAuthUsers(admin, snapshot, auth.user!.id)
      const restoredRows = await restoreSnapshot(userClient, snapshot)
      const data = { restored_rows: restoredRows, recreated_auth_accounts: recreatedAuthUserIds.length }
      await admin.from('backup_restores').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', restore.id)
      await admin.from('audit_logs').insert({ actor_id: auth.user!.id, action: 'backup.restored', entity_type: 'backup_restores', entity_id: restore.id, after_data: data })
      if (!input.backupId) await admin.storage.from('apms-backups').remove([storagePath])
      return json({ id: restore.id, ...data })
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string'
          ? cause.message
          : 'Restore failed'
      const failureMessage = recreatedAuthUserIds.length
        ? `${message} ${recreatedAuthUserIds.length} unconfirmed account${recreatedAuthUserIds.length === 1 ? ' was' : 's were'} recreated; retry the restore to complete their application records.`
        : message
      await admin.from('backup_restores').update({ status: 'failed', safe_error: failureMessage.slice(0, 500), completed_at: new Date().toISOString() }).eq('id', restore.id)
      return json({ error: failureMessage }, 400)
    }
  }
  return json({ error: 'Unsupported backup operation' }, 400)
})
