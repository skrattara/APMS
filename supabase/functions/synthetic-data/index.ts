import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
const allowlistKey = 'data_generator.allowed_class_ids'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !anonKey || !serviceKey) return json({ error: 'Data generator service is not configured.' }, 503)
  const token = authorization.slice('Bearer '.length)
  const userClient = createClient(url, anonKey, { auth: { persistSession: false } })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: callerData, error: callerError } = await userClient.auth.getUser(token)
  if (callerError || !callerData.user) return json({ error: 'Invalid session' }, 401)
  const callerId = callerData.user.id
  const now = new Date().toISOString()
  const { data: role } = await admin.from('user_roles').select('roles!inner(key),profiles!user_roles_user_id_fkey!inner(status)').eq('user_id', callerId).eq('roles.key', 'system_admin').eq('profiles.status', 'active').eq('scope_type', 'global').lte('valid_from', now).or(`valid_until.is.null,valid_until.gt.${now}`).maybeSingle()
  if (!role) return json({ error: 'Active System Admin permission required.' }, 403)
  let body: any
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body.' }, 400) }

  const { data: setting } = await admin.from('system_settings').select('value').eq('key', allowlistKey).maybeSingle()
  const allowedIds = Array.isArray(setting?.value) ? setting.value.filter((item: unknown): item is string => typeof item === 'string') : []

  if (body.action === 'list_classes') {
    const { data: rows, error } = await admin.from('class_records').select('id,section,status,department_id,is_synthetic_test,subjects!inner(code,title),academic_terms(academic_year,semester)').eq('status', 'active').order('created_at', { ascending: false }).limit(1000)
    if (error) return json({ error: error.message }, 500)
    return json({ allowedClassIds: allowedIds, classes: (rows ?? []).map((row: any) => ({ id: row.id, departmentId: row.department_id, isSyntheticTest: row.is_synthetic_test, label: `${row.subjects?.code ?? 'Class'} · ${row.section} · ${row.academic_terms?.academic_year ?? ''} ${row.academic_terms?.semester ?? ''}`.trim() })) })
  }

  if (body.action === 'list_faculty') {
    const { data: rows, error } = await admin.from('faculty_profiles').select('id,profile_id,department_id,employee_id').eq('status', 'active').order('employee_id').limit(1000)
    if (error) return json({ error: error.message }, 500)
    const profileIds = (rows ?? []).map((row: any) => row.profile_id)
    const { data: profiles, error: profileError } = profileIds.length
      ? await admin.from('profiles').select('id,first_name,last_name,status').in('id', profileIds).eq('status', 'active')
      : { data: [], error: null }
    if (profileError) return json({ error: profileError.message }, 500)
    const profileById = new Map((profiles ?? []).map((profile: any) => [profile.id, profile]))
    return json({ faculty: (rows ?? []).flatMap((row: any) => {
      const profile: any = profileById.get(row.profile_id)
      return profile ? [{ id: row.id, departmentId: row.department_id, label: `${profile.first_name} ${profile.last_name} · ${row.employee_id}` }] : []
    }) })
  }

  if (body.action === 'delete_all_test_classes') {
    const { data, error } = await admin.rpc('delete_synthetic_test_classes')
    if (error) return json({ error: error.message }, 500)
    return json({ deleted: data?.[0] ?? { classes: 0, students: 0, assessments: 0, results: 0 } })
  }

  if (body.action === 'assign_test_class') {
    if (typeof body.classId !== 'string' || !uuidPattern.test(body.classId) || typeof body.facultyId !== 'string' || !uuidPattern.test(body.facultyId)) return json({ error: 'Choose a test class and an active Faculty account.' }, 400)
    if (!allowedIds.includes(body.classId)) return json({ error: 'Add this test class to the central allowlist first.' }, 403)
    const [{ data: classRow }, { data: faculty }] = await Promise.all([
      admin.from('class_records').select('id,department_id,is_synthetic_test,status').eq('id', body.classId).maybeSingle(),
      admin.from('faculty_profiles').select('id,department_id,status,profiles!inner(status)').eq('id', body.facultyId).eq('status', 'active').eq('profiles.status', 'active').maybeSingle(),
    ])
    if (!classRow || classRow.status !== 'active' || !classRow.is_synthetic_test) return json({ error: 'Only active test classes created by the generator can be assigned here.' }, 422)
    if (!faculty || faculty.department_id !== classRow.department_id) return json({ error: 'Choose an active Faculty account from the class department.' }, 422)
    const { error } = await admin.from('faculty_assignments').upsert({ faculty_id: faculty.id, class_record_id: classRow.id, assignment_role: 'instructor', status: 'active' }, { onConflict: 'faculty_id,class_record_id,assignment_role' })
    if (error) return json({ error: error.message }, 500)
    return json({ assigned: true })
  }

  if (body.action === 'create_class_options') {
    const [subjects, terms] = await Promise.all([
      admin.from('subjects').select('id,department_id,code,title,departments!inner(code,name)').eq('status', 'active').order('code').limit(1000),
      admin.from('academic_terms').select('id,academic_year,semester,starts_on,ends_on,status').in('status', ['active', 'planned']).order('starts_on', { ascending: false }).limit(100),
    ])
    if (subjects.error || terms.error) return json({ error: subjects.error?.message ?? terms.error?.message }, 500)
    return json({ subjects: (subjects.data ?? []).map((row: any) => ({ id: row.id, departmentId: row.department_id, label: `${row.departments?.code ?? ''} · ${row.code} · ${row.title}`.trim() })), terms: (terms.data ?? []).map((row: any) => ({ id: row.id, startsOn: row.starts_on, endsOn: row.ends_on, label: `${row.academic_year} · ${row.semester}` })) })
  }

  if (body.action === 'create_test_class') {
    if (typeof body.subjectId !== 'string' || !uuidPattern.test(body.subjectId) || typeof body.termId !== 'string' || !uuidPattern.test(body.termId) || typeof body.section !== 'string') return json({ error: 'Choose a subject and academic term, then enter a test class section.' }, 400)
    const sectionSuffix = body.section.trim().replace(/\s+/g, ' ')
    if (!sectionSuffix || sectionSuffix.length > 60 || /[<>\r\n]/.test(sectionSuffix)) return json({ error: 'Enter a test section name up to 60 characters.' }, 400)
    const { data: subject } = await admin.from('subjects').select('id,department_id').eq('id', body.subjectId).eq('status', 'active').maybeSingle()
    const { data: term } = await admin.from('academic_terms').select('id').eq('id', body.termId).in('status', ['active', 'planned']).maybeSingle()
    if (!subject || !term) return json({ error: 'The selected subject or academic term is unavailable.' }, 422)
    const section = `TEST - ${sectionSuffix}`
    const { data: created, error } = await admin.from('class_records').insert({ subject_id: subject.id, academic_term_id: term.id, department_id: subject.department_id, section, status: 'active', is_synthetic_test: true, created_by: callerId }).select('id').single()
    if (error) return json({ error: error.code === '23505' ? 'A class with this subject, term, and test section already exists.' : error.message }, error.code === '23505' ? 409 : 500)
    const nextAllowedIds = [...new Set([...allowedIds, created.id])]
    const { error: allowlistError } = await admin.from('system_settings').upsert({ key: allowlistKey, value: nextAllowedIds, updated_by: callerId, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (allowlistError) {
      await admin.from('class_records').delete().eq('id', created.id)
      return json({ error: allowlistError.message }, 500)
    }
    return json({ classId: created.id, allowedClassIds: nextAllowedIds })
  }

  if (body.action === 'set_allowlist') {
    if (!Array.isArray(body.classIds) || body.classIds.length > 200 || body.classIds.some((id: unknown) => typeof id !== 'string' || !uuidPattern.test(id))) return json({ error: 'Choose up to 200 valid classes.' }, 400)
    const classIds = [...new Set(body.classIds as string[])]
    const { data: activeClasses, error } = await admin.from('class_records').select('id').eq('status', 'active').in('id', classIds)
    if (error) return json({ error: error.message }, 500)
    if ((activeClasses ?? []).length !== classIds.length) return json({ error: 'The allowlist can only include active classes.' }, 400)
    const { error: saveError } = await admin.from('system_settings').upsert({ key: allowlistKey, value: classIds, updated_by: callerId, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (saveError) return json({ error: saveError.message }, 500)
    return json({ allowedClassIds: classIds })
  }

  if (!['class_config', 'write_batch'].includes(body.action) || typeof body.classId !== 'string' || !uuidPattern.test(body.classId)) return json({ error: 'Unsupported action or invalid class.' }, 400)
  if (!allowedIds.includes(body.classId)) return json({ error: 'This class is not on the System Admin data-generation allowlist.' }, 403)
  const { data: classRow, error: classError } = await admin.from('class_records').select('id,department_id,section,status,subject_id,subjects!inner(code,title),academic_terms(academic_year,semester,starts_on,ends_on)').eq('id', body.classId).eq('status', 'active').maybeSingle()
  if (classError || !classRow) return json({ error: 'The selected class is unavailable or inactive.' }, 404)
  const { data: criteria, error: criteriaError } = await admin.from('criteria_sets').select('grading_system_id,grading_system_definition,version,updated_at').eq('class_record_id', body.classId).eq('status', 'active').order('version', { ascending: false }).order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (criteriaError) return json({ error: criteriaError.message }, 500)
  let gradingDefinition = criteria?.grading_system_definition
  if (!gradingDefinition) {
    const { data: fallback } = await admin.from('system_settings').select('value').eq('key', 'grading.default_system_definition').maybeSingle()
    gradingDefinition = fallback?.value
    if (typeof gradingDefinition === 'string') { try { gradingDefinition = JSON.parse(gradingDefinition) } catch { gradingDefinition = null } }
  }
  if (!gradingDefinition || typeof gradingDefinition !== 'object') return json({ error: 'This class has no applied grading-system representation.' }, 422)
  const { data: evaluationAssignment } = await admin.from('class_evaluation_criteria').select('evaluation_criteria_systems(definition)').eq('class_record_id', body.classId).maybeSingle()
  const evaluationRelation = (evaluationAssignment as any)?.evaluation_criteria_systems
  const evaluationDefinition = Array.isArray(evaluationRelation) ? evaluationRelation[0]?.definition ?? null : evaluationRelation?.definition ?? null
  const config = { class: { id: classRow.id, departmentId: classRow.department_id, section: classRow.section, startsOn: (classRow as any).academic_terms?.starts_on, endsOn: (classRow as any).academic_terms?.ends_on, label: `${(classRow as any).subjects?.code ?? 'Class'} · ${classRow.section} · ${(classRow as any).academic_terms?.academic_year ?? ''} ${(classRow as any).academic_terms?.semester ?? ''}`.trim() }, gradingDefinition, evaluationDefinition }
  if (body.action === 'class_config') return json(config)

  if (canonical(body.gradingDefinition) !== canonical(gradingDefinition) || canonical(body.evaluationDefinition ?? null) !== canonical(evaluationDefinition ?? null)) return json({ error: 'The class grading or evaluation criteria changed after preview. Reload the class configuration and generate the preview again.' }, 409)
  if (body.plan?.targetNamespace !== body.classId) return json({ error: 'The generation plan is not scoped to the selected class.' }, 400)

  const dataset = body.dataset
  if (!dataset || !Array.isArray(dataset.students) || !Array.isArray(dataset.assessments) || !Array.isArray(dataset.results) || dataset.students.length < 1 || dataset.students.length > 2000 || dataset.assessments.length > 250 || dataset.results.length > 20_000 || dataset.results.length !== dataset.students.length * dataset.assessments.length || typeof dataset.batchId !== 'string' || dataset.batchId.length > 100 || !body.plan || typeof body.plan !== 'object') return json({ error: 'The generated dataset is malformed or exceeds the 20,000 result write limit. Reduce the student count or assessment count.' }, 400)
  const studentIds = new Set<string>()
  for (const student of dataset.students) {
    if (!uuidPattern.test(student.id) || studentIds.has(student.id) || !Number.isInteger(student.classNumber) || student.classNumber < 1 || typeof student.name !== 'string' || !student.name.trim()) return json({ error: 'Generated student data is invalid.' }, 400)
    studentIds.add(student.id)
  }
  const componentByType = new Map<string, any>()
  for (const component of gradingDefinition.components ?? []) if (component.assessmentDefinition?.typeId) componentByType.set(component.assessmentDefinition.typeId, component)
  const gradingGroups = new Map<string, any>((gradingDefinition.groups ?? []).map((group: any) => [group.id, group]))
  const groupBelongsToPeriod = (groupId: string, periodId: string) => {
    const assigned = (gradingDefinition.periods ?? []).find((period: any) => period.id === periodId)?.groupIds ?? []
    let current = gradingGroups.get(groupId)
    while (current) {
      if (assigned.includes(current.id)) return true
      current = current.parentGroupId ? gradingGroups.get(current.parentGroupId) : null
    }
    return false
  }
  const assessmentIds = new Set<string>()
  const completionRequirements = new Map<string, any>((body.plan.completionRequirements ?? []).filter((item: any) => item && typeof item.id === 'string').map((item: any) => [item.id, item]))
  for (const assessment of dataset.assessments) {
    if (!uuidPattern.test(assessment.id) || assessmentIds.has(assessment.id) || !Number.isFinite(assessment.maximumScore) || assessment.maximumScore <= 0 || typeof assessment.title !== 'string') return json({ error: 'Generated assessment data is invalid.' }, 400)
    assessmentIds.add(assessment.id)
    if (assessment.requirementId) {
      const requirement = completionRequirements.get(assessment.requirementId)
      if (!requirement || Boolean(assessment.optional) !== Boolean(requirement.optional) || (requirement.typeId && assessment.typeId !== requirement.typeId)) return json({ error: `Completion requirement ${assessment.requirementId} does not match the generation plan.` }, 422)
    } else {
      const component = componentByType.get(assessment.typeId)
      if (!component || component.id !== assessment.componentId) return json({ error: `Assessment type ${assessment.typeId} is not part of the applied grading system.` }, 422)
      if (assessment.periodId && !(gradingDefinition.periods ?? []).some((period: any) => period.id === assessment.periodId)) return json({ error: `Unknown grading period ${assessment.periodId}.` }, 422)
      if (assessment.groupId && !(gradingDefinition.groups ?? []).some((group: any) => group.id === assessment.groupId)) return json({ error: `Unknown grading group ${assessment.groupId}.` }, 422)
      if (assessment.periodId && assessment.groupId && !groupBelongsToPeriod(assessment.groupId, assessment.periodId)) return json({ error: `Group ${assessment.groupId} is not assigned to period ${assessment.periodId} or one of its nested groups.` }, 422)
    }
  }
  const resultKeys = new Set<string>()
  for (const result of dataset.results) {
    const key = `${result.assessmentId}:${result.studentId}`
    if (!assessmentIds.has(result.assessmentId) || !studentIds.has(result.studentId) || resultKeys.has(key)) return json({ error: 'Generated result references a duplicate or unknown student/assessment.' }, 400)
    resultKeys.add(key)
    if (result.missing) continue
    if ((result.score == null) === (result.categoricalValue == null)) return json({ error: 'Each result must contain exactly one numeric or categorical value.' }, 400)
    const assessment = dataset.assessments.find((item: any) => item.id === result.assessmentId)
    if (assessment.requirementId) {
      const requirement = completionRequirements.get(assessment.requirementId)
      if (requirement.scoring.mode === 'linear' && (result.score < 0 || result.score > requirement.scoring.maximumScore)) return json({ error: `Completion score is outside the allowed range for ${assessment.title}.` }, 422)
      if (requirement.scoring.mode === 'value_mapping' && !requirement.scoring.mapping.some((item: any) => String(item.value) === String(result.categoricalValue))) return json({ error: `Completion category is outside the allowed mapping for ${assessment.title}.` }, 422)
      if (requirement.scoring.mode === 'numeric_mapping' && !requirement.scoring.mapping.some((item: any) => Number(item.value) === Number(result.score))) return json({ error: `Completion value is not in the numeric mapping for ${assessment.title}.` }, 422)
    } else {
      const definition = componentByType.get(assessment.typeId).assessmentDefinition
      if (definition.scoring?.mode === 'value_mapping' && !definition.scoring.mapping.some((item: any) => String(item.value) === String(result.categoricalValue))) return json({ error: `Categorical result is outside the mapping for ${assessment.title}.` }, 422)
      if (definition.scoring?.mode === 'numeric_mapping' && !definition.scoring.mapping.some((item: any) => Number(item.value) === Number(result.score))) return json({ error: `Numeric mapped result is not a valid mapped value for ${assessment.title}.` }, 422)
      if (definition.scoring?.mode === 'linear' && (result.score < 0 || result.score > (definition.maxScore ?? assessment.maximumScore))) return json({ error: `Linear score is outside the allowed range for ${assessment.title}.` }, 422)
    }
  }

  const { data: program, error: programError } = await admin.from('programs').select('id').eq('department_id', classRow.department_id).eq('status', 'active').order('code').limit(1).maybeSingle()
  if (programError || !program) return json({ error: 'The class department needs at least one active program before synthetic students can be enrolled.' }, 422)

  const batchId = crypto.randomUUID()
  const seed = String(dataset.seed ?? '').slice(0, 200)
  const { error: createBatchError } = await admin.from('synthetic_data_batches').insert({ id: batchId, class_record_id: body.classId, generation_key: dataset.batchId, seed, status: 'writing', created_by: callerId, grading_system_definition: gradingDefinition, evaluation_system_definition: evaluationDefinition, generation_plan: body.plan, counts: dataset.counts ?? {} })
  if (createBatchError) return json({ error: createBatchError.message }, 409)

  const deleteBatchRows = async () => {
    const studentRows = await admin.from('students').select('id').eq('synthetic_batch_id', batchId)
    if (studentRows.error) throw studentRows.error
    const ids = (studentRows.data ?? []).map((item: any) => item.id)
    const resultsDelete = await admin.from('assessment_results').delete().eq('synthetic_batch_id', batchId)
    if (resultsDelete.error) throw resultsDelete.error
    const assessmentsDelete = await admin.from('assessments').delete().eq('synthetic_batch_id', batchId)
    if (assessmentsDelete.error) throw assessmentsDelete.error
    if (ids.length) {
      const enrollmentsDelete = await admin.from('enrollments').delete().in('student_id', ids).eq('class_record_id', body.classId)
      if (enrollmentsDelete.error) throw enrollmentsDelete.error
    }
    const studentsDelete = await admin.from('students').delete().eq('synthetic_batch_id', batchId)
    if (studentsDelete.error) throw studentsDelete.error
    const batchDelete = await admin.from('synthetic_data_batches').delete().eq('id', batchId)
    if (batchDelete.error) throw batchDelete.error
  }
  let batchStage = 'preparing generated records'
  try {
    const databaseStudentIdBySource = new Map<string, string>(dataset.students.map((student: any) => [student.id, crypto.randomUUID()]))
    const databaseAssessmentIdBySource = new Map<string, string>(dataset.assessments.map((assessment: any) => [assessment.id, crypto.randomUUID()]))
    const studentRows = dataset.students.map((student: any) => {
      const parts = String(student.name).trim().split(/\s+/); const firstName = parts.shift() ?? 'Test'; const lastName = parts.join(' ') || 'Student'
      const id = databaseStudentIdBySource.get(student.id)!
      return { id, synthetic_batch_id: batchId, program_id: program.id, institutional_id: `SYN-${batchId.slice(0, 8).toUpperCase()}-${student.studentNumber}`, email: `synthetic-${id}@example.invalid`, first_name: firstName.slice(0, 100), last_name: lastName.slice(0, 100), year_level: 1, section: classRow.section, remarks: `Synthetic data batch ${dataset.batchId}`, status: 'inactive' }
    })
    batchStage = 'inserting generated students'
    for (let i = 0; i < studentRows.length; i += 500) { const { error } = await admin.from('students').insert(studentRows.slice(i, i + 500)); if (error) throw error }
    const enrollmentRows = dataset.students.map((student: any) => ({ student_id: databaseStudentIdBySource.get(student.id), class_record_id: body.classId, status: 'completed' }))
    batchStage = 'creating class enrollments'
    for (let i = 0; i < enrollmentRows.length; i += 500) { const { error } = await admin.from('enrollments').insert(enrollmentRows.slice(i, i + 500)); if (error) throw error }
    const assessmentRows = dataset.assessments.map((assessment: any) => ({ id: databaseAssessmentIdBySource.get(assessment.id), synthetic_batch_id: batchId, class_record_id: body.classId, title: assessment.title.slice(0, 200), type: assessment.typeId, grading_type_id: assessment.typeId, grading_group_id: assessment.groupId, grading_period_id: assessment.periodId, grading_instance_weight: assessment.weight, maximum_score: assessment.maximumScore, optional: Boolean(assessment.optional), assessment_date: assessment.date, due_at: `${assessment.date}T12:00:00.000Z`, status: 'draft', created_by: callerId }))
    batchStage = 'creating assessment instances'
    for (let i = 0; i < assessmentRows.length; i += 250) { const { error } = await admin.from('assessments').insert(assessmentRows.slice(i, i + 250)); if (error) throw error }
    batchStage = 'matching results to enrollments'
    const { data: enrollments, error: enrollmentLookupError } = await admin.from('enrollments').select('id,student_id').eq('class_record_id', body.classId).in('student_id', [...databaseStudentIdBySource.values()])
    if (enrollmentLookupError) throw enrollmentLookupError
    const enrollmentIdByStudent = new Map<string, string>((enrollments ?? []).map((item: any) => [item.student_id, item.id]))
    const resultRows = dataset.results.filter((result: any) => !result.missing).map((result: any) => {
      const studentId = databaseStudentIdBySource.get(result.studentId)
      const enrollmentId = studentId ? enrollmentIdByStudent.get(studentId) : undefined
      if (!enrollmentId) throw new Error('A generated result is missing its active class enrollment.')
      return { assessment_id: databaseAssessmentIdBySource.get(result.assessmentId), enrollment_id: enrollmentId, score: result.score, categorical_value: result.categoricalValue, synthetic_batch_id: batchId, source: 'import', approval_status: 'approved', recorded_by: callerId }
    })
    batchStage = 'saving assessment results'
    for (let i = 0; i < resultRows.length; i += 1000) {
      const { error } = await admin.from('assessment_results').insert(resultRows.slice(i, i + 1000))
      if (error) throw error
    }
    batchStage = 'activating the generated batch'
    const { error: promotionError } = await admin.rpc('promote_synthetic_data_batch', { p_batch_id: batchId })
    if (promotionError) throw promotionError
  } catch (cause) {
    const details = cause && typeof cause === 'object' ? cause as Record<string, unknown> : null
    const causeMessage = cause instanceof Error ? cause.message : typeof details?.message === 'string' ? details.message : typeof cause === 'string' ? cause : 'Unknown database error.'
    const databaseCode = typeof details?.code === 'string' ? ` (${details.code})` : ''
    console.error(`[Synthetic data] Batch ${batchId} failed while ${batchStage}:`, cause)
    let cleanupError: unknown = null
    try { await deleteBatchRows() } catch (cleanupCause) { cleanupError = cleanupCause; console.error(`[Synthetic data] Batch ${batchId} cleanup failed:`, cleanupCause) }
    const cleanupNote = cleanupError ? ' Cleanup also failed; remove the incomplete batch before retrying.' : ''
    return json({ error: `Synthetic batch failed while ${batchStage}${databaseCode}: ${causeMessage}.${cleanupNote}` }, 500)
  }

  return json({ batchId, classId: body.classId, counts: dataset.counts })
})
