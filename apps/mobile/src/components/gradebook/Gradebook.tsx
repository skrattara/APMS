/**
 * Working copy of the Faculty gradebook workflow. Keep the original Faculty
 * implementation available while this component is integrated and reviewed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge, Button, Card, Field, PageState, SelectField, Tabs } from '@/components/ui';
import { useAuth } from '@/auth/AuthProvider';
import { getErrorMessage } from '@/services/errors';
import { loadAutosavePreference } from '@/services/actions';
import type { ClassWorkspace, FacultyAssessment, GradebookHistoryCursor, GradebookHistoryPage, RosterStudent } from '@/services/faculty';
import { calculateEnrollmentGrade, summarizeEnrollmentStanding } from '@/services/faculty';
import { IT_GLOBAL_GRADING_SYSTEM, swunextAssessmentComponents, type SwunextAssessmentComponent } from '@apms/domain';
import type { GradebookProps } from './types';
import { FullAssessmentView as GradebookFullView } from './FullAssessmentView';
import { styles } from '@/screens/FacultyLivePortalContent.styles';
import {
  assessmentAggregationMode,
  assessmentTypeDefaults,
  assessmentTypeScope,
  assessmentOptionLabel,
  assessmentHelp,
  riskFor,
  currentStanding,
  attendanceRate,
  missingAssessments,
  ClassSelect,
  AssessmentDialog,
  Dialog,
  Heading,
  highestCategory,
  emptyAssessmentForm,
  type AssessmentFormState,
} from '@/screens/FacultyLivePortalContent';
import {
  calculateFullViewGrades,
  gradePercent,
  type FullViewColumn,
} from './model';
import {
  gradebookSelectOptions,
  storedAssessmentValue,
  validateAssessmentValue,
  validateScore,
  valueMappingForType,
} from './shared';
import { componentLabel } from './model';
export function Gradebook(props: GradebookProps) {
  type ScoreEdit = { key: string; before?: string; after?: string };
  type ScoreEditBatch = { view: 'assessment' | 'full'; changes: ScoreEdit[] };
  const activeGradingSystem = props.workspace.criteria?.gradingSystemDefinition ?? props.workspace.defaultGradingSystem ?? IT_GLOBAL_GRADING_SYSTEM;
  const [gradebookView, setGradebookView] = useState<'assessment' | 'full'>('assessment');
  const [assessmentId, setAssessmentId] = useState(props.workspace.assessments[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [fullValues, setFullValues] = useState<Record<string, string>>({});
  const scoreUndoRef = useRef<ScoreEditBatch[]>([]);
  const scoreRedoRef = useRef<ScoreEditBatch[]>([]);
  const savedUndoRef = useRef<GradebookHistoryPage['entries']>([]);
  const savedRedoRef = useRef<GradebookHistoryPage['entries']>([]);
  const savedHistoryCursorRef = useRef<GradebookHistoryCursor | null>(null);
  const savedHistoryHasMoreRef = useRef(false);
  const savedHistoryLoadedRef = useRef(false);
  const savedHistoryBusyRef = useRef(false);
  const [scoreHistoryRevision, setScoreHistoryRevision] = useState(0);
  const [savedHistoryBusy, setSavedHistoryBusy] = useState(false);
  const selectedClassIdRef = useRef(props.selectedClassId);
  selectedClassIdRef.current = props.selectedClassId;
  const clearScoreHistory = () => { scoreUndoRef.current = []; scoreRedoRef.current = []; setScoreHistoryRevision((revision) => revision + 1); };
  const resetSavedScoreHistory = () => {
    savedUndoRef.current = [];
    savedRedoRef.current = [];
    savedHistoryCursorRef.current = null;
    savedHistoryHasMoreRef.current = false;
    savedHistoryLoadedRef.current = false;
    setScoreHistoryRevision((revision) => revision + 1);
  };
  const loadSavedScoreHistoryPage = async (append: boolean) => {
    const classId = props.selectedClassId;
    const page = await props.onLoadGradebookHistory(classId, append ? savedHistoryCursorRef.current : null);
    if (selectedClassIdRef.current !== classId) return;
    const scoreEntries = page.entries.filter((entry) => entry.eventType === 'score');
    savedUndoRef.current = append ? [...savedUndoRef.current, ...scoreEntries] : scoreEntries;
    savedHistoryCursorRef.current = page.nextCursor;
    savedHistoryHasMoreRef.current = page.hasMore;
    savedHistoryLoadedRef.current = true;
    if (!append) savedRedoRef.current = [];
    setScoreHistoryRevision((revision) => revision + 1);
  };
  const refreshSavedScoreHistory = async () => {
    try { await loadSavedScoreHistoryPage(false); } catch { /* Keep the current saved history cache if refresh fails. */ }
  };
  const handleRestoreScoreVersion = async (versionId: string, targetAssessmentId: string, enrollmentId: string, restoreBefore = false, restoreBatch = false) => {
    await props.onRestoreScoreVersion(versionId, restoreBefore, restoreBatch);
    const key = `${enrollmentId}:${targetAssessmentId}`;
    setFullValues((current) => { const next = { ...current }; delete next[key]; return next; });
    if (assessmentId === targetAssessmentId) setValues((current) => { const next = { ...current }; delete next[enrollmentId]; return next; });
    await refreshSavedScoreHistory();
    props.refresh();
  };
  const handleRestoreGradebookVersion = async (versionId: string) => {
    const affected = await props.onRestoreGradebookVersion(versionId);
    setFullValues({});
    setValues({});
    clearScoreHistory();
    await refreshSavedScoreHistory();
    props.refresh();
    return affected;
  };
  const updatePendingScores = (view: 'assessment' | 'full', updates: Record<string, string>) => {
    const currentValues = view === 'full' ? fullValues : values;
    const changes = Object.entries(updates).flatMap(([key, after]) => currentValues[key] === after ? [] : [{ key, ...(Object.prototype.hasOwnProperty.call(currentValues, key) ? { before: currentValues[key] } : {}), after }]);
    if (!changes.length) return;
    scoreUndoRef.current.push({ view, changes });
    scoreRedoRef.current = [];
    savedRedoRef.current = [];
    setScoreHistoryRevision((revision) => revision + 1);
    const updater = (current: Record<string, string>) => ({ ...current, ...updates });
    if (view === 'full') setFullValues(updater); else setValues(updater);
  };
  const applyScoreHistory = (batch: ScoreEditBatch, direction: 'undo' | 'redo') => {
    const changes = Object.fromEntries(batch.changes.map((change) => [change.key, direction === 'undo' ? change.before : change.after]));
    const apply = (current: Record<string, string>) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete next[key]; else next[key] = value;
      }
      return next;
    };
    if (batch.view === 'full') setFullValues(apply); else setValues(apply);
  };
  const clearPendingScoreOverlay = (entry: GradebookHistoryPage['entries'][number]) => {
    const key = `${entry.enrollmentId}:${entry.assessmentId}`;
    setFullValues((current) => { const next = { ...current }; delete next[key]; return next; });
    if (assessmentId === entry.assessmentId) setValues((current) => { const next = { ...current }; delete next[entry.enrollmentId]; return next; });
  };
  const restoreSavedHistoryEntry = async (entry: GradebookHistoryPage['entries'][number], direction: 'undo' | 'redo') => {
    await props.onRestoreScoreVersion(entry.id, direction === 'undo', true);
    clearPendingScoreOverlay(entry);
    if (direction === 'undo') savedRedoRef.current.push(entry);
    else savedUndoRef.current.unshift(entry);
    props.refresh();
    setScoreHistoryRevision((revision) => revision + 1);
  };
  const savedHistoryGroupKey = (entry: GradebookHistoryPage['entries'][number]) => entry.batchId ?? entry.id;
  const undoScoreEdit = () => {
    const batch = scoreUndoRef.current.pop();
    if (batch) { scoreRedoRef.current.push(batch); applyScoreHistory(batch, 'undo'); setScoreHistoryRevision((revision) => revision + 1); return; }
    if (savedHistoryBusyRef.current) return;
    savedHistoryBusyRef.current = true;
    setSavedHistoryBusy(true);
    void (async () => {
      try {
        if (!savedHistoryLoadedRef.current) await loadSavedScoreHistoryPage(false);
        while (!savedUndoRef.current.length && savedHistoryHasMoreRef.current) await loadSavedScoreHistoryPage(true);
        const entry = savedUndoRef.current[0];
        if (!entry) { props.toast.show('There are no saved score changes to undo.'); return; }
        const groupKey = savedHistoryGroupKey(entry);
        while (savedHistoryHasMoreRef.current && savedUndoRef.current.at(-1) && savedHistoryGroupKey(savedUndoRef.current.at(-1)!) === groupKey) await loadSavedScoreHistoryPage(true);
        await restoreSavedHistoryEntry(entry, 'undo');
        savedUndoRef.current = savedUndoRef.current.filter((item) => savedHistoryGroupKey(item) !== groupKey);
      } catch (cause) { props.toast.show(getErrorMessage(cause, 'The saved score change could not be undone.')); }
      finally { savedHistoryBusyRef.current = false; setSavedHistoryBusy(false); setScoreHistoryRevision((revision) => revision + 1); }
    })();
  };
  const redoScoreEdit = () => {
    const batch = scoreRedoRef.current.pop();
    if (batch) { scoreUndoRef.current.push(batch); applyScoreHistory(batch, 'redo'); setScoreHistoryRevision((revision) => revision + 1); return; }
    if (savedHistoryBusyRef.current) return;
    const entry = savedRedoRef.current.at(-1);
    if (!entry) return;
    savedHistoryBusyRef.current = true;
    setSavedHistoryBusy(true);
    void restoreSavedHistoryEntry(entry, 'redo').then(() => { savedRedoRef.current.pop(); }).catch((cause) => props.toast.show(getErrorMessage(cause, 'The saved score change could not be redone.'))).finally(() => {
      savedHistoryBusyRef.current = false;
      setSavedHistoryBusy(false);
      setScoreHistoryRevision((revision) => revision + 1);
    });
  };
  const updatePendingScoresRef = useRef(updatePendingScores);
  updatePendingScoresRef.current = updatePendingScores;
  const handleFullValueChange = useCallback((key: string, value: string) => updatePendingScoresRef.current('full', { [key]: value }), []);
  const handleFullValuesChange = useCallback((updates: Record<string, string>) => updatePendingScoresRef.current('full', updates), []);
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accountAutosaveEnabled, setAccountAutosaveEnabled] = useState(true);
  const [accountAutosaveLoaded, setAccountAutosaveLoaded] = useState(false);
  const [pageAutosaveEnabled, setPageAutosaveEnabled] = useState(true);
  const autosaveEnabled = accountAutosaveEnabled && pageAutosaveEnabled;
  const lastAutomaticSave = useRef('');
  const [studentQuery, setStudentQuery] = useState('');
  const [studentFilter, setStudentFilter] = useState<'all' | 'missing' | 'at_risk' | 'passing'>('all');
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [bulkScore, setBulkScore] = useState('');
  const [studentSort, setStudentSort] = useState<'class_number' | 'name' | 'risk' | 'standing'>('class_number');
  const [page, setPage] = useState(1);
  const [paginationByView, setPaginationByView] = useState({ assessment: true, full: false });
  const paginationEnabled = paginationByView[gradebookView];
  const [form, setForm] = useState<AssessmentFormState>(emptyAssessmentForm);

  useEffect(() => {
    if (!props.workspace.assessments.some((item) => item.id === assessmentId)) {
      setAssessmentId(props.workspace.assessments[0]?.id ?? '');
    }
  }, [assessmentId, props.workspace.assessments]);
  useEffect(() => {
    setValues({}); setFullValues({}); setSelectedStudents([]); clearScoreHistory(); resetSavedScoreHistory();
  }, [props.selectedClassId]);
  const { user } = useAuth();
  useEffect(() => {
    let active = true;
    setAccountAutosaveLoaded(false);
    void loadAutosavePreference(user?.id).then((enabled) => {
      if (active) { setAccountAutosaveEnabled(enabled); setPageAutosaveEnabled(enabled); setAccountAutosaveLoaded(true); }
    }).catch(() => { if (active) setAccountAutosaveLoaded(true); });
    return () => { active = false; };
  }, [user?.id]);

  const selected = props.workspace.assessments.find((item) => item.id === assessmentId);
  const selectedCategoryMapping = selected ? valueMappingForType(activeGradingSystem, selected.gradingTypeId ?? selected.component) : undefined;
  const effectiveScore = (enrollmentId: string) => values[enrollmentId] ?? String(storedAssessmentValue(props.workspace, enrollmentId, assessmentId) ?? '');
  const fullDirtyEntries = Object.entries(fullValues).flatMap(([key, value]) => {
    const separator = key.indexOf(':');
    if (separator < 0) return [];
    const enrollmentId = key.slice(0, separator);
    const targetAssessmentId = key.slice(separator + 1);
    const assessment = props.workspace.assessments.find((item) => item.id === targetAssessmentId);
    if (!assessment) return [];
    const saved = storedAssessmentValue(props.workspace, enrollmentId, targetAssessmentId);
    if (value.trim() === (saved == null ? '' : String(saved))) return [];
    const mapping = valueMappingForType(activeGradingSystem, assessment.gradingTypeId ?? assessment.component);
    return [{ enrollmentId, assessment, value: value.trim(), error: validateAssessmentValue(value, assessment.maximumScore, mapping), mapping }];
  });
  const fullInvalidEntries = fullDirtyEntries.filter((entry) => entry.error);
  const dirtyCount = selected
    ? props.workspace.students.filter((student) => {
        const next = effectiveScore(student.enrollmentId).trim();
        const saved = storedAssessmentValue(props.workspace, student.enrollmentId, selected.id);
        return next !== (saved == null ? '' : String(saved));
      }).length
    : 0;
  const scoreErrorFor = (studentId: string) => validateAssessmentValue(effectiveScore(studentId), selected?.maximumScore ?? 0, selectedCategoryMapping);
  const invalidScoreCount = selected ? props.workspace.students.filter((student) => !!scoreErrorFor(student.enrollmentId)).length : 0;
  const hasInvalidScores = invalidScoreCount > 0;
  const insertionOrder = useMemo(() => new Map(props.workspace.students.map((student, index) => [student.enrollmentId, index])), [props.workspace.students]);
  const riskByStudent = useMemo(() => studentFilter === 'at_risk' || studentSort === 'risk'
    ? new Map(props.workspace.students.map((student) => [student.enrollmentId, riskFor(props.workspace, student.enrollmentId)]))
    : new Map<string, string>(), [props.workspace, studentFilter, studentSort]);
  const standingByStudent = useMemo(() => studentFilter === 'passing' || studentSort === 'standing'
    ? new Map(props.workspace.students.map((student) => [student.enrollmentId, calculateEnrollmentGrade(props.workspace, student.enrollmentId).finalGrade]))
    : new Map<string, number | null>(), [props.workspace, studentFilter, studentSort]);
  const visibleStudents = useMemo(() => {
    const normalizedQuery = studentQuery.trim().toLowerCase();
    const filtered = props.workspace.students.filter((student) => {
      const matchesQuery = !normalizedQuery || `${student.name} ${student.institutionalId}`.toLowerCase().includes(normalizedQuery);
      if (!matchesQuery) return false;
      if (studentFilter === 'missing') return gradebookView === 'assessment'
        ? effectiveScore(student.enrollmentId).trim() === ''
        : props.workspace.assessments.some((item) => !String(fullValues[`${student.enrollmentId}:${item.id}`] ?? storedAssessmentValue(props.workspace, student.enrollmentId, item.id) ?? '').trim());
      if (studentFilter === 'at_risk') return riskByStudent.get(student.enrollmentId) !== 'low';
      if (studentFilter === 'passing') return summarizeEnrollmentStanding(props.workspace, student.enrollmentId).remarks === 'passing';
      return true;
    });
    return filtered.sort((a, b) => {
      if (studentSort === 'class_number') {
        const classNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
        const aNumber = classNumber(a.classNumber);
        const bNumber = classNumber(b.classNumber);
        if (aNumber != null && bNumber != null && aNumber !== bNumber) return aNumber - bNumber;
        if (aNumber != null && bNumber == null) return -1;
        if (aNumber == null && bNumber != null) return 1;
        return (insertionOrder.get(a.enrollmentId) ?? 0) - (insertionOrder.get(b.enrollmentId) ?? 0);
      }
      if (studentSort === 'risk') {
        const rank = { high: 0, medium: 1, low: 2, unavailable: 3 } as const;
        return (rank[riskByStudent.get(a.enrollmentId) as keyof typeof rank] ?? 3) - (rank[riskByStudent.get(b.enrollmentId) as keyof typeof rank] ?? 3);
      }
      if (studentSort === 'standing') return (standingByStudent.get(b.enrollmentId) ?? -1) - (standingByStudent.get(a.enrollmentId) ?? -1);
      return a.name.localeCompare(b.name);
    });
  }, [props.workspace, studentFilter, studentQuery, studentSort, insertionOrder, riskByStudent, standingByStudent,
    studentFilter === 'missing' && gradebookView === 'assessment' ? values : null,
    studentFilter === 'missing' && gradebookView === 'full' ? fullValues : null,
    studentFilter === 'missing' && gradebookView === 'assessment' ? assessmentId : null,
    studentFilter === 'missing' ? gradebookView : null]);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(visibleStudents.length / pageSize));
  const pageStudents = paginationEnabled ? visibleStudents.slice((page - 1) * pageSize, page * pageSize) : visibleStudents;
  useEffect(() => { setPage(1); }, [assessmentId, studentFilter, studentQuery, studentSort, props.selectedClassId, props.workspace.students.length]);
  const resetForm = () => setForm(emptyAssessmentForm);
  const openCreate = () => {
    const firstType = activeGradingSystem.assessmentTypes?.[0];
    const firstPeriod = activeGradingSystem.periods?.[0];
    const scope = firstType ? assessmentTypeScope(activeGradingSystem, firstType.id) : null;
    setForm({ ...emptyAssessmentForm, ...(firstType ? assessmentTypeDefaults(activeGradingSystem, firstType.id) : {}), gradingTypeId: firstType?.id ?? '', component: swunextAssessmentComponents.some((item) => item.key === firstType?.id) ? firstType!.id as SwunextAssessmentComponent : 'other', gradingGroupId: '', moduleNumber: '', gradingPeriodId: scope?.overall ? '' : firstPeriod?.id ?? '', gradingPeriod: scope?.overall ? '' : firstPeriod?.name ?? '' });
    setOpen(true);
  };
  const openEditAssessment = (assessment: FacultyAssessment) => {
    setAssessmentId(assessment.id);
    const periods = activeGradingSystem.periods ?? [];
    const groups = activeGradingSystem.groups ?? [];
    const group = groups.find((item: { id: string }) => item.id === assessment.gradingGroupId)
      ?? groups.find((item: { id: string }) => item.id === (assessment.moduleNumber == null ? '' : `m${assessment.moduleNumber}`));
    const typeId = assessment.gradingTypeId ?? assessment.component;
    const typeScope = assessmentTypeScope(activeGradingSystem, typeId);
    const defaults = assessmentTypeDefaults(activeGradingSystem, typeId);
    const period = typeScope.overall ? undefined : periods.find((item: { id: string }) => item.id === assessment.gradingPeriodId)
      ?? periods.find((item: { name: string }) => item.name === assessment.gradingPeriod)
      ?? periods[0];
    setForm({
      title: assessment.title,
      component: assessment.component,
      gradingTypeId: typeId,
      gradingGroupId: typeScope.overall ? '' : group?.id ?? '',
      gradingPeriodId: period?.id ?? '',
      instanceWeight: ['equal', 'points'].includes(assessmentAggregationMode(activeGradingSystem, typeId)) ? '' : assessment.instanceWeight == null ? defaults.instanceWeight : String(assessment.instanceWeight),
      maximumScore: String(assessment.maximumScore),
      moduleNumber: typeScope.overall || assessment.moduleNumber == null ? '' : String(assessment.moduleNumber),
      date: assessment.assessmentDate,
      gradingPeriod: period?.name ?? '',
      source: assessment.source as 'manual' | 'csv',
    });
    setEditOpen(true);
  };
  const openEdit = () => { if (selected) openEditAssessment(selected); };

  const assessmentInput = () => ({
    ...form,
    type: form.component,
    gradingTypeId: form.gradingTypeId,
    gradingGroupId: form.gradingGroupId || null,
    gradingPeriodId: form.gradingPeriodId || null,
    instanceWeight: form.instanceWeight.trim() ? Number(form.instanceWeight) : null,
    maximumScore: Number(form.maximumScore),
    moduleNumber: form.moduleNumber.trim() ? Number(form.moduleNumber) : null,
  });

  const create = async () => {
    if (!props.selectedClassId) return;
    setSaving(true);
    try {
      await props.onCreateAssessment(props.selectedClassId, assessmentInput());
      setOpen(false);
      resetForm();
      props.toast.show('Assessment created.');
      props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Assessment creation failed.'));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await props.onUpdateAssessment(selected.id, assessmentInput());
      setEditOpen(false);
      resetForm();
      props.toast.show('Assessment updated.');
      props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Assessment update failed.'));
    } finally {
      setSaving(false);
    }
  };

  const focusFirstInvalidScore = () => {
    const sorted = [...props.workspace.students].sort((a, b) => a.name.localeCompare(b.name));
    const invalidIndex = sorted.findIndex((student) => !!scoreErrorFor(student.enrollmentId));
    if (invalidIndex < 0) return;
    setStudentQuery(''); setStudentFilter('all'); setStudentSort('name'); setPage(Math.floor(invalidIndex / pageSize) + 1);
  };

  const save = async (automatic = false) => {
    if (!selected) return;
    if (hasInvalidScores) {
      const invalidStudent = props.workspace.students.find((student) => !!scoreErrorFor(student.enrollmentId));
      focusFirstInvalidScore();
      return props.toast.show(`${invalidStudent?.name ?? 'Student'}: ${invalidStudent ? scoreErrorFor(invalidStudent.enrollmentId) : 'Score is invalid.'}`);
    }
    const rows = Object.entries(values).flatMap(([enrollmentId, value]): { enrollmentId: string; score?: number; categoricalValue?: string }[] => {
      const raw = value.trim();
      const stored = storedAssessmentValue(props.workspace, enrollmentId, selected.id);
      if (raw === (stored == null ? '' : String(stored))) return [];
      if (!raw) return stored != null ? [{ enrollmentId }] : [];
      return selectedCategoryMapping
        ? [{ enrollmentId, categoricalValue: raw }]
        : [{ enrollmentId, score: Number(raw) }];
    });
    if (!rows.length) return;
    setSaving(true);
    try {
      await props.onSaveScores(selected.id, rows);
      clearScoreHistory();
      void refreshSavedScoreHistory();
      if (!automatic) props.toast.show(`${rows.length} student scores saved.`);
      props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Scores could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const saveFullView = async (automatic = false) => {
    if (!fullDirtyEntries.length) return;
    if (fullInvalidEntries.length) {
      const firstInvalid = fullInvalidEntries[0];
      setStudentQuery(''); setStudentFilter('all'); setStudentSort('name');
      return props.toast.show(`${props.workspace.students.find((student) => student.enrollmentId === firstInvalid.enrollmentId)?.name ?? 'Student'}, ${firstInvalid.assessment.title}: ${firstInvalid.error}`);
    }
    const rows = fullDirtyEntries.map((entry) => ({
      assessmentId: entry.assessment.id,
      enrollmentId: entry.enrollmentId,
      ...(entry.value ? entry.mapping ? { categoricalValue: entry.value } : { score: Number(entry.value) } : {}),
    }));
    setSaving(true);
    try {
      await props.onSaveScoreBatch(rows);
      clearScoreHistory();
      void refreshSavedScoreHistory();
      if (!automatic) props.toast.show(`${fullDirtyEntries.length} score change${fullDirtyEntries.length === 1 ? '' : 's'} saved.`);
      props.refresh();
    } catch (cause) {
      props.toast.show(getErrorMessage(cause, 'Scores could not be saved.'));
    } finally { setSaving(false); }
  };

  useEffect(() => {
    if (!accountAutosaveLoaded || !autosaveEnabled || saving) return;
    const hasPendingChanges = gradebookView === 'full' ? fullDirtyEntries.length > 0 : dirtyCount > 0;
    const hasErrors = gradebookView === 'full' ? fullInvalidEntries.length > 0 : hasInvalidScores;
    if (!hasPendingChanges) { lastAutomaticSave.current = ''; return; }
    if (hasErrors) return;
    const signature = gradebookView === 'full'
      ? JSON.stringify([props.selectedClassId, fullDirtyEntries.map(({ enrollmentId, assessment, value }) => [enrollmentId, assessment.id, value])])
      : JSON.stringify([props.selectedClassId, assessmentId, values]);
    if (signature === lastAutomaticSave.current) return;
    const timer = setTimeout(() => {
      lastAutomaticSave.current = signature;
      if (gradebookView === 'full') void saveFullView(true);
      else void save(true);
    }, 850);
    return () => clearTimeout(timer);
  }, [accountAutosaveLoaded, autosaveEnabled, saving, gradebookView, values, fullValues, dirtyCount, fullDirtyEntries, hasInvalidScores, fullInvalidEntries, props.selectedClassId, assessmentId]);

  const toggleStudent = (enrollmentId: string) => {
    setSelectedStudents((current) => current.includes(enrollmentId) ? current.filter((id) => id !== enrollmentId) : [...current, enrollmentId]);
  };

  const selectVisible = () => setSelectedStudents((current) => Array.from(new Set([...current, ...pageStudents.map((student) => student.enrollmentId)])));
  const clearSelection = () => setSelectedStudents([]);
  const clearPageSelection = () => setSelectedStudents((current) => current.filter((id) => !pageStudents.some((student) => student.enrollmentId === id)));
  const applyBulkScore = () => {
    if (!bulkScore.trim() || !selectedStudents.length) return props.toast.show('Select students and enter a score first.');
    const error = validateAssessmentValue(bulkScore, selected?.maximumScore ?? 0, selectedCategoryMapping);
    if (error) return props.toast.show(error);
    updatePendingScores('assessment', Object.fromEntries(selectedStudents.map((id) => [id, bulkScore.trim()])));
    setBulkScore('');
    props.toast.show(`Applied ${bulkScore.trim()} to ${selectedStudents.length} students. Review before saving.`);
  };

  const pasteScores = async () => {
    if (Platform.OS !== 'web' || !globalThis.navigator?.clipboard) return props.toast.show('Clipboard paste is available in the web app.');
    try {
      const text = await globalThis.navigator.clipboard.readText();
      const scores = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\t|,/).pop()?.trim() ?? '');
      if (!scores.length) return props.toast.show('No scores found in the clipboard.');
      if (scores.length > pageStudents.length) return props.toast.show(`The clipboard has ${scores.length} scores but only ${pageStudents.length} students are visible on this page.`);
      const invalidIndex = scores.findIndex((score) => !!validateAssessmentValue(score, selected?.maximumScore ?? 0, selectedCategoryMapping));
      if (invalidIndex >= 0) return props.toast.show(selectedCategoryMapping ? `Pasted score on row ${invalidIndex + 1} is invalid. Use one of the configured categories.` : `Pasted score on row ${invalidIndex + 1} is invalid. Enter a value from 0 to ${selected?.maximumScore ?? 0}.`);
      const targets = pageStudents.slice(0, scores.length);
      updatePendingScores('assessment', Object.fromEntries(targets.map((student, index) => [student.enrollmentId, scores[index]])));
      props.toast.show(`Pasted ${targets.length} scores in visible student order. Review before saving.`);
    } catch {
      props.toast.show('Clipboard access was blocked. Copy the scores, then try again.');
    }
  };

  return (
    <>
      <Heading
        title="Class Gradebook"
        subtitle={`Grades use ${activeGradingSystem.name}. Scores are provisional monitoring indicators; official records are kept in SWU SIS.`}
        action={
          <View style={styles.actions}>
            <Button label="Edit assessment" variant="secondary" disabled={!selected} onPress={openEdit} />
            <Button label="Create assessment" onPress={openCreate} />
          </View>
        }
      />
      <ClassSelect {...props} />
      <View style={styles.gradebookTabs} {...({ dataSet: { gradebookScoreHistoryRevision: String(scoreHistoryRevision) } } as any)}>
        <Button label="Assessment View" variant={gradebookView === 'assessment' ? 'primary' : 'secondary'} onPress={() => { setGradebookView('assessment'); setPage(1); }} />
        <Button label="Full View" variant={gradebookView === 'full' ? 'primary' : 'secondary'} onPress={() => { setGradebookView('full'); setPage(1); }} />
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: paginationEnabled }} onPress={() => { setPaginationByView((current) => ({ ...current, [gradebookView]: !current[gradebookView] })); setPage(1); }} style={styles.paginationToggle}>
          <Text style={styles.paginationToggleLabel}>Pagination</Text>
          <View style={[styles.paginationSwitch, paginationEnabled && styles.paginationSwitchOn]}><View style={[styles.paginationSwitchThumb, paginationEnabled && styles.paginationSwitchThumbOn]} /></View>
          <Text style={styles.paginationToggleState}>{paginationEnabled ? 'On' : 'Off'}</Text>
        </Pressable>
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: autosaveEnabled, disabled: !accountAutosaveEnabled }} disabled={!accountAutosaveEnabled} onPress={() => setPageAutosaveEnabled((current) => !current)} style={styles.paginationToggle}>
          <Text style={styles.paginationToggleLabel}>Autosave</Text>
          <View style={[styles.paginationSwitch, autosaveEnabled && styles.paginationSwitchOn]}><View style={[styles.paginationSwitchThumb, autosaveEnabled && styles.paginationSwitchThumbOn]} /></View>
          <Text style={styles.paginationToggleState}>{accountAutosaveEnabled ? autosaveEnabled ? 'On' : 'Off' : 'Account off'}</Text>
        </Pressable>
        <Button label={savedHistoryBusy ? 'Undoing…' : 'Undo'} description={`Unsaved edits first, then saved score changes. Assessment instance edits stay in version history. ${scoreUndoRef.current.length} unsaved and ${savedUndoRef.current.length}${savedHistoryHasMoreRef.current ? '+' : ''} saved score steps loaded.`} variant="secondary" disabled={savedHistoryBusy || (!scoreUndoRef.current.length && savedHistoryLoadedRef.current && !savedUndoRef.current.length && !savedHistoryHasMoreRef.current)} onPress={undoScoreEdit} />
        <Button label={savedHistoryBusy ? 'Working…' : 'Redo'} description={`Unsaved edits first, then saved score changes. Assessment instance edits stay in version history. ${scoreRedoRef.current.length} unsaved and ${savedRedoRef.current.length} saved score steps available.`} variant="secondary" disabled={savedHistoryBusy || (!scoreRedoRef.current.length && !savedRedoRef.current.length)} onPress={redoScoreEdit} />
      </View>
      {gradebookView === 'assessment' ? <SelectField
        label="Assessment"
        value={assessmentId}
        options={props.workspace.assessments.map((item) => ({
          label: assessmentOptionLabel(item, activeGradingSystem),
          value: item.id,
        }))}
        searchable
        onChange={(value) => {
          setAssessmentId(value);
          setValues({});
          setStudentQuery('');
          setStudentFilter('all');
        }}
      /> : null}
      <Card>
        {gradebookView === 'full' ? (
          <GradebookFullView
            assessments={props.workspace.assessments}
            classId={props.selectedClassId}
            students={pageStudents}
            allStudents={visibleStudents}
            workspace={props.workspace}
            gradingSystem={activeGradingSystem}
            values={fullValues}
            onChange={handleFullValueChange}
            onChangeMany={handleFullValuesChange}
            dirtyCount={fullDirtyEntries.length}
            invalidCount={fullInvalidEntries.length}
            saving={saving}
            onSave={() => void saveFullView()}
            autosaveEnabled={autosaveEnabled}
            studentQuery={studentQuery}
            onStudentQuery={setStudentQuery}
            studentFilter={studentFilter}
            onStudentFilter={(value) => setStudentFilter(value as typeof studentFilter)}
            studentSort={studentSort}
            onStudentSort={(value) => setStudentSort(value as typeof studentSort)}
            visibleCount={visibleStudents.length}
            page={page}
            pageCount={pageCount}
            paginationEnabled={paginationEnabled}
            onPageChange={setPage}
            onToast={(message) => props.toast.show(message)}
            onEditAssessment={openEditAssessment}
            onLoadScoreHistory={props.onLoadScoreHistory}
            onLoadGradebookHistory={props.onLoadGradebookHistory}
            onRestoreScoreVersion={handleRestoreScoreVersion}
            onRestoreGradebookVersion={handleRestoreGradebookVersion}
            onRestoreAssessmentVersion={async (versionId) => {
              await props.onRestoreAssessmentVersion(versionId);
              props.refresh();
            }}
            onNameGradebookVersion={props.onNameGradebookVersion}
            cellOverlays={props.cellOverlays}
            overlayControl={props.overlayControl}
            conditionalFormattingRules={props.conditionalFormattingRules}
            onConditionalFormattingRulesChange={props.onConditionalFormattingRulesChange}
          />
        ) : selected ? (
          <>
            <View style={styles.assessmentContext}>
              <View style={styles.flex}>
                <Text style={styles.assessmentTitle}>{selected.title}</Text>
                <Text style={styles.help}>{componentLabel(selected.component, selected.gradingTypeId, activeGradingSystem)} · {selected.gradingPeriod}{selected.moduleNumber == null ? '' : ` · Module ${selected.moduleNumber}`}</Text>
              </View>
              <Text style={styles.maxScore}>{selectedCategoryMapping ? `Max ${highestCategory(selectedCategoryMapping)}` : `Max ${selected.maximumScore}`}</Text>
            </View>
            <Text style={styles.help}>{selected.component === 'other' ? 'Scoring follows the rules configured for this assessment type.' : assessmentHelp(selected.component)} Blank scores are excluded from running calculations until recorded.</Text>
            <View style={styles.gradeToolbar}>
              <Field label="Find student" value={studentQuery} placeholder="Name or student ID" onChangeText={setStudentQuery} containerStyle={styles.studentSearch} />
              <SelectField
                label="Show"
                value={studentFilter}
                options={[
                  { label: 'All students', value: 'all' },
                  { label: 'Missing this score', value: 'missing' },
                  { label: 'At-risk students', value: 'at_risk' },
                  { label: 'Passing students', value: 'passing' },
                ]}
                onChange={(value) => setStudentFilter(value as typeof studentFilter)}
                containerStyle={styles.studentFilter}
              />
              <SelectField label="Sort" value={studentSort} options={[{ label: 'Class number (ascending)', value: 'class_number' }, { label: 'Name (A–Z)', value: 'name' }, { label: 'Highest risk first', value: 'risk' }, { label: 'Lowest standing first', value: 'standing' }]} onChange={(value) => setStudentSort(value as typeof studentSort)} containerStyle={styles.studentSort} />
              <Text style={styles.resultCount}>{paginationEnabled ? `${visibleStudents.length} students · Page ${page} of ${pageCount}` : `${visibleStudents.length} students · Showing all`}</Text>
            </View>
            <View style={styles.bulkBar}>
              <Button label={pageStudents.length && pageStudents.every((student) => selectedStudents.includes(student.enrollmentId)) ? 'Clear page' : 'Select page'} variant="secondary" onPress={pageStudents.length && pageStudents.every((student) => selectedStudents.includes(student.enrollmentId)) ? clearPageSelection : selectVisible} />
              {selectedCategoryMapping ? <SelectField label="Bulk score" value={bulkScore} error={bulkScore.trim() ? validateAssessmentValue(bulkScore, selected.maximumScore, selectedCategoryMapping) : undefined} options={[{ label: 'Choose a category', value: '' }, ...selectedCategoryMapping.map((item) => ({ label: `${item.value} · ${item.percentage}%`, value: item.value }))]} onChange={setBulkScore} containerStyle={styles.bulkScoreField} /> : <Field label="Bulk score" value={bulkScore} error={bulkScore.trim() ? validateScore(bulkScore, selected.maximumScore) : undefined} placeholder={`0–${selected.maximumScore}`} keyboardType="decimal-pad" onChangeText={setBulkScore} containerStyle={styles.bulkScoreField} />}
              <Button label={`Apply to ${selectedStudents.length || 'selected'}`} disabled={!selectedStudents.length || !bulkScore.trim() || !!validateAssessmentValue(bulkScore, selected.maximumScore, selectedCategoryMapping)} onPress={applyBulkScore} />
              <Button label="Paste scores" variant="secondary" onPress={() => void pasteScores()} />
              <Text style={styles.help}>Paste one score per line; values follow the visible student order.</Text>
            </View>
            <View style={styles.gradeHeader}>
              <Text style={[styles.gradeHeaderText, styles.gradeStudentColumn]}>STUDENT</Text>
              <Text style={[styles.gradeHeaderText, styles.gradeSummaryColumn]}>GRADE SUMMARY · {activeGradingSystem.name.toUpperCase()}</Text>
              <Text style={[styles.gradeHeaderText, styles.gradeScoreColumn]}>{selectedCategoryMapping ? 'CATEGORY' : `SCORE / ${selected.maximumScore}`}</Text>
            </View>
            <View style={styles.gradeRows}>
              {pageStudents.map((student) => {
                const summary = summarizeEnrollmentStanding(props.workspace, student.enrollmentId);
                const calculatedGrade = calculateEnrollmentGrade(props.workspace, student.enrollmentId);
                const standing = currentStanding(props.workspace, student.enrollmentId);
                const attendance = attendanceRate(props.workspace, student.enrollmentId);
                const risk = riskFor(props.workspace, student.enrollmentId);
                const remarksTone = summary.remarks === 'passing' ? 'success' : summary.remarks === 'incomplete' ? 'warning' : 'danger';
                const riskTone = risk === 'low' ? 'success' : risk === 'medium' ? 'warning' : 'danger';
                return (
                <View key={student.enrollmentId} style={styles.gradeRow}>
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedStudents.includes(student.enrollmentId) }} onPress={() => toggleStudent(student.enrollmentId)} style={[styles.studentCheck, selectedStudents.includes(student.enrollmentId) && styles.studentCheckSelected]}>
                    <Text style={styles.studentCheckText}>{selectedStudents.includes(student.enrollmentId) ? '✓' : ''}</Text>
                  </Pressable>
                  <View style={[styles.flex, styles.gradeStudentColumn]}>
                    <Text style={styles.rowTitle}>{student.name}</Text>
                    <Text style={styles.help}>{student.institutionalId}</Text>
                  </View>
                  <View style={[styles.summaryCell, styles.gradeSummaryColumn]}>
                    <View style={styles.badgeRow}>
                      <Badge tone={remarksTone}>{summary.remarks === 'passing' ? 'Passing' : summary.remarks === 'incomplete' ? 'Incomplete' : 'Below rule'}</Badge>
                      <Badge tone={riskTone} color={props.workspace.evaluationSystem?.levels.find((level) => level.severity === risk)?.color}>{risk === 'unavailable' ? 'Unavailable' : `${risk[0].toUpperCase()}${risk.slice(1)}`} risk</Badge>
                    </View>
                    <Text style={styles.help}>Final {calculatedGrade.finalGrade == null ? '—' : `${calculatedGrade.finalGrade.toFixed(1)}%`}{calculatedGrade.pointGrade == null ? '' : ` · Point ${calculatedGrade.pointGrade}`}{calculatedGrade.letterGrade == null ? '' : ` · Letter ${calculatedGrade.letterGrade}`} · Attendance {attendance == null ? '—' : `${attendance.toFixed(0)}%`} · Missing {missingAssessments(props.workspace, student.enrollmentId)}</Text>
                  </View>
                  {selectedCategoryMapping ? <SelectField label="Score" value={effectiveScore(student.enrollmentId)} error={scoreErrorFor(student.enrollmentId)} options={[{ label: 'Unscored', value: '' }, ...selectedCategoryMapping.map((item) => ({ label: `${item.value} · ${item.percentage}%`, value: item.value }))]} onChange={(value) => updatePendingScores('assessment', { [student.enrollmentId]: value })} containerStyle={styles.scoreField} /> : <Field label="Score" value={effectiveScore(student.enrollmentId)} error={scoreErrorFor(student.enrollmentId)} keyboardType="decimal-pad" onChangeText={(value) => updatePendingScores('assessment', { [student.enrollmentId]: value })} containerStyle={styles.scoreField} />}
                </View>
                );
              })}
              {!visibleStudents.length ? <PageState kind="empty" title="No matching students" message="Try a different search or filter." /> : null}
            </View>
            {paginationEnabled && visibleStudents.length > pageSize ? <View style={styles.pagination}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((current) => Math.max(1, current - 1))} /><Text style={styles.paginationText}>Page {page} of {pageCount} · {visibleStudents.length} students</Text><Button label="Next" variant="secondary" disabled={page >= pageCount} onPress={() => setPage((current) => Math.min(pageCount, current + 1))} /></View> : null}
            <View style={styles.saveBar}>
              <View style={styles.flex}>
                <Text style={styles.saveState}>{dirtyCount ? `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` : 'All scores saved'}</Text>
                <Text style={styles.help}>{invalidScoreCount ? `${invalidScoreCount} score${invalidScoreCount === 1 ? '' : 's'} need correction. ${selectedCategoryMapping ? 'Choose a configured category.' : `Enter numeric values from 0 to ${selected.maximumScore}.`}` : 'Scores remain provisional monitoring data until recorded in SWU SIS.'}</Text>
              </View>
              {invalidScoreCount ? <Button label={`Review ${invalidScoreCount} invalid score${invalidScoreCount === 1 ? '' : 's'}`} variant="danger" onPress={focusFirstInvalidScore} /> : null}
              {gradebookView === 'assessment' ? <Button label="Save all scores" loading={saving} disabled={!dirtyCount || hasInvalidScores} onPress={() => void save()} /> : null}
            </View>
          </>
        ) : (
          <PageState kind="empty" title="No assessment selected" message="Create an assessment before entering scores." />
        )}
      </Card>
      <AssessmentDialog
        visible={open}
        title="Create assessment"
        form={form}
        gradingSystem={activeGradingSystem}
        gradingTypes={activeGradingSystem.assessmentTypes ?? []}
        periods={activeGradingSystem.periods ?? []}
        groups={activeGradingSystem.groups ?? []}
        saving={saving}
        onChange={setForm}
        onClose={() => { setOpen(false); resetForm(); }}
        onSubmit={create}
        submitLabel="Create assessment"
      />
      <AssessmentDialog
        visible={editOpen}
        title="Edit assessment"
        form={form}
        gradingSystem={activeGradingSystem}
        gradingTypes={activeGradingSystem.assessmentTypes ?? []}
        periods={activeGradingSystem.periods ?? []}
        groups={activeGradingSystem.groups ?? []}
        saving={saving}
        onChange={setForm}
        onClose={() => { setEditOpen(false); resetForm(); }}
        onSubmit={saveEdit}
        submitLabel="Save assessment changes"
      />
    </>
  );
}

