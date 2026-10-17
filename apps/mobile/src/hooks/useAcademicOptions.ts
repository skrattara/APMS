import { useEffect, useState } from 'react';

import { loadYearLevels, type YearLevelRecord } from '@/services/admin';
import { supabase } from '@/services/supabase';

const defaultYearLevels = Array.from({ length: 4 }, (_, index) => ({ level: index + 1, label: `Year ${index + 1}`, sortOrder: index + 1 }));

export function useYearLevels(programId?: string) {
  const [yearLevels, setYearLevels] = useState<YearLevelRecord[]>(defaultYearLevels);
  useEffect(() => {
    let active = true;
    if (!programId) { setYearLevels(defaultYearLevels); return; }
    void loadYearLevels(programId).then((rows) => { if (active) setYearLevels(rows); }).catch(() => undefined);
    return () => { active = false; };
  }, [programId]);
  return yearLevels;
}

export function useStudentIdValidation() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    if (!supabase) return;
    void supabase.from('system_settings').select('value').eq('key', 'student_id.validation_enabled').maybeSingle()
      .then(({ data }) => { if (active) setEnabled(data?.value === true); }, () => undefined);
    return () => { active = false; };
  }, []);
  return enabled;
}
