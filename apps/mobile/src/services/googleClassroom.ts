import { supabase } from './supabase';
import { getErrorMessage } from './errors';

export type GoogleClassroomCourse = { id: string; name: string; section?: string | null };
export type GoogleClassroomCoursework = { id: string; title: string; maxPoints: number; state: string };
export type GoogleClassroomAssessmentLink = {
  id: string;
  assessment_id: string;
  google_coursework_id: string;
  google_coursework_title: string;
  source_max_score: number;
  source_min_score: number;
  target_min_score: number;
  target_max_score: number;
  enabled: boolean;
  last_synced_at: string | null;
  last_error: string | null;
};
export type GoogleClassroomStatus = {
  connected: boolean;
  email: string | null;
  link: null | {
    class_record_id: string;
    google_course_id: string;
    google_course_name: string;
    google_account_email: string;
    status: string;
    last_synced_at: string | null;
    last_error: string | null;
    linked_by: string | null;
  };
  assessments: GoogleClassroomAssessmentLink[];
};

async function invoke<T>(payload: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('APMS is not connected to Supabase.');
  const { data, error } = await supabase.functions.invoke('google-classroom', { body: payload });
  if (data?.error) throw new Error(String(data.error));
  if (error) {
    const response = (error as { context?: Response }).context;
    if (response && typeof response.clone === 'function') {
      let body: { error?: unknown } | null = null;
      try { body = await response.clone().json(); } catch { /* Use the SDK's fallback message for non-JSON errors. */ }
      if (typeof body?.error === 'string') throw new Error(body.error);
    }
    throw new Error(getErrorMessage(error, 'Google Classroom could not be reached. Try again.'));
  }
  return data as T;
}

export const getGoogleClassroomStatus = (classId: string) => invoke<GoogleClassroomStatus>({ action: 'status', classId });
export const getGoogleClassroomCourses = () => invoke<{ connected: boolean; email?: string; courses: GoogleClassroomCourse[] }>({ action: 'courses' });
export const getGoogleClassroomCoursework = (classId: string) => invoke<{ coursework: GoogleClassroomCoursework[] }>({ action: 'coursework', classId });
export const linkGoogleClassroomCourse = (classId: string, courseId: string) => invoke<{ link: GoogleClassroomStatus['link']; push: { ok: boolean; message?: string } }>({ action: 'link-class', classId, courseId });
export const linkGoogleClassroomAssessment = (input: { classId: string; assessmentId: string; courseworkId: string; sourceMin: number; sourceMax: number; targetMin: number; targetMax: number }) => invoke<{ linked: boolean; initialSync?: { error?: string; deferred?: boolean; synced?: number; failed?: number; unmatched?: number } }>({ action: 'link-assessment', ...input });
export const syncGoogleClassroomGrades = (classId: string) => invoke<{ synced: number; failed: number; unmatched: number; removed: number; deferred: boolean; apiCalls: number }>({ action: 'sync', classId });
export const unlinkGoogleClassroomCourse = (classId: string) => invoke<{ unlinked: boolean }>({ action: 'unlink-class', classId });
export const startGoogleClassroomAuthorization = () => invoke<{ authorizationUrl: string }>({ action: 'oauth-start' });
