import { loadClassWorkspace, summarizeEnrollmentStanding, type ClassWorkspace, type FacultyClass } from './faculty';
import { supabase } from './supabase';
import { DEFAULT_EVALUATION_SYSTEM, removeStandaloneMasteryFactor, validateEvaluationSystem, type EvaluationDefinition } from '@apms/domain';

export type AcademicClass = FacultyClass & { workspace: ClassWorkspace };
export type SavedEvaluationSystem = { id: string; name: string; description?: string; definition: EvaluationDefinition; version: number; updatedAt: string; updatedBy: string | null };
export type AcademicWorkspace = {
  department: { id: string; code: string; name: string } | null;
  programs: { id: string; code: string; name: string }[];
  classes: AcademicClass[];
  evaluationSystem: EvaluationDefinition;
  evaluationSystems: SavedEvaluationSystem[];
  personalEvaluationSystem: EvaluationDefinition | null;
  evaluationSystemMetadata: { updatedAt: string | null; updatedBy: string | null };
  personalEvaluationSystemMetadata: { updatedAt: string | null; updatedBy: string | null };
};

export type AcademicSubject = {
  id: string;
  departmentId: string;
  code: string;
  title: string;
  units: number;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
};

export type AcademicSubjectRequest = {
  id: string;
  departmentId: string;
  requestedBy: string;
  requesterName: string;
  code: string;
  title: string;
  units: number;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

function client() {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  return supabase;
}

export async function loadAcademicWorkspace(userId: string): Promise<AcademicWorkspace> {
  // Find the academic_admin's department scope from user_roles.
  const { data: assignment, error: assignmentError } = await client()
    .from('user_roles')
    .select('scope_id,scope_type,roles!inner(key)')
    .eq('user_id', userId)
    .eq('roles.key', 'academic_admin')
    .single();

  if (assignmentError) throw assignmentError;
  if (assignment.scope_type !== 'department' || !assignment.scope_id) {
    throw new Error('Academic Admin requires an authorized department scope.');
  }
  const departmentId: string = assignment.scope_id;

  const [departmentResult, programResult] = await Promise.all([
    client().from('departments').select('id,code,name').eq('id', departmentId).single(),
    client().from('programs').select('id,code,name').eq('department_id', departmentId).eq('status', 'active').order('code'),
  ]);
  if (departmentResult.error) throw departmentResult.error;
  if (programResult.error) throw programResult.error;
  const { data: evaluationRow, error: evaluationError } = await client().from('evaluation_systems').select('definition,updated_at,updated_by,updated_by_name').eq('department_id', departmentId).maybeSingle();
  if (evaluationError) throw evaluationError;
  const savedEvaluation = evaluationRow?.definition as EvaluationDefinition | undefined;
  const evaluationSystem = savedEvaluation && validateEvaluationSystem(savedEvaluation).valid ? removeStandaloneMasteryFactor(savedEvaluation) : DEFAULT_EVALUATION_SYSTEM;
  const { data: personalRow, error: personalError } = await client().from('user_evaluation_systems').select('definition,updated_at,updated_by,updated_by_name').eq('department_id', departmentId).eq('user_id', userId).maybeSingle();
  if (personalError) throw personalError;
  const personalCandidate = personalRow?.definition as EvaluationDefinition | undefined;
  const personalEvaluationSystem = personalCandidate && validateEvaluationSystem(personalCandidate).valid ? removeStandaloneMasteryFactor(personalCandidate) : null;
  const { data: evaluationSystemsRows, error: evaluationSystemsError } = await client().from('evaluation_criteria_systems').select('id,name,definition,version,updated_at,updated_by_name').eq('department_id', departmentId).order('updated_at', { ascending: false });
  if (evaluationSystemsError) throw evaluationSystemsError;
  const evaluationSystems: SavedEvaluationSystem[] = (evaluationSystemsRows ?? []).map((row: any) => ({ id: row.id, name: row.name, description: row.definition?.description, definition: row.definition as EvaluationDefinition, version: Number(row.version), updatedAt: row.updated_at, updatedBy: row.updated_by_name ?? null }));
  const updaterIds = [evaluationRow?.updated_by, personalRow?.updated_by].filter((id): id is string => !!id);
  const updaterNames = new Map<string, string>();
  if (updaterIds.length) {
    const { data: profiles } = await client().from('profiles').select('id,first_name,last_name').in('id', [...new Set(updaterIds)]);
    for (const profile of profiles ?? []) updaterNames.set(profile.id, `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim());
  }

  // Load classes using department scope directly — NOT via loadFacultyClasses which is
  // filtered by faculty_assignments and would return zero classes for an Academic Admin
  // who is not also a Faculty member.
  const { data: classRows, error: classError } = await client()
    .from('class_records')
    .select('id,subject_id,section,subjects(code,title),academic_terms(academic_year,semester),enrollments(count)')
    .eq('department_id', departmentId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (classError) throw classError;

  const classSummaries: FacultyClass[] = (classRows ?? []).map((row: any) => ({
    id: row.id,
    subjectId: row.subject_id,
    code: row.subjects?.code ?? '—',
    title: row.subjects?.title ?? 'Untitled subject',
    section: row.section,
    term: `${row.academic_terms?.academic_year ?? ''} ${row.academic_terms?.semester ?? ''}`.trim(),
    studentCount: Number(row.enrollments?.[0]?.count ?? 0),
  }));

  const classIds = classSummaries.map((item) => item.id);
  const { data: privateAssignments, error: privateAssignmentsError } = classIds.length
    ? await client().from('academic_admin_class_evaluation_systems').select('class_record_id,definition').eq('department_id', departmentId).eq('user_id', userId).in('class_record_id', classIds)
    : { data: [], error: null };
  if (privateAssignmentsError) throw privateAssignmentsError;
  const privateDefinitions = new Map((privateAssignments ?? []).flatMap((row: any) => {
    const definition = row.definition as EvaluationDefinition;
    return definition && validateEvaluationSystem(definition).valid ? [[row.class_record_id, removeStandaloneMasteryFactor(definition)] as const] : [];
  }));
  const classes = await Promise.all(
    classSummaries.map(async (item) => {
      const privateDefinition = privateDefinitions.get(item.id);
      return { ...item, workspace: await loadClassWorkspace(item.id, undefined, undefined, privateDefinition) };
    })
  );

  return {
    department: departmentResult.data, programs: programResult.data ?? [], classes, evaluationSystem, evaluationSystems, personalEvaluationSystem,
    evaluationSystemMetadata: { updatedAt: evaluationRow?.updated_at ?? null, updatedBy: evaluationRow?.updated_by_name || (evaluationRow?.updated_by ? updaterNames.get(evaluationRow.updated_by) || `User ${evaluationRow.updated_by.slice(0, 8)}` : null) },
    personalEvaluationSystemMetadata: { updatedAt: personalRow?.updated_at ?? null, updatedBy: personalRow?.updated_by_name || (personalRow?.updated_by ? updaterNames.get(personalRow.updated_by) || 'You' : null) },
  };
}

export async function saveEvaluationSystem(userId: string, departmentId: string, definition: EvaluationDefinition): Promise<void> {
  const validation = validateEvaluationSystem(definition);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  const { data: profile } = await client().from('profiles').select('first_name,last_name').eq('id', userId).maybeSingle();
  const updatedByName = `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim() || `User ${userId.slice(0, 8)}`;
  const { error } = await client().from('evaluation_systems').upsert({ department_id: departmentId, definition, updated_by: userId, updated_by_name: updatedByName, updated_at: new Date().toISOString() }, { onConflict: 'department_id' });
  if (error) throw error;
}

export async function saveDepartmentEvaluationCriteria(userId: string, departmentId: string, definition: EvaluationDefinition, version: number): Promise<string> {
  const validation = validateEvaluationSystem(definition);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  if (!userId) throw new Error('An authenticated user is required.');
  const { data: profile } = await client().from('profiles').select('first_name,last_name').eq('id', userId).maybeSingle();
  const updatedByName = `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim() || `User ${userId.slice(0, 8)}`;
  const { error } = await client().from('evaluation_criteria_systems').upsert({
    id: definition.id, department_id: departmentId, name: definition.name, definition, version,
    updated_by: userId, updated_by_name: updatedByName, updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw error;
  return updatedByName;
}

export async function applyDepartmentEvaluationCriteriaToClasses(classIds: string[], userId: string, departmentId: string, evaluationSystemId: string) {
  if (!userId) throw new Error('An authenticated Academic Admin is required.');
  const clientInstance = client();
  const outcomes = await Promise.allSettled(classIds.map(async (classId) => {
    const { data, error } = await clientInstance.from('class_evaluation_criteria').upsert({
      class_record_id: classId, department_id: departmentId, evaluation_system_id: evaluationSystemId,
      assigned_by: userId, updated_at: new Date().toISOString(),
    }, { onConflict: 'class_record_id' }).select('class_record_id').single();
    if (error) throw error;
    if (!data) throw new Error('The class is outside your department scope.');
  }));
  return {
    applied: classIds.filter((_, index) => outcomes[index].status === 'fulfilled'),
    failures: classIds.flatMap((classId, index) => {
      const outcome = outcomes[index];
      if (outcome.status !== 'rejected') return [];
      const reason = outcome.reason;
      const message = reason instanceof Error ? reason.message
        : reason && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string' ? reason.message
        : typeof reason === 'string' ? reason : 'Could not apply evaluation criteria to this class.';
      return [{ classId, message }];
    }),
  };
}

export async function applyPersonalEvaluationCriteriaToClasses(classIds: string[], userId: string, departmentId: string, definition: EvaluationDefinition) {
  const validation = validateEvaluationSystem(definition);
  if (!validation.valid) throw new Error(validation.errors.join('\n'));
  if (!userId) throw new Error('An authenticated Academic Admin is required.');
  const outcomes = await Promise.allSettled(classIds.map(async (classId) => {
    const { data, error } = await client().from('academic_admin_class_evaluation_systems').upsert({
      class_record_id: classId,
      department_id: departmentId,
      user_id: userId,
      definition,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'class_record_id,user_id' }).select('class_record_id').single();
    if (error) throw error;
    if (!data) throw new Error('The class is outside your Academic Admin department scope.');
  }));
  return {
    applied: classIds.filter((_, index) => outcomes[index].status === 'fulfilled'),
    failures: classIds.flatMap((classId, index) => {
      const outcome = outcomes[index];
      if (outcome.status !== 'rejected') return [];
      const reason = outcome.reason;
      const message = reason instanceof Error ? reason.message
        : reason && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string' ? reason.message
        : typeof reason === 'string' ? reason : 'Could not apply personal evaluation criteria to this class.';
      return [{ classId, message }];
    }),
  };
}

export async function deleteDepartmentEvaluationCriteria(userId: string, departmentId: string, evaluationSystemId: string) {
  if (!userId) throw new Error('An authenticated Academic Admin is required.');
  const db = client();
  const [{ data: assignments, error: assignmentsError }, { data: departmentDefault, error: defaultError }] = await Promise.all([
    db.from('class_evaluation_criteria').select('class_record_id').eq('department_id', departmentId).eq('evaluation_system_id', evaluationSystemId).limit(1),
    db.from('evaluation_systems').select('definition').eq('department_id', departmentId).maybeSingle(),
  ]);
  if (assignmentsError) throw assignmentsError;
  if (defaultError) throw defaultError;
  if (assignments?.length || (departmentDefault?.definition as EvaluationDefinition | undefined)?.id === evaluationSystemId) {
    throw new Error('This evaluation criteria is in use. Remove its class assignments or change the department default before deleting it.');
  }
  const { data, error } = await db.from('evaluation_criteria_systems').delete().eq('id', evaluationSystemId).eq('department_id', departmentId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This evaluation criteria could not be deleted. It may be in use or you may not have permission.');
}

export async function deletePersonalEvaluationCriteria(userId: string, departmentId: string) {
  if (!userId) throw new Error('An authenticated Academic Admin is required.');
  const db = client();
  const { error: assignmentsError } = await db.from('academic_admin_class_evaluation_systems').delete().eq('user_id', userId).eq('department_id', departmentId);
  if (assignmentsError) throw assignmentsError;
  const { data, error } = await db.from('user_evaluation_systems').delete().eq('user_id', userId).eq('department_id', departmentId).select('user_id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Your private evaluation criteria could not be deleted.');
}

export async function savePersonalEvaluationSystem(userId: string, departmentId: string, definition: EvaluationDefinition): Promise<void> {
  const validation = validateEvaluationSystem(definition);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  if (!userId) throw new Error('An authenticated user is required.');
  const { data: profile } = await client().from('profiles').select('first_name,last_name').eq('id', userId).maybeSingle();
  const updatedByName = `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim() || 'You';
  const { error } = await client().from('user_evaluation_systems').upsert({
    department_id: departmentId, user_id: userId, definition, updated_by: userId, updated_by_name: updatedByName, updated_at: new Date().toISOString(),
  }, { onConflict: 'department_id,user_id' });
  if (error) throw error;
}

// ─── Subject management ───────────────────────────────────────────────────────

export async function loadDepartmentSubjects(): Promise<AcademicSubject[]> {
  // RLS restricts results to the Academic Admin's authorized department.
  const { data, error } = await client()
    .from('subjects')
    .select('id,department_id,code,title,units,status,created_at,updated_at')
    .order('code');
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    departmentId: row.department_id,
    code: row.code,
    title: row.title,
    units: Number(row.units),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function manageSubject(input: {
  subjectId?: string;
  departmentId: string;
  code: string;
  title: string;
  units: number;
  status: 'active' | 'inactive';
}): Promise<string> {
  const { data, error } = await client().rpc('academic_admin_manage_subject', {
    p_subject_id: input.subjectId ?? null,
    p_department_id: input.departmentId,
    p_code: input.code.trim(),
    p_title: input.title.trim(),
    p_units: input.units,
    p_status: input.status,
  });
  if (error) {
    if (error.code === '23505') {
      throw new Error(`A subject with code "${input.code}" already exists in this department.`);
    }
    throw error;
  }
  return data as string;
}

export async function loadSubjectRequests(): Promise<AcademicSubjectRequest[]> {
  const { data, error } = await client()
    .from('subject_requests')
    .select('id,department_id,requested_by,code,title,units,rationale,status,review_note,reviewed_at,created_at,profiles!subject_requests_requested_by_fkey(first_name,last_name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    departmentId: row.department_id,
    requestedBy: row.requested_by,
    requesterName: row.profiles
      ? `${row.profiles.first_name} ${row.profiles.last_name}`.trim()
      : 'Unknown',
    code: row.code,
    title: row.title,
    units: Number(row.units),
    rationale: row.rationale,
    status: row.status,
    reviewNote: row.review_note ?? null,
    reviewedAt: row.reviewed_at ?? null,
    createdAt: row.created_at,
  }));
}

export async function reviewSubjectRequest(
  requestId: string,
  decision: 'approved' | 'rejected',
  reviewNote: string,
): Promise<void> {
  const { error } = await client().rpc('academic_admin_review_subject_request', {
    p_request_id: requestId,
    p_decision: decision,
    p_review_note: reviewNote.trim(),
  });
  if (error) throw error;
}

// ─── CSV report export ────────────────────────────────────────────────────────

export function academicReportCsv(workspace: AcademicWorkspace) {
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows: unknown[][] = [['Subject', 'Section', 'Students', 'At Risk', 'Average Current Standing', 'Average Mastery', 'Passing Rule Met']];
  for (const item of workspace.classes) {
    const summaries = item.workspace.students.map((student) => summarizeEnrollmentStanding(item.workspace, student.enrollmentId));
    const standings = summaries.flatMap((summary) => summary.finalGrade ?? summary.p3 ?? summary.effortfulLearning ?? summary.mastery ?? []);
    const mastery = summaries.flatMap((summary) => summary.mastery ?? []);
    const atRisk = item.workspace.students.filter((student) => {
      const evaluation = item.workspace.evaluations[student.enrollmentId];
      return evaluation?.riskLevel === 'high' || evaluation?.riskLevel === 'medium';
    }).length;
    rows.push([
      item.code,
      item.section,
      item.workspace.students.length,
      atRisk,
      standings.length ? (standings.reduce((sum, value) => sum + value, 0) / standings.length).toFixed(2) : '',
      mastery.length ? (mastery.reduce((sum, value) => sum + value, 0) / mastery.length).toFixed(2) : '',
      summaries.filter((summary) => summary.remarks === 'passing').length,
    ]);
  }
  return rows.map((row) => row.map(escape).join(',')).join('\n');
}
