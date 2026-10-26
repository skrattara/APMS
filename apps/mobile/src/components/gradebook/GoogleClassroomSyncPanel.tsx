import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, SelectField } from '@/components/ui';
import type { FacultyAssessment } from '@/services/faculty';
import {
  getGoogleClassroomCourses,
  getGoogleClassroomCoursework,
  getGoogleClassroomStatus,
  linkGoogleClassroomAssessment,
  linkGoogleClassroomCourse,
  startGoogleClassroomAuthorization,
  syncGoogleClassroomGrades,
  unlinkGoogleClassroomCourse,
  type GoogleClassroomCourse,
  type GoogleClassroomCoursework,
  type GoogleClassroomStatus,
} from '@/services/googleClassroom';

type Props = { classId: string; classLabel: string; assessments: FacultyAssessment[]; onToast: (message: string) => void; onRefresh: () => void };
const styles = StyleSheet.create({
  dialog: { width: 'min(820px, calc(100vw - 32px))', maxHeight: '90vh', backgroundColor: '#FFFFFF', borderRadius: 12, padding: 22, gap: 14, overflow: 'hidden' } as any,
  backdrop: { flex: 1, backgroundColor: 'rgba(18, 22, 30, 0.48)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { color: '#172033', fontSize: 20, fontWeight: '700' },
  subtitle: { color: '#667085', fontSize: 13, lineHeight: 19 },
  section: { borderTopWidth: 1, borderTopColor: '#E4E7EC', paddingTop: 14, gap: 10 },
  sectionTitle: { color: '#172033', fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 120, gap: 5 },
  label: { color: '#344054', fontSize: 12, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#D0D5DD', borderRadius: 7, color: '#172033', paddingHorizontal: 10, paddingVertical: 8, minHeight: 38, fontSize: 13, outlineStyle: 'none' } as any,
  status: { backgroundColor: '#F5F6F8', borderRadius: 8, padding: 12, gap: 4 },
  strong: { color: '#172033', fontSize: 13, fontWeight: '600' },
  muted: { color: '#667085', fontSize: 12, lineHeight: 17 },
  linkRow: { borderWidth: 1, borderColor: '#E4E7EC', borderRadius: 8, padding: 11, gap: 4 },
  inline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  error: { color: '#B42318', fontSize: 12 },
  close: { padding: 6 },
  closeText: { color: '#667085', fontSize: 22, lineHeight: 24 },
});

function numeric(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function GoogleClassroomSyncPanel({ classId, classLabel, assessments, onToast, onRefresh }: Props) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<GoogleClassroomStatus | null>(null);
  const [courses, setCourses] = useState<GoogleClassroomCourse[]>([]);
  const [coursework, setCoursework] = useState<GoogleClassroomCoursework[]>([]);
  const [courseId, setCourseId] = useState('');
  const [assessmentId, setAssessmentId] = useState(assessments[0]?.id ?? '');
  const [courseworkId, setCourseworkId] = useState('');
  const [sourceMin, setSourceMin] = useState('0');
  const [sourceMax, setSourceMax] = useState('');
  const [targetMin, setTargetMin] = useState('0');
  const [targetMax, setTargetMax] = useState('');
  const selectedAssessment = assessments.find((item) => item.id === assessmentId);
  const selectedCoursework = coursework.find((item) => item.id === courseworkId);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const current = await getGoogleClassroomStatus(classId);
      setStatus(current);
      if (current.connected) {
        const available = await getGoogleClassroomCourses();
        setCourses(available.courses ?? []);
        if (current.link) {
          const items = await getGoogleClassroomCoursework(classId);
          setCoursework(items.coursework ?? []);
          setCourseId(current.link.google_course_id);
        }
      } else {
        setCourses([]); setCoursework([]);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Google Classroom settings could not be loaded.';
      setError(message);
    } finally { setLoading(false); }
  }, [classId]);

  useEffect(() => { if (visible) void load(); }, [visible, load]);
  useEffect(() => {
    if (selectedAssessment) setTargetMax(String(selectedAssessment.maximumScore));
  }, [assessmentId, selectedAssessment?.maximumScore]);
  useEffect(() => {
    if (selectedCoursework) setSourceMax(String(selectedCoursework.maxPoints));
  }, [courseworkId, selectedCoursework?.maxPoints]);

  const open = () => { setVisible(true); setError(''); };
  const connect = async () => {
    let popup: Window | null = null;
    if (Platform.OS === 'web' && typeof window !== 'undefined') popup = window.open('about:blank', '_blank', 'popup,width=540,height=760');
    setWorking(true); setError('');
    try {
      const { authorizationUrl } = await startGoogleClassroomAuthorization();
      if (Platform.OS === 'web' && popup) popup.location.href = authorizationUrl;
      else await Linking.openURL(authorizationUrl);
      onToast('Complete Google authorization, then return to this class.');
      if (popup) {
        const timer = setInterval(() => {
          if (!popup || popup.closed) { clearInterval(timer); void load(); }
        }, 1000);
        setTimeout(() => clearInterval(timer), 5 * 60_000);
      }
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : 'Google authorization could not be started.');
    } finally { setWorking(false); }
  };
  const refreshCoursework = async () => {
    setWorking(true); setError('');
    try { const items = await getGoogleClassroomCoursework(classId); setCoursework(items.coursework ?? []); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google coursework could not be loaded.'); }
    finally { setWorking(false); }
  };
  const saveCourse = async () => {
    if (!courseId) return setError('Choose a Google Classroom course.');
    setWorking(true); setError('');
    try {
      const result = await linkGoogleClassroomCourse(classId, courseId);
      await load();
      onToast(result.push?.ok ? 'Class linked. Google Classroom grade updates will sync automatically.' : `Class linked. ${result.push?.message ?? 'Grades will sync on the scheduled check.'}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The Google Classroom course could not be linked.'); }
    finally { setWorking(false); }
  };
  const saveAssessment = async () => {
    if (!assessmentId || !courseworkId || !selectedAssessment || !selectedCoursework) return setError('Choose both an APMS assessment and Google Classroom coursework.');
    const bounds = [numeric(sourceMin, NaN), numeric(sourceMax, NaN), numeric(targetMin, NaN), numeric(targetMax, NaN)];
    if (bounds.some((value) => !Number.isFinite(value))) return setError('Enter numeric score limits for both assessments.');
    setWorking(true); setError('');
    try {
      const result = await linkGoogleClassroomAssessment({ classId, assessmentId, courseworkId, sourceMin: bounds[0], sourceMax: bounds[1], targetMin: bounds[2], targetMax: bounds[3] });
      await load();
      onRefresh();
      onToast(result.initialSync?.error
        ? `Assessment linked. The first sync will retry: ${result.initialSync.error}`
        : `Assessment linked. ${result.initialSync?.synced ?? 0} grade${result.initialSync?.synced === 1 ? '' : 's'} synced using the linear mapping.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The assessment link could not be saved.'); }
    finally { setWorking(false); }
  };
  const syncNow = async () => {
    setWorking(true); setError('');
    try {
      const result = await syncGoogleClassroomGrades(classId);
      const note = result.failed ? ` ${result.failed} grade updates were blocked or failed.` : '';
      const unmatchedNote = result.unmatched ? ` ${result.unmatched} submissions did not match an APMS student email.` : '';
      const deferredNote = result.deferred ? ' Remaining records will continue in the next scheduled sync.' : '';
      onToast(`Synced ${result.synced} grade${result.synced === 1 ? '' : 's'}.${note}${unmatchedNote}${deferredNote}`);
      await load(); onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Google Classroom sync failed.'); }
    finally { setWorking(false); }
  };
  const unlink = async () => {
    setWorking(true); setError('');
    try { await unlinkGoogleClassroomCourse(classId); setStatus((current) => current ? { ...current, link: null, assessments: [] } : current); setCoursework([]); onToast('The Google Classroom course was unlinked. Previously synced scores remain in APMS.'); onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The class link could not be removed.'); }
    finally { setWorking(false); }
  };

  const assessmentOptions = useMemo(() => assessments.map((item) => ({ label: `${item.title} · ${item.maximumScore} points`, value: item.id })), [assessments]);
  return <>
    <Button label="Google Classroom" variant="secondary" onPress={open} />
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <View style={styles.header}>
            <View style={{ flex: 1, gap: 4 }}><Text style={styles.title}>Google Classroom</Text><Text style={styles.subtitle}>{classLabel} · one-way grade sync into APMS</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setVisible(false)} style={styles.close}><Text style={styles.closeText}>×</Text></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 14, paddingBottom: 6 }}>
            {loading ? <View style={{ padding: 28, alignItems: 'center' }}><ActivityIndicator /><Text style={styles.muted}>Loading Classroom connection…</Text></View> : null}
            {!loading && !status?.connected ? <View style={styles.section}>
              <Text style={styles.sectionTitle}>Connect your Google account</Text>
              <Text style={styles.subtitle}>APMS reads course rosters, coursework and assigned grades. It never changes grades or coursework in Google Classroom.</Text>
              <View style={{ alignSelf: 'flex-start' }}><Button label="Connect Google Classroom" loading={working} disabled={working} onPress={() => void connect()} /></View>
            </View> : null}
            {!loading && status?.connected ? <>
              <View style={styles.status}>
                <Text style={styles.strong}>Connected as {status.email}</Text>
                <Text style={styles.muted}>Read-only Classroom access. APMS scores only change when the assigned Google grade is returned.</Text>
              </View>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Class link</Text>
                {status.link ? <View style={styles.status}>
                  <Text style={styles.strong}>{status.link.google_course_name}</Text>
                  <Text style={styles.muted}>Google account: {status.link.google_account_email}{status.link.last_synced_at ? ` · Last sync ${new Date(status.link.last_synced_at).toLocaleString()}` : ' · Not synced yet'}</Text>
                  {status.link.last_error ? <Text style={styles.error}>{status.link.last_error}</Text> : null}
                </View> : <>
                  <SelectField label="Google Classroom course" value={courseId} options={courses.map((course) => ({ label: `${course.name}${course.section ? ` · ${course.section}` : ''}`, value: course.id }))} onChange={setCourseId} searchable />
                  <View style={{ alignSelf: 'flex-start' }}><Button label="Link course" loading={working} disabled={working || !courseId} onPress={() => void saveCourse()} /></View>
                </>}
              </View>
              {status.link ? <>
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Assessment links</Text>
                  <Text style={styles.subtitle}>Choose an APMS assessment instance and a published Google coursework. Student scores are matched by email address.</Text>
                  <SelectField label="APMS assessment" value={assessmentId} options={assessmentOptions} onChange={setAssessmentId} searchable />
                  <SelectField label="Google Classroom coursework" value={courseworkId} options={coursework.map((item) => ({ label: `${item.title} · ${item.maxPoints} points`, value: item.id }))} onChange={setCourseworkId} searchable />
                  <View style={styles.row}>
                    <View style={styles.field}><Text style={styles.label}>Google source minimum</Text><TextInput keyboardType="decimal-pad" value={sourceMin} onChangeText={setSourceMin} style={styles.input} /></View>
                    <View style={styles.field}><Text style={styles.label}>Google source maximum</Text><TextInput keyboardType="decimal-pad" value={sourceMax} onChangeText={setSourceMax} style={styles.input} /></View>
                    <View style={styles.field}><Text style={styles.label}>APMS target minimum</Text><TextInput keyboardType="decimal-pad" value={targetMin} onChangeText={setTargetMin} style={styles.input} /></View>
                    <View style={styles.field}><Text style={styles.label}>APMS target maximum</Text><TextInput keyboardType="decimal-pad" value={targetMax} onChangeText={setTargetMax} style={styles.input} /></View>
                  </View>
                  <Text style={styles.muted}>Linear mapping: Google source range → APMS target range. Scores outside the source range are capped at the nearest target limit. Defaults map both assessments’ full score ranges.</Text>
                  <View style={styles.row}>
                    <Button label="Link assessment" loading={working} disabled={working || !courseworkId || !assessmentId} onPress={() => void saveAssessment()} />
                    <Button label="Refresh coursework" variant="secondary" loading={working} disabled={working} onPress={() => void refreshCoursework()} />
                  </View>
                  {status.assessments.map((item) => <View key={item.id} style={styles.linkRow}>
                    <Text style={styles.strong}>{assessments.find((assessment) => assessment.id === item.assessment_id)?.title ?? 'APMS assessment'} ↔ {item.google_coursework_title}</Text>
                    <Text style={styles.muted}>Google {item.source_min_score}–{item.source_max_score} → APMS {item.target_min_score}–{item.target_max_score}{item.last_synced_at ? ` · Synced ${new Date(item.last_synced_at).toLocaleString()}` : ''}</Text>
                    {item.last_error ? <Text style={styles.error}>{item.last_error}</Text> : null}
                  </View>)}
                </View>
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Sync</Text>
                  <Text style={styles.subtitle}>Classroom change notifications usually arrive within minutes. APMS also checks periodically for missed notifications. APMS deadline rules still apply to incoming grades.</Text>
                  <View style={styles.row}>
                    <Button label="Sync now" loading={working} disabled={working || status.assessments.length === 0} onPress={() => void syncNow()} />
                    <Button label="Unlink course" variant="secondary" disabled={working} onPress={() => void unlink()} />
                  </View>
                </View>
              </> : null}
            </> : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
