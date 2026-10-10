import { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { DEFAULT_EVALUATION_SYSTEM, IT_GLOBAL_GRADING_SYSTEM, generatedDatasetToCsv, generateSyntheticGradebook, type DataGenerationPlan, type GeneratedDataset, type GradingDefinition } from '@apms/domain';
import { Button, Card, Field, SelectField } from '@/components/ui';
import { supabase } from '@/services/supabase';
import { colors } from '@/theme/tokens';

function today() { return new Date().toISOString().slice(0, 10); }
function plusDays(days: number) { const date = new Date(); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function percentageField(onChange: (value: string) => void) {
  return (next: string) => onChange(next.replace(/[^\d.]/g, '').slice(0, 6));
}
function gradeDistributionLabel(label: string, summary: NonNullable<GeneratedDataset['gradeDistribution']>['overall'], passingThreshold: number) {
  const score = (value: number | null) => value == null ? '—' : `${value.toFixed(1)}%`;
  return `${label} · ${summary.students} students · mean ${score(summary.mean)} · median ${score(summary.median)} · range ${score(summary.minimum)}–${score(summary.maximum)} · ≥70% ${summary.atOrAbove70} · ≥${passingThreshold}% ${summary.atOrAbovePassing}`;
}
function downloadFile(name: string, content: string, type: string) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') throw new Error('Downloads are available from the web development build.');
  const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

export function DataGeneratorDevScreen() {
  const [systemText, setSystemText] = useState(JSON.stringify(IT_GLOBAL_GRADING_SYSTEM, null, 2));
  const [evaluationText, setEvaluationText] = useState(JSON.stringify(DEFAULT_EVALUATION_SYSTEM, null, 2));
  const [students, setStudents] = useState('30'); const [seed, setSeed] = useState('demo-2026');
  const [startsOn, setStartsOn] = useState(today()); const [endsOn, setEndsOn] = useState(plusDays(120));
  const [asOf, setAsOf] = useState(today());
  const [countStrategy, setCountStrategy] = useState<DataGenerationPlan['countStrategy']>('minimum');
  const [explicitCounts, setExplicitCounts] = useState<Record<string, string>>({});
  const [distribution, setDistribution] = useState<'bell' | 'uniform' | 'triangular'>('bell');
  const [missingEnabled, setMissingEnabled] = useState(false); const [missingRate, setMissingRate] = useState('10');
  const [profileMode, setProfileMode] = useState<DataGenerationPlan['profileMode']>('consistent');
  const [mappedScorePolicy, setMappedScorePolicy] = useState<DataGenerationPlan['mappedScorePolicy']>('profile_target');
  const [lowProfileTarget, setLowProfileTarget] = useState('40'); const [mediumProfileTarget, setMediumProfileTarget] = useState('65'); const [highProfileTarget, setHighProfileTarget] = useState('85');
  const [lowProfileShare, setLowProfileShare] = useState('20'); const [mediumProfileShare, setMediumProfileShare] = useState('60'); const [highProfileShare, setHighProfileShare] = useState('20');
  const [mappingPolicy, setMappingPolicy] = useState<DataGenerationPlan['numericMappingPolicy']>('exact');
  const [naming, setNaming] = useState<DataGenerationPlan['naming']>('test_labels');
  const [assessmentNaming, setAssessmentNaming] = useState<DataGenerationPlan['assessmentNaming']>('description');
  const [advancedPlanText, setAdvancedPlanText] = useState('{\n  "completionRequirements": []\n}');
  const [result, setResult] = useState<GeneratedDataset | null>(null); const [message, setMessage] = useState('');
  const [classes, setClasses] = useState<Array<{ id: string; label: string; departmentId: string; isSyntheticTest: boolean }>>([]);
  const [faculty, setFaculty] = useState<Array<{ id: string; label: string; departmentId: string }>>([]);
  const [subjects, setSubjects] = useState<Array<{ id: string; departmentId: string; label: string }>>([]);
  const [terms, setTerms] = useState<Array<{ id: string; startsOn: string; endsOn: string; label: string }>>([]);
  const [subjectId, setSubjectId] = useState(''); const [termId, setTermId] = useState(''); const [testSection, setTestSection] = useState('');
  const [assignmentClassId, setAssignmentClassId] = useState(''); const [assignmentFacultyId, setAssignmentFacultyId] = useState('');
  const [allowedClassIds, setAllowedClassIds] = useState<string[]>([]); const [allowlistDraft, setAllowlistDraft] = useState<string[]>([]);
  const [classId, setClassId] = useState(''); const [classConfig, setClassConfig] = useState<any>(null);
  const [generationPlanSnapshot, setGenerationPlanSnapshot] = useState<DataGenerationPlan | null>(null);
  const [generationGradingDefinitionSnapshot, setGenerationGradingDefinitionSnapshot] = useState<GradingDefinition | null>(null);
  const [loadingClasses, setLoadingClasses] = useState(true); const [savingAllowlist, setSavingAllowlist] = useState(false); const [savingBatch, setSavingBatch] = useState(false); const [deletingTestClasses, setDeletingTestClasses] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!supabase) throw new Error('Connect Supabase before using the database generator.');
        const { data, error } = await supabase.functions.invoke('synthetic-data', { body: { action: 'list_classes' } });
        if (error) throw error;
        if (!active) return;
        const nextClasses = data?.classes ?? []; const nextAllowed = data?.allowedClassIds ?? [];
        setClasses(nextClasses); setAllowedClassIds(nextAllowed); setAllowlistDraft(nextAllowed);
        setClassId(nextAllowed[0] ?? '');
      } catch (cause) { if (active) setMessage(cause instanceof Error ? cause.message : 'Classes could not be loaded.'); }
      finally { if (active) setLoadingClasses(false); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!supabase) return;
    void supabase.functions.invoke('synthetic-data', { body: { action: 'list_faculty' } }).then(({ data, error }) => {
      if (!active) return;
      if (error) { setMessage(error.message); return; }
      setFaculty(data?.faculty ?? []);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!supabase) return;
    void supabase.functions.invoke('synthetic-data', { body: { action: 'create_class_options' } }).then(({ data, error }) => {
      if (!active) return;
      if (error) { setMessage(error.message); return; }
      const nextSubjects = data?.subjects ?? []; const nextTerms = data?.terms ?? [];
      setSubjects(nextSubjects); setTerms(nextTerms); setSubjectId(nextSubjects[0]?.id ?? ''); setTermId(nextTerms[0]?.id ?? '');
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!classId || !allowedClassIds.includes(classId) || !supabase) { setClassConfig(null); return; }
    void supabase.functions.invoke('synthetic-data', { body: { action: 'class_config', classId } }).then(({ data, error }) => {
      if (!active) return;
      if (error) { setClassConfig(null); setMessage(error.message); return; }
      setClassConfig(data); setSystemText(JSON.stringify(data.gradingDefinition, null, 2));
      setEvaluationText(data.evaluationDefinition ? JSON.stringify(data.evaluationDefinition, null, 2) : '');
      const countDefaults = Object.fromEntries((data.gradingDefinition.components ?? []).flatMap((component: any) => {
        const definition = component.assessmentDefinition;
        return definition ? [[definition.typeId, String(definition.count?.min ?? 1)]] : [];
      }));
      setExplicitCounts(countDefaults);
      if (data.class?.startsOn) setStartsOn(data.class.startsOn); if (data.class?.endsOn) setEndsOn(data.class.endsOn);
    });
    return () => { active = false; };
  }, [classId, allowedClassIds]);
  const plan = useMemo<DataGenerationPlan>(() => ({ seed, studentCount: Number(students), semester: { startsOn, endsOn }, asOf, countStrategy, ...(countStrategy === 'explicit' ? { countsByType: Object.fromEntries(Object.entries(explicitCounts).map(([typeId, count]) => [typeId, count.trim() ? Number(count) : Number.NaN])) } : {}), scoreDistribution: { kind: distribution }, missing: { enabled: missingEnabled, rate: Number(missingRate) / 100 }, profileMode, ...(profileMode === 'consistent' ? { profileTargets: { low: Number(lowProfileTarget), medium: Number(mediumProfileTarget), high: Number(highProfileTarget) }, profileTiers: { low: Number(lowProfileShare) / 100, medium: Number(mediumProfileShare) / 100, high: Number(highProfileShare) / 100 }, mappedScorePolicy } : { mappedScorePolicy: 'equal_probability' as const }), numericMappingPolicy: mappingPolicy, naming, assessmentNaming }), [seed, students, startsOn, endsOn, asOf, countStrategy, explicitCounts, distribution, missingEnabled, missingRate, profileMode, lowProfileTarget, mediumProfileTarget, highProfileTarget, lowProfileShare, mediumProfileShare, highProfileShare, mappedScorePolicy, mappingPolicy, naming, assessmentNaming]);
  useEffect(() => { setResult(null); setGenerationPlanSnapshot(null); setGenerationGradingDefinitionSnapshot(null); }, [plan, advancedPlanText, systemText, evaluationText, classId]);
  const generate = () => {
    try {
      if (!classId || !allowedClassIds.includes(classId) || !classConfig) throw new Error('Select an allowlisted class with an applied grading system first.');
      const system = JSON.parse(systemText) as GradingDefinition;
      const evaluation = evaluationText ? JSON.parse(evaluationText) as typeof DEFAULT_EVALUATION_SYSTEM : undefined;
      const advanced = JSON.parse(advancedPlanText) as Partial<DataGenerationPlan>;
      const generationPlan = { ...plan, ...advanced, targetNamespace: classId };
      const dataset = generateSyntheticGradebook(system, generationPlan, evaluation);
      setResult(dataset); setGenerationPlanSnapshot(generationPlan); setGenerationGradingDefinitionSnapshot(system); setMessage('Generated data passed grading-system and evaluation-criteria validation.');
    } catch (cause) { setResult(null); setMessage(cause instanceof Error ? cause.message : 'The generation plan could not be processed.'); }
  };
  const saveAllowlist = async () => {
    if (!supabase) return;
    setSavingAllowlist(true);
    try {
      const { data, error } = await supabase.functions.invoke('synthetic-data', { body: { action: 'set_allowlist', classIds: allowlistDraft } });
      if (error) throw error;
      const ids = data?.allowedClassIds ?? allowlistDraft; setAllowedClassIds(ids); setAllowlistDraft(ids);
      setClassId((current) => ids.includes(current) ? current : ids[0] ?? ''); setResult(null);
      setMessage(`Saved ${ids.length} allowlisted class${ids.length === 1 ? '' : 'es'}.`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Allowlist could not be saved.'); }
    finally { setSavingAllowlist(false); }
  };
  const createTestClass = async () => {
    if (!supabase || !subjectId || !termId || !testSection.trim()) return;
    setSavingAllowlist(true);
    try {
      const { data: created, error } = await supabase.functions.invoke('synthetic-data', { body: { action: 'create_test_class', subjectId, termId, section: testSection } });
      if (error) throw error;
      const { data: refreshed, error: refreshError } = await supabase.functions.invoke('synthetic-data', { body: { action: 'list_classes' } });
      if (refreshError) throw refreshError;
      setClasses(refreshed?.classes ?? []); setAllowedClassIds(refreshed?.allowedClassIds ?? created.allowedClassIds);
      setAllowlistDraft(refreshed?.allowedClassIds ?? created.allowedClassIds); setClassId(created.classId); setTestSection(''); setResult(null);
      setMessage('Created the TEST class and added it to the central allowlist.');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Test class could not be created.'); }
    finally { setSavingAllowlist(false); }
  };
  const assignTestClass = async () => {
    if (!supabase || !assignmentClassId || !assignmentFacultyId) return;
    setSavingAllowlist(true);
    try {
      const { error } = await supabase.functions.invoke('synthetic-data', { body: { action: 'assign_test_class', classId: assignmentClassId, facultyId: assignmentFacultyId } });
      if (error) throw error;
      const classLabel = classes.find((item) => item.id === assignmentClassId)?.label ?? 'the test class';
      const facultyLabel = faculty.find((item) => item.id === assignmentFacultyId)?.label ?? 'the selected Faculty account';
      setMessage(`Assigned ${classLabel} to ${facultyLabel}. Sign in as that Faculty user, then open My Classes and select its Gradebook.`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The test class could not be assigned.'); }
    finally { setSavingAllowlist(false); }
  };
  const deleteAllTestClasses = () => {
    const confirmDelete = () => {
      if (!supabase) return;
      setDeletingTestClasses(true);
      void supabase.functions.invoke('synthetic-data', { body: { action: 'delete_all_test_classes' } }).then(async ({ data, error }) => {
        if (error) throw error;
        const deleted = data?.deleted ?? {};
        const { data: refreshed, error: refreshError } = await supabase!.functions.invoke('synthetic-data', { body: { action: 'list_classes' } });
        if (refreshError) throw refreshError;
        const nextClasses = refreshed?.classes ?? []; const nextAllowed = refreshed?.allowedClassIds ?? [];
        setClasses(nextClasses); setAllowedClassIds(nextAllowed); setAllowlistDraft(nextAllowed);
        setClassId(nextAllowed[0] ?? ''); setAssignmentClassId(''); setAssignmentFacultyId(''); setClassConfig(null); setResult(null);
        setMessage(`Deleted ${deleted.classes ?? 0} test classes, ${deleted.students ?? 0} generated students, ${deleted.assessments ?? 0} assessments, and ${deleted.results ?? 0} results.`);
      }).catch((cause) => setMessage(cause instanceof Error ? cause.message : 'Test classes and their generated data could not be deleted.')).finally(() => setDeletingTestClasses(false));
    };
    const prompt = 'This permanently deletes every class marked as a synthetic test class, along with its class data and generated students. This cannot be undone.';
    if (Platform.OS === 'web' && typeof window !== 'undefined') { if (window.confirm(`Delete all test classes and associated data?\n\n${prompt}`)) confirmDelete(); }
    else Alert.alert('Delete all test classes?', prompt, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete all', style: 'destructive', onPress: confirmDelete }]);
  };
  const persistBatch = () => {
    if (!result || !generationPlanSnapshot || !generationGradingDefinitionSnapshot || !classConfig || !supabase || !classId) return;
    const client = supabase;
    const planForWrite = generationPlanSnapshot;
    const confirm = () => {
      setSavingBatch(true);
      void client.functions.invoke('synthetic-data', { body: { action: 'write_batch', classId, dataset: result, plan: planForWrite, gradingDefinition: generationGradingDefinitionSnapshot, evaluationDefinition: classConfig.evaluationDefinition } }).then(async ({ data, error }) => {
        if (error) {
          const context = (error as any).context;
          const response = context && typeof context.json === 'function' ? await context.json().catch(() => null) : null;
          throw new Error(typeof response?.error === 'string' ? response.error : error.message);
        }
        setMessage(`Saved ${data.counts.students} students, ${data.counts.assessments} assessments, and ${data.counts.results} results to ${classConfig.class.label}. This replaces the previous generated batch for the class.`);
      }).catch((cause) => setMessage(cause instanceof Error ? cause.message : 'Generated records could not be saved.')).finally(() => setSavingBatch(false));
    };
    const prompt = `This replaces the previous generated batch for ${classConfig.class.label}, including its generated students and assessment instances.`;
    if (Platform.OS === 'web' && typeof window !== 'undefined') { if (window.confirm(`Write synthetic data?\n\n${prompt}`)) confirm(); }
    else Alert.alert('Write synthetic data?', prompt, [{ text: 'Cancel', style: 'cancel' }, { text: 'Write batch', onPress: confirm }]);
  };
  const exportFile = (kind: 'json' | 'students' | 'assessments' | 'results' | 'summaries') => {
    if (!result) return;
    try {
      const name = `${result.batchId}-${kind}.${kind === 'json' ? 'json' : 'csv'}`;
      const content = kind === 'json' ? JSON.stringify(result, null, 2) : generatedDatasetToCsv(result, kind);
      downloadFile(name, content, kind === 'json' ? 'application/json' : 'text/csv');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The file could not be downloaded.'); }
  };
  return <ScrollView contentContainerStyle={styles.page}>
    <View><Text style={styles.title}>Synthetic gradebook generator</Text><Text style={styles.help}>Development-only tool. It uses each class’s applied grading system and evaluation criteria, generates a preview, and writes approved test data through a protected System Admin endpoint. It never calls AI.</Text></View>
    <Card style={styles.card}>
      <Text style={styles.heading}>Create a test class</Text><Text style={styles.help}>Choose a subject and term, then enter a section name. The class is created as active, tagged with “TEST -”, and added to the central allowlist. Use a dedicated test subject so generated records stay separate from real classes.</Text>
      <View style={styles.row}>
        <SelectField label="Subject" value={subjectId} options={subjects.map((item) => ({ label: item.label, value: item.id }))} onChange={setSubjectId} />
        <SelectField label="Academic term" value={termId} options={terms.map((item) => ({ label: item.label, value: item.id }))} onChange={setTermId} />
        <Field label="Test section name" value={testSection} onChangeText={setTestSection} placeholder="e.g. Generator Sandbox" containerStyle={styles.shortField} maxLength={60} />
        <Button label="Create test class" loading={savingAllowlist} disabled={!subjectId || !termId || !testSection.trim()} onPress={() => void createTestClass()} />
      </View>
    </Card>
    <Card style={styles.card}>
      <Text style={styles.heading}>Central test-class allowlist</Text><Text style={styles.help}>Only these active classes can receive synthetic records. Saving the allowlist requires an active System Admin account.</Text>
      {loadingClasses ? <Text style={styles.help}>Loading classes…</Text> : classes.length ? classes.map((item) => {
        const selected = allowlistDraft.includes(item.id);
        return <Pressable key={item.id} onPress={() => setAllowlistDraft((current) => selected ? current.filter((id) => id !== item.id) : [...current, item.id])} style={styles.allowlistRow}><View style={[styles.checkbox, selected && styles.checkboxSelected]}><Text style={styles.checkboxText}>{selected ? '✓' : ''}</Text></View><Text style={styles.allowlistLabel}>{item.label}</Text></Pressable>;
      }) : <Text style={styles.help}>No active classes are available.</Text>}
      <View style={styles.row}><Button label="Save class allowlist" loading={savingAllowlist} onPress={() => void saveAllowlist()} /><Text style={styles.help}>{allowedClassIds.length} classes currently allowed</Text></View>
    </Card>
    <Card style={styles.card}>
      <Text style={styles.heading}>Open a test class in the Faculty gradebook</Text>
      <Text style={styles.help}>Assign a test class to an active Faculty account in the same department. Then sign in as that Faculty user and open the class from My Classes.</Text>
      <View style={styles.row}>
        <SelectField label="Test class" value={assignmentClassId} options={classes.filter((item) => item.isSyntheticTest && allowedClassIds.includes(item.id)).map((item) => ({ label: item.label, value: item.id }))} onChange={(value) => { setAssignmentClassId(value); setAssignmentFacultyId(''); }} />
        <SelectField label="Faculty account" value={assignmentFacultyId} options={faculty.filter((item) => item.departmentId === classes.find((entry) => entry.id === assignmentClassId)?.departmentId).map((item) => ({ label: item.label, value: item.id }))} onChange={setAssignmentFacultyId} />
        <Button label="Assign to Faculty" loading={savingAllowlist} disabled={!assignmentClassId || !assignmentFacultyId} onPress={() => void assignTestClass()} />
      </View>
      {!loadingClasses && !classes.some((item) => item.isSyntheticTest && allowedClassIds.includes(item.id)) ? <Text style={styles.help}>No allowlisted test classes found. Classes created before test-class tracking was added should appear after the latest migration backfills their TEST - section marker.</Text> : null}
      {!faculty.length ? <Text style={styles.help}>No active Faculty accounts found. Check that Faculty profiles and their linked user profiles are both active.</Text> : null}
      <Button label="Delete all test classes and associated data" variant="secondary" loading={deletingTestClasses} disabled={deletingTestClasses} onPress={deleteAllTestClasses} />
    </Card>
    <Card style={styles.card}>
      <Text style={styles.heading}>Generation plan</Text>
      <SelectField label="Target class" value={classId} options={classes.filter((item) => allowedClassIds.includes(item.id)).map((item) => ({ label: item.label, value: item.id }))} onChange={(value) => { setClassId(value); setResult(null); }} />
      <Text style={styles.help}>{classConfig ? `Using applied grading system: ${classConfig.gradingDefinition.name}. ${classConfig.evaluationDefinition ? 'Applied evaluation criteria are also loaded.' : 'No evaluation criteria are applied to this class.'}` : 'Allowlist a class with an applied grading system to enable generation.'}</Text>
      <View style={styles.row}><Field label="Students" value={students} onChangeText={(value) => setStudents(value.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" containerStyle={styles.shortField} /><Field label="Seed" value={seed} onChangeText={setSeed} containerStyle={styles.shortField} /></View>
      <View style={styles.row}><Field label="Semester starts" value={startsOn} onChangeText={setStartsOn} placeholder="YYYY-MM-DD" containerStyle={styles.shortField} /><Field label="Semester ends" value={endsOn} onChangeText={setEndsOn} placeholder="YYYY-MM-DD" containerStyle={styles.shortField} /><Field label="Status date" value={asOf} onChangeText={setAsOf} placeholder="YYYY-MM-DD" containerStyle={styles.shortField} /></View>
      <View style={styles.row}>
        <SelectField label="Assessment count" value={countStrategy ?? 'minimum'} options={[{ label: 'Smallest valid set', value: 'minimum' }, { label: 'Seeded variation', value: 'varied' }, { label: 'Set counts by type', value: 'explicit' }]} onChange={(value) => setCountStrategy(value as DataGenerationPlan['countStrategy'])} />
        <SelectField label="Numeric score distribution" value={distribution} options={[{ label: 'Bell curve', value: 'bell' }, { label: 'Uniform', value: 'uniform' }, { label: 'Triangular', value: 'triangular' }]} onChange={(value) => setDistribution(value as typeof distribution)} />
        <SelectField label="Student profiles" value={profileMode ?? 'consistent'} options={[{ label: 'Consistent profiles', value: 'consistent' }, { label: 'Independent scores', value: 'independent' }]} onChange={(value) => setProfileMode(value as DataGenerationPlan['profileMode'])} />
        <SelectField label="Numeric mapping inputs" value={mappingPolicy ?? 'exact'} options={[{ label: 'Mapped values only', value: 'exact' }, { label: 'Normalize down to mapped value', value: 'threshold' }]} onChange={(value) => setMappingPolicy(value as DataGenerationPlan['numericMappingPolicy'])} />
        <SelectField label="Student names" value={naming ?? 'test_labels'} options={[{ label: 'Test labels', value: 'test_labels' }, { label: 'Fictional names', value: 'fictional_names' }]} onChange={(value) => setNaming(value as DataGenerationPlan['naming'])} />
        <SelectField label="Assessment names" value={assessmentNaming ?? 'description'} options={[{ label: 'Full description', value: 'description' }, { label: 'Short code + sequence', value: 'short_code_sequence' }]} onChange={(value) => setAssessmentNaming(value as DataGenerationPlan['assessmentNaming'])} />
      </View>
      {profileMode === 'consistent' ? <>
        <View style={styles.row}>
          <Field label="Low profile target (%)" value={lowProfileTarget} onChangeText={percentageField(setLowProfileTarget)} keyboardType="decimal-pad" containerStyle={styles.shortField} />
          <Field label="Medium profile target (%)" value={mediumProfileTarget} onChangeText={percentageField(setMediumProfileTarget)} keyboardType="decimal-pad" containerStyle={styles.shortField} />
          <Field label="High profile target (%)" value={highProfileTarget} onChangeText={percentageField(setHighProfileTarget)} keyboardType="decimal-pad" containerStyle={styles.shortField} />
          <SelectField label="Mapped score probabilities" value={mappedScorePolicy ?? 'profile_target'} options={[{ label: 'Match profile target', value: 'profile_target' }, { label: 'Equal chance per mapped value', value: 'equal_probability' }]} onChange={(value) => setMappedScorePolicy(value as DataGenerationPlan['mappedScorePolicy'])} />
        </View>
        <View style={styles.row}>
          <Field label="Low profile share (%)" value={lowProfileShare} onChangeText={percentageField(setLowProfileShare)} keyboardType="decimal-pad" containerStyle={styles.shortField} />
          <Field label="Medium profile share (%)" value={mediumProfileShare} onChangeText={percentageField(setMediumProfileShare)} keyboardType="decimal-pad" containerStyle={styles.shortField} />
          <Field label="High profile share (%)" value={highProfileShare} onChangeText={percentageField(setHighProfileShare)} keyboardType="decimal-pad" containerStyle={styles.shortField} />
        </View>
        <Text style={styles.help}>Profile shares must total 100%. Targets set each profile’s expected percentage across numeric and categorical assessments. Mapped results remain valid schema values. Equal chance preserves the same probability for each mapped value regardless of profile. The final-grade distribution preview shows the result after the grading system’s weights and rules are applied.</Text>
      </> : null}
      {countStrategy === 'explicit' && classConfig ? <View style={styles.row}>{classConfig.gradingDefinition.components.filter((component: any) => component.assessmentDefinition).map((component: any) => {
        const definition = component.assessmentDefinition;
        const type = classConfig.gradingDefinition.assessmentTypes?.find((item: any) => item.id === definition.typeId);
        return <Field key={definition.typeId} label={`${type?.name ?? definition.typeId} count (${definition.count?.min ?? 1}–${definition.count?.max ?? 'no schema maximum'})`} value={explicitCounts[definition.typeId] ?? ''} onChangeText={(value) => setExplicitCounts((current) => ({ ...current, [definition.typeId]: value.replace(/\D/g, '').slice(0, 3) }))} keyboardType="number-pad" containerStyle={styles.shortField} />;
      })}</View> : null}
      <View style={styles.row}><Button label={missingEnabled ? 'Disable missing results' : 'Allow missing results'} variant="secondary" onPress={() => setMissingEnabled((value) => !value)} />{missingEnabled ? <Field label="Missing rate (%)" value={missingRate} onChangeText={(value) => setMissingRate(value.replace(/[^\d.]/g, '').slice(0, 5))} keyboardType="decimal-pad" containerStyle={styles.shortField} /> : null}</View>
    </Card>
    <Card style={styles.card}><Text style={styles.heading}>Applied grading system representation</Text><TextInput multiline editable={false} value={systemText} autoCapitalize="none" autoCorrect={false} style={styles.json} /></Card>
    {evaluationText ? <Card style={styles.card}><Text style={styles.heading}>Applied evaluation criteria representation</Text><TextInput multiline editable={false} value={evaluationText} autoCapitalize="none" autoCorrect={false} style={styles.json} /></Card> : null}
    <Card style={styles.card}><Text style={styles.heading}>Advanced generation settings</Text><Text style={styles.help}>Optional JSON fields override the visible settings. Use this for per-type distributions, explicit assessment counts, period date ranges, student tier probabilities, and standalone completion requirements.</Text><TextInput multiline value={advancedPlanText} onChangeText={setAdvancedPlanText} autoCapitalize="none" autoCorrect={false} style={[styles.json, { minHeight: 180 }]} /></Card>
    <View style={styles.row}><Button label="Generate preview" onPress={generate} /><Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text></View>
    {result ? <Card style={styles.card}>
      <Text style={styles.heading}>Preview · batch {result.batchId}</Text>
      <View style={styles.metrics}>{Object.entries(result.counts).map(([key, value]) => <View key={key} style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.help}>{key}</Text></View>)}</View>
      <Text style={styles.heading}>Final percentage grade distribution</Text>
      <View style={styles.gradeDistribution}>
        <Text style={styles.gradeDistributionLine}>{gradeDistributionLabel('Overall', result.gradeDistribution.overall, result.gradeDistribution.passingThreshold)}</Text>
        {Object.entries(result.gradeDistribution.byProfile).map(([profile, summary]) => summary ? <Text key={profile} style={styles.gradeDistributionLine}>{gradeDistributionLabel(`${profile[0].toUpperCase()}${profile.slice(1)} profile`, summary, result.gradeDistribution.passingThreshold)}</Text> : null)}
      </View>
      <Text style={styles.help}>Risk preview uses only factors derivable from generated records. AI-only factors remain unavailable. Missing required results stay incomplete unless the best possible completion cannot reach the passing threshold.</Text>
      <View style={styles.row}><Button label="Write batch to class" loading={savingBatch} disabled={!classConfig} onPress={persistBatch} />{(['json','students','assessments','results','summaries'] as const).map((kind) => <Button key={kind} label={`Download ${kind}`} variant="secondary" onPress={() => exportFile(kind)} />)}</View>
    </Card> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({ page: { gap: 14, paddingBottom: 24 }, card: { gap: 12 }, title: { color: colors.text, fontSize: 22, fontWeight: '700' }, heading: { color: colors.text, fontSize: 15, fontWeight: '700' }, help: { color: colors.textMuted, fontSize: 12, lineHeight: 18 }, row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }, allowlistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderColor: colors.border }, allowlistLabel: { color: colors.text, fontSize: 13, flex: 1 }, checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }, checkboxSelected: { backgroundColor: colors.brand, borderColor: colors.brand }, checkboxText: { color: '#FFF', fontSize: 13, fontWeight: '700' }, shortField: { width: 220 }, json: { minHeight: 300, maxHeight: 520, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, fontSize: 12, color: colors.text, textAlignVertical: 'top' }, message: { flex: 1, color: colors.textMuted, fontSize: 12, lineHeight: 18 }, metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { minWidth: 110, padding: 12, borderRadius: 9, backgroundColor: colors.canvas }, gradeDistribution: { gap: 6, padding: 10, borderRadius: 8, backgroundColor: colors.canvas }, gradeDistributionLine: { color: colors.text, fontSize: 12, lineHeight: 18 }, metricValue: { color: colors.brand, fontSize: 19, fontWeight: '700' } });
