import { loadClassWorkspace, summarizeEnrollmentStanding, type ClassWorkspace, type FacultyClass } from './faculty';
import { supabase } from './supabase';
import { DEFAULT_EVALUATION_SYSTEM, removeStandaloneMasteryFactor, validateEvaluationSystem, type EvaluationDefinition } from '@apms/domain';
import { institutionalSectionName, resolveInstitutionalSectionName, type AcademicSectionPattern } from '@/utils/academicSections';

export type AcademicClass = FacultyClass & { workspace: ClassWorkspace; assignedFaculty: DepartmentFacultyMember[] };
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

export type DepartmentFacultyMember = { userId: string; name: string; employeeId: string };
export type ClassRequestReview = {
  id: string;
  requestedBy: string;
  requesterName: string;
  subjectId: string;
  subject: string;
  academicTermId: string;
  term: string;
  section: string;
  lectureUnits: number;
  laboratoryUnits: number;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewNote: string | null;
  createdAt: string;
};

export type AcademicSubject = {
  id: string;
  departmentId: string;
  code: string;
  title: string;
  units: number;
  lectureUnits: number;
  laboratoryUnits: number;
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
  lectureUnits: number;
  laboratoryUnits: number;
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
    .select('id,subject_id,section,subjects(code,title,lecture_units,laboratory_units),academic_terms(academic_year,semester),enrollments(count)')
    .eq('department_id', departmentId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (classError) throw classError;

  const programIds = (programResult.data ?? []).map((program) => program.id);
  const [{ data: sectionRows, error: sectionError }, { data: institutionSetting, error: institutionError }] = await Promise.all([
    programIds.length ? client().from('program_sections').select('program_id,year_level,section_number').in('program_id', programIds) : Promise.resolve({ data: [], error: null }),
    client().from('system_settings').select('value').eq('key', 'academic.institution_code').maybeSingle(),
  ]);
  if (sectionError) throw sectionError;
  if (institutionError) throw institutionError;
  const institutionCode = typeof institutionSetting?.value === 'string' && institutionSetting.value.trim() ? institutionSetting.value.trim().toUpperCase() : 'SWU';
  const programCodeById = new Map((programResult.data ?? []).map((program) => [program.id, program.code]));
  const sectionPatterns: AcademicSectionPattern[] = (sectionRows ?? []).flatMap((row: any) => {
    const programCode = programCodeById.get(row.program_id);
    return programCode ? [{ programCode, yearLevel: Number(row.year_level), sectionNumber: Number(row.section_number) }] : [];
  });

  const classSummaries: FacultyClass[] = (classRows ?? []).map((row: any) => ({
    id: row.id,
    subjectId: row.subject_id,
    code: row.subjects?.code ?? '—',
    title: row.subjects?.title ?? 'Untitled subject',
    section: resolveInstitutionalSectionName(row.section, sectionPatterns, institutionCode),
    term: `${row.academic_terms?.academic_year ?? ''} ${row.academic_terms?.semester ?? ''}`.trim(),
    studentCount: Number(row.enrollments?.[0]?.count ?? 0),
    lectureUnits: Number(row.subjects?.lecture_units ?? 3),
    laboratoryUnits: Number(row.subjects?.laboratory_units ?? 0),
  }));

  const classIds = classSummaries.map((item) => item.id);
  const { data: facultyAssignmentRows, error: facultyAssignmentError } = classIds.length
    ? await client().from('faculty_assignments')
      .select('class_record_id,faculty_profiles!inner(profile_id,employee_id,profiles!faculty_profiles_profile_id_fkey(first_name,last_name))')
      .eq('status', 'active')
      .in('class_record_id', classIds)
    : { data: [], error: null };
  if (facultyAssignmentError) throw facultyAssignmentError;
  const assignedFacultyByClass = new Map<string, DepartmentFacultyMember[]>();
  for (const row of facultyAssignmentRows ?? []) {
    const profile = (row as any).faculty_profiles;
    const member: DepartmentFacultyMember = {
      userId: profile.profile_id,
      employeeId: profile.employee_id,
      name: `${profile.profiles?.first_name ?? ''} ${profile.profiles?.last_name ?? ''}`.trim() || profile.employee_id,
    };
    const entries = assignedFacultyByClass.get(row.class_record_id) ?? [];
    if (!entries.some((entry) => entry.userId === member.userId)) entries.push(member);
    assignedFacultyByClass.set(row.class_record_id, entries);
  }
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
      return { ...item, assignedFaculty: assignedFacultyByClass.get(item.id) ?? [], workspace: await loadClassWorkspace(item.id, undefined, undefined, privateDefinition) };
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
    .select('id,department_id,code,title,units,lecture_units,laboratory_units,status,created_at,updated_at')
    .order('code');
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    departmentId: row.department_id,
    code: row.code,
    title: row.title,
    units: Number(row.units),
    lectureUnits: Number(row.lecture_units ?? 3),
    laboratoryUnits: Number(row.laboratory_units ?? 0),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function loadClassCreationReferences(departmentId?: string): Promise<{
  subjects: { id: string; label: string; lectureUnits: number; laboratoryUnits: number }[];
  terms: { id: string; label: string }[];
  faculty: DepartmentFacultyMember[];
  institutionCode: string;
  sections: { value: string; label: string; programCode: string; yearLevel: number; sectionNumber: number }[];
}> {
  const [subjectsResult, termsResult, facultyResult, programsResult, sectionsResult, institutionResult] = await Promise.all([
    client().from('subjects').select('id,code,title,lecture_units,laboratory_units').eq('status', 'active').order('code'),
    client().from('academic_terms').select('id,academic_year,semester').in('status', ['active', 'planned']).order('starts_on', { ascending: false }),
    client().from('faculty_profiles').select('profile_id,employee_id,profiles!faculty_profiles_profile_id_fkey(first_name,last_name)').eq('status', 'active').order('employee_id'),
    (() => {
      const query = client().from('programs').select('id,code').eq('status', 'active').order('code');
      return departmentId ? query.eq('department_id', departmentId) : query;
    })(),
    client().from('program_sections').select('program_id,year_level,section_number').order('year_level').order('section_number'),
    client().from('system_settings').select('value').eq('key', 'academic.institution_code').maybeSingle(),
  ]);
  const error = subjectsResult.error ?? termsResult.error ?? facultyResult.error ?? programsResult.error ?? sectionsResult.error ?? institutionResult.error;
  if (error) throw error;
  const institutionCode = typeof institutionResult.data?.value === 'string' && institutionResult.data.value.trim() ? institutionResult.data.value.trim().toUpperCase() : 'SWU';
  const programCodes = new Map((programsResult.data ?? []).map((row: any) => [row.id, row.code]));
  const sections = (sectionsResult.data ?? []).flatMap((row: any) => {
    const programCode = programCodes.get(row.program_id);
    if (!programCode) return [];
    const value = institutionalSectionName({ programCode, yearLevel: Number(row.year_level), sectionNumber: Number(row.section_number) }, institutionCode);
    return [{ value, label: value, programCode, yearLevel: Number(row.year_level), sectionNumber: Number(row.section_number) }];
  });
  return {
    subjects: (subjectsResult.data ?? []).map((row: any) => ({ id: row.id, label: `${row.code} · ${row.title}`, lectureUnits: Number(row.lecture_units ?? 3), laboratoryUnits: Number(row.laboratory_units ?? 0) })),
    terms: (termsResult.data ?? []).map((row: any) => ({ id: row.id, label: `${row.academic_year} · ${row.semester}` })),
    faculty: (facultyResult.data ?? []).map((row: any) => ({
      userId: row.profile_id,
      name: `${row.profiles?.first_name ?? ''} ${row.profiles?.last_name ?? ''}`.trim() || row.employee_id,
      employeeId: row.employee_id,
    })),
    institutionCode,
    sections: [...new Map<string, typeof sections[number]>(sections.map((section) => [section.value, section] as const)).values()],
  };
}

export async function loadDepartmentClassRequests(): Promise<ClassRequestReview[]> {
  const { data, error } = await client().from('class_requests')
    .select('id,requested_by,subject_id,academic_term_id,section,rationale,status,review_note,created_at,profiles!class_requests_requested_by_fkey(first_name,last_name),subjects(code,title,lecture_units,laboratory_units),academic_terms(academic_year,semester)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    requestedBy: row.requested_by,
    requesterName: `${row.profiles?.first_name ?? ''} ${row.profiles?.last_name ?? ''}`.trim() || 'Faculty member',
    subjectId: row.subject_id,
    subject: `${row.subjects?.code ?? '—'} · ${row.subjects?.title ?? 'Subject'}`,
    academicTermId: row.academic_term_id,
    term: `${row.academic_terms?.academic_year ?? ''} ${row.academic_terms?.semester ?? ''}`.trim(),
    section: row.section,
    lectureUnits: Number(row.subjects?.lecture_units ?? 3),
    laboratoryUnits: Number(row.subjects?.laboratory_units ?? 0),
    rationale: row.rationale,
    status: row.status,
    reviewNote: row.review_note ?? null,
    createdAt: row.created_at,
  }));
}

export async function createAcademicAdminClass(input: {
  subjectId: string;
  termId: string;
  section: string;
  facultyUserIds: string[];
  requestId?: string;
}): Promise<string> {
  const { data, error } = await client().rpc('academic_admin_create_class', {
    p_subject_id: input.subjectId,
    p_academic_term_id: input.termId,
    p_section: input.section.trim(),
    p_faculty_user_ids: input.facultyUserIds,
    p_request_id: input.requestId ?? null,
  });
  if (error) {
    if (error.code === '23505') throw new Error('A class for this subject and section already exists in this term.');
    throw error;
  }
  return data as string;
}

export async function updateAcademicAdminClassFaculty(classRecordId: string, facultyUserIds: string[]): Promise<void> {
  const { error } = await client().rpc('academic_admin_update_class_faculty', {
    p_class_record_id: classRecordId,
    p_faculty_user_ids: facultyUserIds,
  });
  if (error) throw error;
}

export async function rejectAcademicAdminClassRequest(requestId: string, reviewNote: string): Promise<void> {
  const { error } = await client().rpc('academic_admin_reject_class_request', {
    p_request_id: requestId,
    p_review_note: reviewNote.trim(),
  });
  if (error) throw error;
}

export async function manageSubject(input: {
  subjectId?: string;
  departmentId: string;
  code: string;
  title: string;
  units: number;
  lectureUnits?: number;
  laboratoryUnits?: number;
  status: 'active' | 'inactive';
}): Promise<string> {
  const rpc = input.lectureUnits != null && input.laboratoryUnits != null ? 'academic_admin_manage_subject_unit_split' : 'academic_admin_manage_subject';
  const args = rpc === 'academic_admin_manage_subject_unit_split' ? {
    p_subject_id: input.subjectId ?? null,
    p_department_id: input.departmentId,
    p_code: input.code.trim(),
    p_title: input.title.trim(),
    p_lecture_units: input.lectureUnits,
    p_laboratory_units: input.laboratoryUnits,
    p_status: input.status,
  } : {
    p_subject_id: input.subjectId ?? null,
    p_department_id: input.departmentId,
    p_code: input.code.trim(),
    p_title: input.title.trim(),
    p_units: input.units,
    p_status: input.status,
  };
  const { data, error } = await client().rpc(rpc, args);
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
    .select('id,department_id,requested_by,code,title,units,lecture_units,laboratory_units,rationale,status,review_note,reviewed_at,created_at,profiles!subject_requests_requested_by_fkey(first_name,last_name)')
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
    lectureUnits: Number(row.lecture_units),
    laboratoryUnits: Number(row.laboratory_units),
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
