import { getErrorMessage } from '@/services/errors';
import {
  isSwunextComponent,
  parseCsv,
  summarizeSwunextGrade,
  calculateGradingSystem,
  calculateTrend,
  IT_GLOBAL_GRADING_SYSTEM,
  validateGradingSystem,
  type GradingDefinition,
  validateCsvRows,
  type SwunextAssessmentComponent,
  type SwunextGradeBreakdown,
} from '@apms/domain';
import { DEFAULT_EVALUATION_SYSTEM, evaluateStudentPerformanceDetailed, removeStandaloneMasteryFactor, validateEvaluationSystem, type EvaluationDefinition, type EvaluationValue } from '@apms/domain';
import * as XLSX from 'xlsx';

import { supabase } from './supabase';

const CLASS_WORKSPACE_PAGE_SIZE = 1000;

async function fetchAllPages<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += CLASS_WORKSPACE_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + CLASS_WORKSPACE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < CLASS_WORKSPACE_PAGE_SIZE) return { data: rows, error: null };
  }
}

async function fetchAllForIds<T>(ids: string[], fetchPage: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown | null }>, batchSize = 50) {
  const rows: T[] = [];
  const batches = Array.from({ length: Math.ceil(ids.length / batchSize) }, (_, index) => ids.slice(index * batchSize, (index + 1) * batchSize));
  const maxConcurrentBatches = 4;
  for (let index = 0; index < batches.length; index += maxConcurrentBatches) {
    const batchResults = await Promise.all(batches.slice(index, index + maxConcurrentBatches).map((batch) =>
      fetchAllPages((from, to) => fetchPage(batch, from, to)),
    ));
    for (const result of batchResults) rows.push(...result.data);
  }
  return { data: rows, error: null };
}

export type FacultyClass = {
  id: string;
  subjectId: string;
  code: string;
  title: string;
  section: string;
  term: string;
  studentCount: number;
};

export type FacultyEvaluationCriteriaSummary = {
  classId: string;
  name: string;
  version: number | null;
  source: 'private' | 'department';
  definition?: EvaluationDefinition;
};

export type FacultyReferenceData = {
  subjects: { id: string; code: string; title: string }[];
  terms: { id: string; label: string; status: 'active' | 'planned' }[];
  programs: { id: string; code: string; name: string }[];
};

export type RosterStudent = {
  classNumber: number;
  enrollmentId: string;
  studentId: string;
  programId: string;
  institutionalId: string;
  name: string;
  email: string;
  program: string;
  yearLevel: number;
  section: string;
};

export type FacultyAssessment = {
  id: string;
  title: string;
  type: string;
  component: SwunextAssessmentComponent;
  moduleNumber: number | null;
  maximumScore: number;
  assessmentDate: string;
  gradingPeriod: string;
  source: string;
  gradingTypeId?: string | null;
  gradingGroupId?: string | null;
  gradingPeriodId?: string | null;
  instanceWeight?: number | null;
  optional?: boolean;
};

export type FacultyCriteria = {
  id: string;
  name: string;
  version: number;
  passingThreshold: number;
  nodes: { id: string; label: string; weight: number }[];
  gradingSystemId?: string;
  gradingSystemDefinition?: GradingDefinition;
};

export type FacultyAttendanceSession = { id: string; date: string; label: string };
export type EvaluationRow = {
  enrollmentId: string;
  currentStanding: number | null;
  riskLevel: 'low' | 'medium' | 'high' | 'unavailable' | 'unknown';
  predictedStanding: number | null;
  riskProbability?: number | null;
  predictionGeneratedAt?: string | null;
  dataBasis?: string | null;
  trend: 'improving' | 'stable' | 'declining' | 'unknown';
  factors: string[];
};
export type FeedbackRecord = {
  id: string;
  enrollmentId: string;
  body: string;
  category: string;
  status: 'draft' | 'ready' | 'sent' | 'published' | 'failed' | 'archived';
  createdAt: string;
};

export type ClassWorkspace = {
  students: RosterStudent[];
  assessments: FacultyAssessment[];
  scores: Record<string, number>;
  categoricalScores: Record<string, string>;
  criteria: FacultyCriteria | null;
  defaultGradingSystem?: GradingDefinition;
  semesterEndsOn?: string | null;
  evaluationSystem?: EvaluationDefinition;
  hasPrivateEvaluationSystem?: boolean;
  hasPersonalClassEvaluationSystem?: boolean;
  hasClassEvaluationSystem?: boolean;
  attendanceSessions: FacultyAttendanceSession[];
  attendance: Record<string, 'present' | 'absent' | 'late' | 'excused'>;
  evaluations: Record<string, EvaluationRow>;
  feedback: Record<string, FeedbackRecord[]>;
};

export const swunextCriteriaNodes = [
  { label: 'Start of Class', weight: 5 },
  { label: "Let's Practice", weight: 35 },
  { label: 'Reflection', weight: 15 },
  { label: 'Wrap-Up Quiz', weight: 15 },
  { label: 'Final Project / Output', weight: 30 },
];

function connected() {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  return supabase;
}

export async function loadFacultyClasses(): Promise<FacultyClass[]> {
  const client = connected();
  const { data, error } = await client
    .from('class_records')
    .select('id,subject_id,section,subjects(code,title),academic_terms(academic_year,semester),enrollments(count)')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    subjectId: row.subject_id,
    code: row.subjects?.code ?? '—',
    title: row.subjects?.title ?? 'Untitled subject',
    section: row.section,
    term: `${row.academic_terms?.academic_year ?? ''} ${row.academic_terms?.semester ?? ''}`.trim(),
    studentCount: Number(row.enrollments?.[0]?.count ?? 0),
  }));
}

export async function loadFacultyEvaluationCriteriaLibrary(classIds: string[], userId: string) {
  if (!classIds.length || !userId) return { departmentSystems: [] as { id: string; name: string; version: number; definition: EvaluationDefinition; updatedAt: string | null; updatedBy: string | null }[], byClass: [] as FacultyEvaluationCriteriaSummary[] };
  const client = connected();
  const [systemsResult, assignmentsResult, privateResult] = await Promise.all([
    client.from('evaluation_criteria_systems').select('id,name,version,definition,updated_at,updated_by_name').order('updated_at', { ascending: false }),
    client.from('class_evaluation_criteria').select('class_record_id,evaluation_system_id').in('class_record_id', classIds),
    client.from('faculty_class_evaluation_systems').select('class_record_id,definition').eq('faculty_user_id', userId).in('class_record_id', classIds),
  ]);
  const error = systemsResult.error ?? assignmentsResult.error ?? privateResult.error;
  if (error) throw error;
  const departmentSystems = (systemsResult.data ?? []).flatMap((row: any) => {
    const definition = row.definition as EvaluationDefinition;
    return definition && validateEvaluationSystem(definition).valid ? [{
      id: row.id, name: row.name, version: Number(row.version), definition: removeStandaloneMasteryFactor(definition),
      updatedAt: row.updated_at ?? null, updatedBy: row.updated_by_name ?? null,
    }] : [];
  });
  const definitionsById = new Map(departmentSystems.map((system) => [system.id, system]));
  const byClass = new Map<string, FacultyEvaluationCriteriaSummary>();
  for (const row of assignmentsResult.data ?? []) {
    const system = definitionsById.get(row.evaluation_system_id);
    if (system) byClass.set(row.class_record_id, { classId: row.class_record_id, name: system.name, version: system.version, source: 'department' });
  }
  for (const row of privateResult.data ?? []) {
    const definition = row.definition as EvaluationDefinition;
    if (definition && validateEvaluationSystem(definition).valid) byClass.set(row.class_record_id, { classId: row.class_record_id, name: definition.name, version: definition.definitionVersion ?? null, source: 'private', definition: removeStandaloneMasteryFactor(definition) });
  }
  return { departmentSystems, byClass: [...byClass.values()] };
}

export async function loadFacultyReferenceData(): Promise<FacultyReferenceData> {
  const client = connected();
  // Subjects are now filtered by the database RLS policy:
  // Faculty only see active subjects in their own assigned department.
  // No client-side department filter is needed or trusted.
  const [subjects, terms, programs] = await Promise.all([
    client.from('subjects').select('id,code,title').order('code'),
    client.from('academic_terms').select('id,academic_year,semester,status').in('status', ['active', 'planned']).order('starts_on', { ascending: false }),
    client.from('programs').select('id,code,name').eq('status', 'active').order('code'),
  ]);
  const error = subjects.error ?? terms.error ?? programs.error;
  if (error) throw error;
  return {
    subjects: subjects.data ?? [],
    terms: (terms.data ?? []).map((row) => ({
      id: row.id,
      label: `${row.academic_year} · ${row.semester}`,
      status: row.status as 'active' | 'planned',
    })),
    programs: programs.data ?? [],
  };
}

export async function createFacultyClass(subjectId: string, termId: string, section: string) {
  const { data, error } = await connected().rpc('faculty_create_class', {
    p_subject_id: subjectId,
    p_academic_term_id: termId,
    p_section: section.trim(),
  });
  if (error) {
    // Translate PostgreSQL unique-constraint violation into a user-friendly message.
    if (error.code === '23505' || error.message?.includes('class_records_subject_id_academic_term_id_section_key')) {
      throw new Error('A class for this subject and section already exists in this term. Use a different section identifier.');
    }
    // Surface other actionable messages from the RPC directly.
    throw error;
  }
  return data as string;
}

// ─── Subject requests ────────────────────────────────────────────────────────

export type SubjectRequest = {
  id: string;
  departmentId: string;
  code: string;
  title: string;
  units: number;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewNote: string | null;
  createdAt: string;
};

export async function submitSubjectRequest(input: {
  code: string;
  title: string;
  units: number;
  rationale: string;
}): Promise<string> {
  const { data, error } = await connected().rpc('faculty_submit_subject_request', {
    p_code: input.code.trim(),
    p_title: input.title.trim(),
    p_units: input.units,
    p_rationale: input.rationale.trim(),
  });
  if (error) throw error;
  return data as string;
}

export async function loadMySubjectRequests(): Promise<SubjectRequest[]> {
  const { data, error } = await connected()
    .from('subject_requests')
    .select('id,department_id,code,title,units,rationale,status,review_note,created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    departmentId: row.department_id,
    code: row.code,
    title: row.title,
    units: Number(row.units),
    rationale: row.rationale,
    status: row.status,
    reviewNote: row.review_note ?? null,
    createdAt: row.created_at,
  }));
}

export type StudentInput = {
  classId: string;
  programId: string;
  institutionalId: string;
  email: string;
  firstName: string;
  lastName: string;
  yearLevel: number;
  section: string;
};

export async function addStudentToClass(input: StudentInput) {
  const { data, error } = await connected().rpc('faculty_upsert_student_enrollment', {
    p_class_record_id: input.classId,
    p_program_id: input.programId,
    p_institutional_id: input.institutionalId.trim(),
    p_email: input.email.trim().toLowerCase(),
    p_first_name: input.firstName.trim(),
    p_last_name: input.lastName.trim(),
    p_year_level: input.yearLevel,
    p_section: input.section.trim(),
  });
  if (error) throw error;
  return data as string;
}

export async function updateStudentDetails(studentId: string, input: Omit<StudentInput, 'classId'>) {
  const { data, error } = await connected()
    .from('students')
    .update({
      program_id: input.programId,
      institutional_id: input.institutionalId.trim(),
      email: input.email.trim().toLowerCase(),
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      year_level: input.yearLevel,
      section: input.section.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', studentId)
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function removeStudentsFromClass(classId: string, enrollmentIds: string[]) {
  if (!enrollmentIds.length) return;
  const { error } = await connected().from('enrollments').delete().eq('class_record_id', classId).in('id', enrollmentIds);
  if (error) throw error;
}

export type RosterCsvValue = Omit<StudentInput, 'classId' | 'programId'>;

export function normalizeRosterRows(rows: Record<string, string>[]) {
  const aliases: Record<string, string[]> = {
    institutional_id: ['institutional_id', 'student_id', 'student_number', 'student_no', 'student number', 'id'],
    first_name: ['first_name', 'firstname', 'given_name', 'given name'],
    last_name: ['last_name', 'lastname', 'surname', 'family_name', 'family name'],
    full_name: ['full_name', 'fullname', 'full name', 'student_name', 'student name', 'name'],
    email: ['email', 'email_address', 'email address', 'institutional_email'],
    year_level: ['year_level', 'year level', 'year', 'grade', 'level'],
    section: ['section', 'class_section', 'class section', 'section_name'],
  };
  return rows.map((row) => {
    const entries = Object.entries(row).map(([key, value]) => [key.trim().toLowerCase().replaceAll(/\s+/g, ' '), value] as const);
    const values = Object.fromEntries(entries);
    const get = (field: string) => aliases[field].map((alias) => values[alias]).find((value) => value?.trim())?.trim() ?? '';
    const fullName = get('full_name');
    const nameParts = fullName.split(/\s+/).filter(Boolean);
    return {
      ...row,
      institutional_id: get('institutional_id'),
      first_name: get('first_name') || nameParts.shift() || '',
      last_name: get('last_name') || nameParts.join(' '),
      email: get('email'),
      year_level: get('year_level'),
      section: get('section'),
    };
  });
}

function validateRosterRows(rows: Record<string, string>[]) {
  return validateCsvRows(normalizeRosterRows(rows), (row) => {
    const institutionalId = row.institutional_id?.trim();
    const firstName = row.first_name?.trim();
    const lastName = row.last_name?.trim();
    const email = row.email?.trim().toLowerCase();
    const section = row.section?.trim();
    const yearLevel = Number(row.year_level);
    const errors: string[] = [];
    if (!institutionalId) errors.push('institutional_id is required; APMS cannot invent an official student number');
    if (!firstName) errors.push('first_name is required');
    if (!lastName) errors.push('last_name is required');
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) errors.push('valid email is required');
    if (!Number.isInteger(yearLevel) || yearLevel < 1 || yearLevel > 8) errors.push('year_level must be 1–8');
    if (!section) errors.push('section is required');
    return {
      errors,
      duplicateKey: institutionalId?.toLowerCase(),
      value: errors.length ? undefined : { institutionalId, firstName, lastName, email, yearLevel, section } as RosterCsvValue,
    };
  });
}

export function previewRosterCsv(csvText: string) {
  return validateRosterRows(parseCsv(csvText));
}

export function previewRosterExcel(fileData: ArrayBuffer) {
  const workbook = XLSX.read(fileData, { type: 'array', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  if (!sheet) throw new Error('Excel workbook must contain at least one worksheet.');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' }).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim().toLowerCase(), String(value ?? '').trim()])),
  );
  if (!rows.length) throw new Error('The first Excel worksheet does not contain any student rows.');
  return validateRosterRows(rows);
}

async function importRosterPreview(classId: string, programId: string, fileName: string, preview: ReturnType<typeof previewRosterCsv>, fileType: 'csv' | 'xlsx') {
  const client = connected();
  const valid = preview.filter((row) => row.value && row.errors.length === 0 && !row.duplicate);
  const { data: job, error: jobError } = await client.from('import_jobs').insert({
    type: fileType, scope_type: 'class_record', scope_id: classId, status: 'running',
    total_count: preview.length, success_count: 0, failure_count: preview.length - valid.length,
    initiated_by: (await client.auth.getUser()).data.user?.id,
    file_name: fileName, import_kind: 'roster',
    column_mapping: { institutional_id: 'institutional_id', first_name: 'first_name', last_name: 'last_name', email: 'email', year_level: 'year_level', section: 'section' },
  }).select('id').single();
  if (jobError) throw jobError;
  let success = 0;
  for (const row of valid) {
    try {
      await addStudentToClass({ classId, programId, ...row.value! });
      success += 1;
    } catch (cause) {
      row.errors.push(getErrorMessage(cause, 'Import failed'));
    }
  }
  const failures = preview.length - success;
  const detailRows = preview.map((row) => ({
    import_job_id: job.id, row_number: row.rowNumber, raw_data: row.raw,
    normalized_data: row.value ?? null, status: row.errors.length ? 'invalid' : 'imported', errors: row.errors,
  }));
  if (detailRows.length) await client.from('import_job_rows').insert(detailRows);
  await client.from('import_jobs').update({
    status: failures ? (success ? 'completed' : 'failed') : 'completed', success_count: success,
    failure_count: failures, completed_at: new Date().toISOString(), summary: { imported: success, rejected: failures },
  }).eq('id', job.id);
  return { preview, success, failures };
}

export async function importRosterCsv(classId: string, programId: string, fileName: string, csvText: string) {
  return importRosterPreview(classId, programId, fileName, previewRosterCsv(csvText), 'csv');
}

export async function importRosterExcel(classId: string, programId: string, fileName: string, fileData: ArrayBuffer) {
  return importRosterPreview(classId, programId, fileName, previewRosterExcel(fileData), 'xlsx');
}

export async function loadClassWorkspace(classId: string, departmentEvaluationSystem?: EvaluationDefinition, facultyUserId?: string, personalClassEvaluationSystem?: EvaluationDefinition, options: { includeAttendance?: boolean; includeFeedback?: boolean } = {}): Promise<ClassWorkspace> {
  const client = connected();
  const includeAttendance = options.includeAttendance ?? true;
  const includeFeedback = options.includeFeedback ?? true;
  const [enrollments, assessments, criteriaSets, sessions, defaultSystemSetting, classMetaResult] = await Promise.all([
    fetchAllPages((from, to) => client.from('enrollments').select('id,student_id,students(program_id,institutional_id,email,first_name,last_name,year_level,section,programs(id,code))').eq('class_record_id', classId).eq('status', 'active').order('created_at').order('id').range(from, to)),
    fetchAllPages((from, to) => client.from('assessments').select('id,title,type,component_key,module_number,maximum_score,assessment_date,grading_period,source,grading_type_id,grading_group_id,grading_period_id,grading_instance_weight,optional').eq('class_record_id', classId).neq('status', 'archived').order('assessment_date').order('id').range(from, to)),
    client.from('criteria_sets').select('id,name,version,passing_threshold,grading_system_id,grading_system_definition,criteria_nodes(id,label,weight)').eq('class_record_id', classId).eq('status', 'active').order('version', { ascending: false }).limit(1),
    includeAttendance
      ? fetchAllPages((from, to) => client.from('attendance_sessions').select('id,session_date,label').eq('class_record_id', classId).order('session_date', { ascending: false }).order('id').range(from, to))
      : Promise.resolve({ data: [], error: null }),
    client.from('system_settings').select('value').eq('key', 'grading.default_system_definition').maybeSingle(),
    client.from('class_records').select('department_id,academic_terms(starts_on,ends_on)').eq('id', classId).single(),
  ]);
  const firstError = enrollments.error ?? assessments.error ?? criteriaSets.error ?? sessions.error ?? classMetaResult.error;
  if (firstError) throw firstError;
  const classMeta = classMetaResult.data as any;
  let evaluationRow: { definition?: unknown } | null = null;
  let hasPrivateEvaluationSystem = false;
  let hasClassEvaluationSystem = false;
  if (!departmentEvaluationSystem) {
    const [facultyEvaluationResult] = await Promise.all([
      facultyUserId
        ? client.from('faculty_class_evaluation_systems').select('definition').eq('class_record_id', classId).eq('faculty_user_id', facultyUserId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (facultyEvaluationResult.error) throw facultyEvaluationResult.error;
    if (facultyEvaluationResult.data) {
      evaluationRow = facultyEvaluationResult.data;
      hasPrivateEvaluationSystem = true;
    }
    if (!evaluationRow) {
      const [assignmentResult, departmentResult] = await Promise.all([
        client.from('class_evaluation_criteria').select('evaluation_criteria_systems(definition)').eq('class_record_id', classId).maybeSingle(),
        client.from('evaluation_systems').select('definition').eq('department_id', classMeta.department_id).maybeSingle(),
      ]);
      if (assignmentResult.error) throw assignmentResult.error;
      if (departmentResult.error) throw departmentResult.error;
      const related: any = (assignmentResult.data as any)?.evaluation_criteria_systems;
      if (related?.definition) { evaluationRow = { definition: related.definition }; hasClassEvaluationSystem = true; }
      else evaluationRow = departmentResult.data;
    }
  }
  const students: RosterStudent[] = (enrollments.data ?? []).map((row: any, index: number) => ({
    classNumber: index + 1,
    enrollmentId: row.id, studentId: row.student_id, institutionalId: row.students?.institutional_id,
    programId: row.students?.program_id,
    name: `${row.students?.first_name ?? ''} ${row.students?.last_name ?? ''}`.trim(), email: row.students?.email ?? '',
    program: row.students?.programs?.code ?? '—', yearLevel: Number(row.students?.year_level ?? 0), section: row.students?.section ?? '',
  }));
  const assessmentRows: FacultyAssessment[] = (assessments.data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    component: isSwunextComponent(row.component_key) ? row.component_key : componentFromLegacyType(row.type),
    moduleNumber: row.module_number == null ? null : Number(row.module_number),
    maximumScore: Number(row.maximum_score),
    assessmentDate: row.assessment_date,
    gradingPeriod: row.grading_period, source: row.source,
    gradingTypeId: row.grading_type_id, gradingGroupId: row.grading_group_id, gradingPeriodId: row.grading_period_id, instanceWeight: row.grading_instance_weight == null ? null : Number(row.grading_instance_weight), optional: Boolean(row.optional),
  }));
  const enrollmentIds = students.map((row) => row.enrollmentId);
  const assessmentIds = assessmentRows.map((row) => row.id);
  const sessionIds = (sessions.data ?? []).map((row) => row.id);
  const [results, attendance, evaluations, predictions, feedback] = await Promise.all([
    assessmentIds.length ? fetchAllForIds(assessmentIds, (ids, from, to) => client.from('assessment_results').select('assessment_id,enrollment_id,score,categorical_value').in('assessment_id', ids).order('assessment_id').order('enrollment_id').range(from, to), 25) : Promise.resolve({ data: [], error: null }),
    includeAttendance && sessionIds.length ? fetchAllForIds(sessionIds, (ids, from, to) => client.from('attendance_records').select('attendance_session_id,enrollment_id,status').in('attendance_session_id', ids).order('attendance_session_id').order('enrollment_id').range(from, to), 25) : Promise.resolve({ data: [], error: null }),
    enrollmentIds.length ? fetchAllForIds(enrollmentIds, (ids, from, to) => client.from('performance_evaluations').select('enrollment_id,score,risk_level,explanation').in('enrollment_id', ids).order('enrollment_id').range(from, to)) : Promise.resolve({ data: [], error: null }),
    enrollmentIds.length ? fetchAllForIds(enrollmentIds, (ids, from, to) => client.from('performance_predictions').select('enrollment_id,predicted_score,risk_level,trend,confidence,explanation,created_at').in('enrollment_id', ids).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)) : Promise.resolve({ data: [], error: null }),
    includeFeedback && enrollmentIds.length ? fetchAllForIds(enrollmentIds, (ids, from, to) => client.from('feedback_records').select('id,enrollment_id,body,category,status,created_at').in('enrollment_id', ids).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)) : Promise.resolve({ data: [], error: null }),
  ]);
  const secondaryError = results.error ?? attendance.error ?? evaluations.error ?? predictions.error ?? feedback.error;
  if (secondaryError) throw secondaryError;
  const scoreMap: Record<string, number> = {};
  const categoricalScoreMap: Record<string, string> = {};
  for (const row of results.data ?? []) {
    const key = `${row.enrollment_id}:${row.assessment_id}`;
    if (row.categorical_value != null) categoricalScoreMap[key] = row.categorical_value;
    else if (row.score != null) scoreMap[key] = Number(row.score);
  }
  const attendanceMap: ClassWorkspace['attendance'] = {};
  for (const row of attendance.data ?? []) attendanceMap[`${row.attendance_session_id}:${row.enrollment_id}`] = row.status as ClassWorkspace['attendance'][string];
  const evaluationMap: Record<string, EvaluationRow> = {};
  for (const row of evaluations.data ?? []) evaluationMap[row.enrollment_id] = {
    enrollmentId: row.enrollment_id, currentStanding: Number(row.score), riskLevel: row.risk_level,
    predictedStanding: null, trend: 'unknown', factors: Array.isArray((row.explanation as any)?.factors) ? (row.explanation as any).factors : [],
  };
  for (const row of predictions.data ?? []) {
    const current = evaluationMap[row.enrollment_id] ?? { enrollmentId: row.enrollment_id, currentStanding: null, riskLevel: 'unknown', predictedStanding: null, trend: 'unknown', factors: [] };
    if (current.predictedStanding == null) {
      current.predictedStanding = Number(row.predicted_score); current.riskLevel = row.risk_level; current.trend = row.trend; current.riskProbability = row.confidence == null ? null : Number(row.confidence); current.predictionGeneratedAt = row.created_at; current.dataBasis = (row.explanation as any)?.data_basis ?? null;
      current.factors = Array.isArray((row.explanation as any)?.factors) ? (row.explanation as any).factors : current.factors;
      evaluationMap[row.enrollment_id] = current;
    }
  }
  const feedbackMap: Record<string, FeedbackRecord[]> = {};
  for (const row of feedback.data ?? []) {
    const items = feedbackMap[row.enrollment_id] ?? [];
    items.push({
      id: row.id,
      enrollmentId: row.enrollment_id,
      body: row.body,
      category: row.category,
      status: row.status as FeedbackRecord['status'],
      createdAt: row.created_at,
    });
    feedbackMap[row.enrollment_id] = items;
  }
  const criteriaRow: any = criteriaSets.data?.[0];
  const configuredDefault = defaultSystemSetting.data?.value as GradingDefinition | undefined;
  const defaultGradingSystem = configuredDefault && validateGradingSystem(configuredDefault).valid ? configuredDefault : IT_GLOBAL_GRADING_SYSTEM;
  const savedEvaluationSystem = personalClassEvaluationSystem ?? departmentEvaluationSystem ?? evaluationRow?.definition as EvaluationDefinition | undefined;
  const evaluationSystem = savedEvaluationSystem && validateEvaluationSystem(savedEvaluationSystem).valid ? removeStandaloneMasteryFactor(savedEvaluationSystem) : DEFAULT_EVALUATION_SYSTEM;
  return {
    students, assessments: assessmentRows, scores: scoreMap, categoricalScores: categoricalScoreMap, attendance: attendanceMap, evaluations: evaluationMap,
    attendanceSessions: (sessions.data ?? []).map((row) => ({ id: row.id, date: row.session_date, label: row.label })),
    defaultGradingSystem,
    semesterEndsOn: classMeta?.academic_terms?.ends_on ?? null,
    evaluationSystem,
    hasPrivateEvaluationSystem,
    hasPersonalClassEvaluationSystem: !!personalClassEvaluationSystem,
    hasClassEvaluationSystem,
    criteria: criteriaRow ? { id: criteriaRow.id, name: criteriaRow.name, version: criteriaRow.version, passingThreshold: Number(criteriaRow.passing_threshold), gradingSystemId: criteriaRow.grading_system_id, gradingSystemDefinition: criteriaRow.grading_system_definition ?? undefined, nodes: (criteriaRow.criteria_nodes ?? []).map((node: any) => ({ id: node.id, label: node.label, weight: Number(node.weight) })) } : null,
    feedback: feedbackMap,
  };
}

export type AssessmentInput = {
  title: string;
  type: string;
  component: SwunextAssessmentComponent;
  moduleNumber: number | null;
  maximumScore: number;
  date: string;
  gradingPeriod: string;
  source: 'manual' | 'csv';
  gradingTypeId?: string | null;
  gradingGroupId?: string | null;
  gradingPeriodId?: string | null;
  instanceWeight?: number | null;
};

export async function createAssessment(classId: string, userId: string, input: AssessmentInput) {
  const { error } = await connected().from('assessments').insert({ class_record_id: classId, title: input.title.trim(), type: input.type.trim(), component_key: input.component, module_number: input.moduleNumber, maximum_score: input.maximumScore, due_at: `${input.date}T17:00:00+08:00`, status: 'published', created_by: userId, source: input.source, assessment_date: input.date, grading_period: input.gradingPeriod.trim(), grading_type_id: input.gradingTypeId ?? null, grading_group_id: input.gradingGroupId ?? null, grading_period_id: input.gradingPeriodId ?? null, grading_instance_weight: input.instanceWeight ?? null });
  if (error) throw error;
}

export async function updateAssessment(assessmentId: string, input: AssessmentInput) {
  const { error } = await connected().from('assessments').update({
    title: input.title.trim(),
    type: input.type.trim(),
    component_key: input.component,
    module_number: input.moduleNumber,
    maximum_score: input.maximumScore,
    due_at: `${input.date}T17:00:00+08:00`,
    source: input.source,
    assessment_date: input.date,
    grading_period: input.gradingPeriod.trim(),
    grading_type_id: input.gradingTypeId ?? null,
    grading_group_id: input.gradingGroupId ?? null,
    grading_period_id: input.gradingPeriodId ?? null,
    grading_instance_weight: input.instanceWeight ?? null,
    updated_at: new Date().toISOString(),
  }).eq('id', assessmentId);
  if (error) throw error;
}

export async function saveScores(userId: string, assessmentId: string, scores: { enrollmentId: string; score?: number; categoricalValue?: string }[]) {
  await saveScoreBatch(userId, scores.map((row) => ({ assessmentId, ...row })));
}

export async function saveScoreBatch(_userId: string, scores: { assessmentId: string; enrollmentId: string; score?: number; categoricalValue?: string }[]) {
  if (!scores.length) return;
  const { error } = await connected().rpc('save_gradebook_score_batch', {
    score_changes: scores.map((row) => ({
      assessment_id: row.assessmentId,
      enrollment_id: row.enrollmentId,
      score: row.categoricalValue == null ? row.score ?? null : null,
      categorical_value: row.categoricalValue ?? null,
    })),
  });
  if (error) throw error;
}

export async function loadAssessmentScoreHistory(assessmentId: string, enrollmentId: string) {
  const { data, error } = await connected().from('gradebook_score_versions')
    .select('id,actor_id,actor_name,action,before_data,after_data,created_at,restored_from_version_id,batch_id')
    .eq('assessment_id', assessmentId)
    .eq('enrollment_id', enrollmentId)
    .order('created_at', { ascending: false })
    .limit(250);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: String(row.id),
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorName: row.actor_name ? String(row.actor_name) : null,
    action: String(row.action ?? ''),
    createdAt: String(row.created_at),
    before: row.before_data ?? null,
    after: row.after_data ?? null,
    restoredFromVersionId: row.restored_from_version_id ? String(row.restored_from_version_id) : null,
    batchId: row.batch_id ? String(row.batch_id) : null,
  }));
}

export type GradebookHistoryCursor = { createdAt: string; id: string };
export type GradebookHistoryPage = {
  entries: {
    id: string;
    eventType: 'score' | 'assessment';
    assessmentId: string;
    enrollmentId: string;
    actorId: string | null;
    actorName: string | null;
    action: string;
    createdAt: string;
    before: any;
    after: any;
    restoredFromVersionId: string | null;
    versionName: string | null;
    batchId: string | null;
  }[];
  nextCursor: GradebookHistoryCursor | null;
  hasMore: boolean;
};

export async function loadGradebookScoreHistory(classId: string, cursor?: GradebookHistoryCursor | null, pageSize = 100): Promise<GradebookHistoryPage> {
  const client = connected();
  let query = client.from('gradebook_version_history')
    .select('id,event_type,assessment_id,enrollment_id,actor_id,actor_name,action,before_data,after_data,created_at,restored_from_version_id,version_name,batch_id')
    .eq('class_record_id', classId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(Math.min(200, Math.max(1, pageSize)) + 1);
  if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []).slice(0, Math.min(200, Math.max(1, pageSize)));
  const entries = rows.map((row: any) => ({
    id: String(row.id),
    eventType: row.event_type === 'assessment' ? 'assessment' as const : 'score' as const,
    assessmentId: String(row.assessment_id),
    enrollmentId: row.enrollment_id ? String(row.enrollment_id) : '',
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorName: row.actor_name ? String(row.actor_name) : null,
    action: String(row.action ?? ''),
    createdAt: String(row.created_at),
    before: row.before_data ?? null,
    after: row.after_data ?? null,
    restoredFromVersionId: row.restored_from_version_id ? String(row.restored_from_version_id) : null,
    versionName: row.version_name ? String(row.version_name) : null,
    batchId: row.batch_id ? String(row.batch_id) : null,
  }));
  const last = rows.at(-1) as any;
  return {
    entries,
    nextCursor: last ? { createdAt: String(last.created_at), id: String(last.id) } : null,
    hasMore: (data ?? []).length > rows.length,
  };
}

export async function restoreAssessmentScoreVersion(versionId: string, restoreBefore = false, restoreBatch = false) {
  const { error } = await connected().rpc('restore_assessment_score_version', { target_version_id: versionId, restore_before: restoreBefore, restore_batch: restoreBatch });
  if (error) throw error;
}

export async function restoreGradebookToVersion(versionId: string) {
  const { data, error } = await connected().rpc('restore_gradebook_to_version', { target_version_id: versionId });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function restoreAssessmentInstanceVersion(versionId: string) {
  const client = connected();
  const { data: history, error: historyError } = await client.from('gradebook_version_history')
    .select('event_type,action,before_data,after_data')
    .eq('id', versionId)
    .eq('event_type', 'assessment')
    .single();
  if (historyError) throw historyError;

  // A deletion's last saved assessment is its before snapshot; other events
  // restore the state captured after that change.
  const snapshot = history.action.endsWith('.delete') ? history.before_data : history.after_data ?? history.before_data;
  if (!snapshot?.id || !snapshot?.class_record_id) throw new Error('The saved assessment version is incomplete.');
  const fields = [
    'id', 'class_record_id', 'criteria_node_id', 'title', 'type', 'maximum_score',
    'due_at', 'status', 'created_by', 'created_at', 'component_key', 'module_number',
    'assessment_date', 'grading_period', 'source', 'grading_type_id', 'grading_group_id',
    'grading_period_id', 'grading_instance_weight', 'optional',
  ];
  const restored = Object.fromEntries(fields.filter((field) => field in snapshot).map((field) => [field, snapshot[field]]));
  const { data: current, error: currentError } = await client.from('assessments').select('id').eq('id', snapshot.id).maybeSingle();
  if (currentError) throw currentError;
  if (current) {
    const { id: _id, class_record_id: _classId, created_by: _createdBy, created_at: _createdAt, ...updates } = restored;
    const { error } = await client.from('assessments').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', snapshot.id);
    if (error) throw error;
  } else {
    const { error } = await client.from('assessments').insert(restored);
    if (error) throw error;
  }
}

export async function nameGradebookScoreVersion(versionId: string, name: string) {
  const client = connected();
  const { data: version, error: lookupError } = await client.from('gradebook_version_history')
    .select('event_type,batch_id')
    .eq('id', versionId)
    .single();
  if (lookupError) throw lookupError;
  if (version.event_type === 'assessment') {
    const { error } = await client.from('gradebook_assessment_version_names').upsert({
      audit_log_id: versionId,
      version_name: name.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'audit_log_id' });
    if (error) throw error;
    return;
  }
  let query = client.from('gradebook_score_versions')
    .update({ version_name: name.trim() || null })
    .select('id');
  query = version.batch_id ? query.eq('batch_id', version.batch_id) : query.eq('id', versionId);
  const { error } = await query;
  if (error) throw error;
}

export async function createAttendanceSession(classId: string, userId: string, date: string, label: string) {
  const { data, error } = await connected().from('attendance_sessions').insert({ class_record_id: classId, session_date: date, label: label.trim() || 'Class session', created_by: userId }).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function saveAttendance(userId: string, sessionId: string, rows: { enrollmentId: string; status: 'present' | 'absent' | 'late' | 'excused' }[]) {
  const { error } = await connected().from('attendance_records').upsert(rows.map((row) => ({ attendance_session_id: sessionId, enrollment_id: row.enrollmentId, status: row.status, recorded_by: userId })), { onConflict: 'attendance_session_id,enrollment_id' });
  if (error) throw error;
}

export async function saveCriteria(classId: string, userId: string, name: string, passingThreshold: number, nodes: { label: string; weight: number }[]) {
  const total = nodes.reduce((sum, node) => sum + node.weight, 0);
  if (total !== 100) throw new Error('Criteria weights must total exactly 100%.');
  if (!userId) throw new Error('An authenticated user is required.');
  const { error } = await connected().rpc('save_criteria_version', {
    p_class_id: classId,
    p_name: name.trim(),
    p_passing_threshold: passingThreshold,
    p_nodes: nodes,
  });
  if (error) throw error;
}

export async function applyFacultyEvaluationSystemToClasses(classIds: string[], userId: string, definition: EvaluationDefinition) {
  const validation = validateEvaluationSystem(definition);
  if (!validation.valid) throw new Error(validation.errors.join('\n'));
  if (!userId) throw new Error('An authenticated Faculty user is required.');
  const client = connected();
  const outcomes = await Promise.allSettled(classIds.map(async (classId) => {
    const { data, error } = await client.from('faculty_class_evaluation_systems').upsert({
      class_record_id: classId,
      faculty_user_id: userId,
      definition,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'class_record_id,faculty_user_id' }).select('class_record_id').single();
    if (error) throw error;
    if (!data) throw new Error('This class is not assigned to your Faculty account.');
  }));
  return {
    applied: classIds.filter((_, index) => outcomes[index].status === 'fulfilled'),
    failures: classIds.flatMap((classId, index) => {
      const outcome = outcomes[index];
      if (outcome.status !== 'rejected') return [];
      const reason = outcome.reason;
      const message = getErrorMessage(reason, 'Could not apply evaluation criteria to this class.');
      return [{ classId, message }];
    }),
  };
}

export async function deleteFacultyClassEvaluationSystem(classId: string, userId: string) {
  if (!classId || !userId) throw new Error('An authenticated Faculty user and class are required.');
  const { data, error } = await connected().from('faculty_class_evaluation_systems').delete()
    .eq('class_record_id', classId).eq('faculty_user_id', userId).select('class_record_id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Your private criteria could not be deleted. It may no longer be assigned to you.');
}

export async function saveGradingSystem(userId: string, definition: GradingDefinition) {
  const validation = validateGradingSystem(definition);
  if (!validation.valid) throw new Error(validation.errors.join('\n'));
  if (!userId) throw new Error('An authenticated user is required.');
  const { error } = await connected().from('grading_systems').upsert({
    id: definition.id, name: definition.name, description: definition.description ?? null,
    definition, is_builtin: false, created_by: userId, updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw error;
}

export async function deleteGradingSystem(userId: string, gradingSystemId: string) {
  if (!userId) throw new Error('An authenticated user is required.');
  if (!gradingSystemId || gradingSystemId === IT_GLOBAL_GRADING_SYSTEM.id) throw new Error('The built-in grading system cannot be deleted.');
  const client = connected();
  const { data: usage, error: usageError } = await client.from('criteria_sets').select('id').eq('grading_system_id', gradingSystemId).limit(1);
  if (usageError) throw usageError;
  if (usage?.length) throw new Error('This grading system is applied to a class and cannot be deleted.');
  const { data, error } = await client.from('grading_systems').delete().eq('id', gradingSystemId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This grading system could not be deleted. It may be in use or you may not have permission.');
}

export async function applyGradingSystem(classId: string, userId: string, definition: GradingDefinition) {
  const validation = validateGradingSystem(definition);
  if (!validation.valid) throw new Error(validation.errors.join('\n'));
  await saveCriteria(classId, userId, definition.name, definition.finalGradeConversion.passingPercentage ?? 80, [{ label: definition.name, weight: 100 }]);
  const client = connected();
  const { data, error } = await client.from('criteria_sets').select('id').eq('class_record_id', classId).eq('status', 'active').order('version', { ascending: false }).limit(1).single();
  if (error) throw error;
  const { error: updateError } = await client.from('criteria_sets').update({ grading_system_id: definition.id, grading_system_definition: definition }).eq('id', data.id);
  if (updateError) throw updateError;
}

export async function applyGradingSystemToClasses(classIds: string[], userId: string, definition: GradingDefinition) {
  const outcomes = await Promise.allSettled(classIds.map((classId) => applyGradingSystem(classId, userId, definition)));
  return {
    applied: classIds.filter((_, index) => outcomes[index].status === 'fulfilled'),
    failures: classIds.flatMap((classId, index) => {
      const outcome = outcomes[index];
      if (outcome.status !== 'rejected') return [];
      const reason = outcome.reason;
      const message = getErrorMessage(reason, 'Could not apply this grading system.');
      return [{ classId, message }];
    }),
  };
}

function componentFromLegacyType(type: string): SwunextAssessmentComponent {
  const normalized = type.trim().toLowerCase().replaceAll(/[\s-]+/g, '_');
  if (isSwunextComponent(normalized)) return normalized;
  if (normalized.includes('attendance') || normalized.includes('start')) return 'start_of_class';
  if (normalized.includes('practice') || normalized.includes('activity')) return 'lets_practice';
  if (normalized.includes('reflection')) return 'reflection';
  if (normalized.includes('quiz')) return 'wrap_up_quiz';
  if (normalized.includes('check')) return 'project_checkin';
  if (normalized.includes('project') || normalized.includes('performance')) return 'final_project';
  return 'other';
}

export function calculateEnrollmentGrade(workspace: ClassWorkspace, enrollmentId: string) {
  const gradingSystem = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const periods: any[] = gradingSystem.periods ?? [];
  const scores = workspace.assessments.map((assessment) => {
    const groupId = assessment.gradingGroupId ?? (assessment.moduleNumber == null ? null : `m${assessment.moduleNumber}`);
    const periodId = assessment.gradingPeriodId ?? periods.find((period) => groupId && period.groupIds?.includes(groupId))?.id ?? null;
    return { id: assessment.id, typeId: assessment.gradingTypeId ?? assessment.component, score: workspace.categoricalScores[`${enrollmentId}:${assessment.id}`] ?? workspace.scores[`${enrollmentId}:${assessment.id}`] ?? null, maximumScore: assessment.maximumScore, weight: assessment.instanceWeight ?? undefined, periodId, groupId };
  });
  return calculateGradingSystem(gradingSystem, scores);
}

export function summarizeEnrollmentStanding(workspace: ClassWorkspace, enrollmentId: string): SwunextGradeBreakdown {
  const gradingSystem = workspace.criteria?.gradingSystemDefinition ?? workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const calculated = calculateEnrollmentGrade(workspace, enrollmentId);
  if (gradingSystem) {
    return { ...summarizeSwunextGrade([]), p1: calculated.periods.p1 ?? null, p2: calculated.periods.p2 ?? null, p3: calculated.periods.p3 ?? null, finalGrade: calculated.finalGrade, pointGrade: calculated.pointGrade, mastery: calculated.components.mg ?? null, remarks: calculated.remarks } as SwunextGradeBreakdown;
  }
  return summarizeSwunextGrade(workspace.assessments.map((assessment) => ({
    component: assessment.component,
    moduleNumber: assessment.moduleNumber,
    maximumScore: assessment.maximumScore,
    score: workspace.scores[`${enrollmentId}:${assessment.id}`] ?? null,
  })));
}

export type PredictionInput = {
  enrollmentId: string;
  currentStanding: number;
  recentScores: number[];
  attendanceRate: number;
  missingAssessmentCount: number;
  evaluationValues: EvaluationValue;
  recordContext: Record<string, unknown>;
};

export type PredictionResult = {
  enrollmentId: string;
  predictedStanding: number;
  riskProbability: number | null;
  riskLevel: 'low' | 'medium' | 'high' | 'unavailable';
  trend: 'improving' | 'stable' | 'declining';
  factors: string[];
  modelVersion: string;
  dataBasis: string;
};

function aiServiceUrl() {
  return process.env.EXPO_PUBLIC_APMS_AI_SERVICE_URL ?? process.env.APMS_AI_SERVICE_URL ?? '';
}

export async function runAiPredictions(classId: string, gradingSystem: GradingDefinition, evaluationCriteria: EvaluationDefinition, inputs: PredictionInput[]) {
  const endpoint = aiServiceUrl();
  if (!inputs.length) throw new Error('At least one student needs scores before prediction can run.');
  if (!validateGradingSystem(gradingSystem).valid) throw new Error('The applied grading system is invalid. Fix it before running predictions.');
  if (!validateEvaluationSystem(evaluationCriteria).valid) throw new Error('The applied evaluation criteria are invalid. Fix them before running predictions.');
  const rawPredictions: { input: PredictionInput; predictedStanding: number; riskProbability: number | null; aiRiskLevel: string | null; trend: PredictionResult['trend']; factors: string[]; modelVersion: string; dataBasis: string }[] = [];
  if (endpoint) {
    for (const input of inputs) {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollment_id: input.enrollmentId,
          grading_system: gradingSystem,
          evaluation_criteria: evaluationCriteria,
          evaluation_values: input.evaluationValues,
          student_records: input.recordContext,
        }),
      });
      if (!response.ok) throw new Error(`AI prediction failed (${response.status}). Student records remain available.`);
      const payload = await response.json();
      rawPredictions.push({
        input,
        predictedStanding: Number(payload.predicted_standing),
        riskProbability: payload.risk_probability == null || !Number.isFinite(Number(payload.risk_probability)) ? null : Number(payload.risk_probability),
        aiRiskLevel: typeof payload.ai_risk_level === 'string' ? payload.ai_risk_level : typeof payload.risk_level === 'string' ? payload.risk_level : null,
        trend: ['improving', 'stable', 'declining'].includes(payload.trend) ? payload.trend : 'stable',
        factors: Array.isArray(payload.factors) ? payload.factors : [],
        modelVersion: String(payload.model_version ?? 'external-ai-service'),
        dataBasis: String(payload.data_basis ?? 'applied_schema_context'),
      });
    }
  } else {
    const { data, error } = await connected().functions.invoke('apms-predictions', {
      body: {
        class_id: classId,
        grading_system: gradingSystem,
        evaluation_criteria: evaluationCriteria,
        inputs: inputs.map((input) => ({
          enrollment_id: input.enrollmentId,
          evaluation_values: input.evaluationValues,
          records: input.recordContext,
        })),
      },
    });
    if (error) {
      let detail = '';
      const functionError = error as typeof error & { context?: Response };
      if (functionError.context) {
        try {
          const body = await functionError.context.clone().json() as { error?: string; message?: string };
          detail = body.error ?? body.message ?? '';
        } catch { /* Use the SDK error when the response is not JSON. */ }
      }
      throw new Error(detail || error.message || 'AI prediction could not run. Student records remain available.');
    }
    const payload = data as { predictions?: any[]; model_version?: string; data_basis?: string };
    const resultByEnrollment = new Map((payload.predictions ?? []).map((result) => [result.enrollment_id, result]));
    for (const input of inputs) {
      const result = resultByEnrollment.get(input.enrollmentId);
      if (!result) throw new Error('Prediction response did not include every requested student.');
      rawPredictions.push({
        input,
        predictedStanding: Number(result.predicted_standing),
        riskProbability: result.risk_probability == null || !Number.isFinite(Number(result.risk_probability)) ? null : Number(result.risk_probability),
        aiRiskLevel: typeof result.ai_risk_level === 'string' ? result.ai_risk_level : typeof result.risk_level === 'string' ? result.risk_level : null,
        trend: ['improving', 'stable', 'declining'].includes(result.trend) ? result.trend : 'stable',
        factors: Array.isArray(result.factors) ? result.factors : [],
        modelVersion: payload.model_version ?? 'unversioned',
        dataBasis: payload.data_basis ?? 'applied_schema_context',
      });
    }
  }
  const predictions: PredictionResult[] = rawPredictions.map((prediction) => {
    const predictedStanding = Math.min(100, Math.max(0, prediction.predictedStanding));
    const riskProbability = prediction.riskProbability == null ? null : Math.min(1, Math.max(0, prediction.riskProbability));
    const values: EvaluationValue = {
      ...prediction.input.evaluationValues,
      predicted_standing: predictedStanding,
      risk_probability: riskProbability,
      model_confidence: riskProbability,
      prediction_available: true,
      trend: prediction.trend,
      recent_trend: prediction.trend,
      ai_risk_level: prediction.aiRiskLevel,
      prediction_age_hours: 0,
    };
    const evaluation = evaluateStudentPerformanceDetailed(evaluationCriteria, values);
    return {
      enrollmentId: prediction.input.enrollmentId,
      predictedStanding,
      riskProbability,
      riskLevel: evaluation.severity,
      trend: prediction.trend,
      factors: prediction.factors,
      modelVersion: prediction.modelVersion,
      dataBasis: prediction.dataBasis,
    };
  });
  const { data, error } = await connected().rpc('faculty_save_prediction_run', {
    p_class_record_id: classId,
    p_model_name: 'APMS AI Service',
    p_model_version: predictions[0]?.modelVersion ?? 'unversioned',
    p_input_snapshot: { grading_system: gradingSystem, evaluation_criteria: evaluationCriteria, inputs, advisory_only: true },
    p_predictions: predictions.map((prediction) => ({
      enrollment_id: prediction.enrollmentId,
      predicted_score: prediction.predictedStanding,
      trend: prediction.trend,
      risk_level: prediction.riskLevel,
      confidence: prediction.riskProbability,
      factors: prediction.factors,
      data_basis: prediction.dataBasis,
    })),
  });
  if (error) throw error;
  return { runId: data as string, predictions };
}

export async function saveFacultyFeedback(enrollmentId: string, body: string, category: string, status: 'draft' | 'published', feedbackId?: string) {
  const { data, error } = await connected().rpc('faculty_upsert_feedback', {
    p_feedback_id: feedbackId ?? null,
    p_enrollment_id: enrollmentId,
    p_body: body,
    p_category: category,
    p_status: status,
  });
  if (error) throw error;
  return data as string;
}

export async function sendFacultyFeedbackEmail(enrollmentId: string, body: string, category: string, feedbackId?: string) {
  const { data, error } = await connected().functions.invoke('apms-feedback-send', {
    body: { enrollment_id: enrollmentId, body, category, feedback_id: feedbackId ?? null },
  });
  if (error) {
    let detail = '';
    const functionError = error as typeof error & { context?: Response };
    if (functionError.context) {
      try {
        const payload = await functionError.context.clone().json() as { error?: string; message?: string };
        detail = payload.error ?? payload.message ?? '';
      } catch { /* Fall back to the SDK error when the response body is not JSON. */ }
    }
    throw new Error(detail || error.message || 'Feedback email could not be sent.');
  }
  const result = data as { feedback_id?: unknown; recipient?: unknown } | null;
  if (typeof result?.feedback_id !== 'string' || typeof result.recipient !== 'string') {
    throw new Error('The email service returned an invalid response.');
  }
  return result;
}

export async function generateFacultyFeedbackDraft(classId: string, enrollmentId: string, studentName: string, records: Record<string, unknown>) {
  const { data, error } = await connected().functions.invoke('apms-feedback-draft', {
    body: { class_id: classId, enrollment_id: enrollmentId, student_name: studentName, records },
  });
  if (error) {
    let detail = '';
    const functionError = error as typeof error & { context?: Response };
    if (functionError.context) {
      try {
        const payload = await functionError.context.clone().json() as { error?: string; message?: string };
        detail = payload.error ?? payload.message ?? '';
      } catch { /* Fall back to the SDK error when the response body is not JSON. */ }
    }
    throw new Error(detail || error.message || 'Gemini could not generate a feedback draft.');
  }
  const draft = (data as { body?: unknown } | null)?.body;
  if (typeof draft !== 'string' || !draft.trim()) throw new Error('Gemini returned an empty feedback draft.');
  return draft.trim();
}

export function exportClassCsv(workspace: ClassWorkspace) {
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const header = ['Student ID', 'Student', 'P1 Running', 'P2 Running', 'P3 Effortful Learning', 'Mastery', 'Final Grade', 'Grade Point', 'Remarks', ...workspace.assessments.map((assessment) => `${assessment.title} (${assessment.maximumScore})`)];
  const rows = workspace.students.map((student) => {
    const summary = summarizeEnrollmentStanding(workspace, student.enrollmentId);
    return [
      student.institutionalId,
      student.name,
      summary.p1 == null ? '' : summary.p1,
      summary.p2 == null ? '' : summary.p2,
      summary.p3 == null ? '' : summary.p3,
      summary.mastery == null ? '' : summary.mastery,
      summary.finalGrade == null ? '' : summary.finalGrade,
      summary.gradePoint == null ? '' : summary.gradePoint.toFixed(2),
      summary.remarks,
      ...workspace.assessments.map((assessment) => workspace.categoricalScores[`${student.enrollmentId}:${assessment.id}`] ?? workspace.scores[`${student.enrollmentId}:${assessment.id}`] ?? ''),
    ];
  });
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
}
