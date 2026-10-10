import type { AssessmentInput, ClassWorkspace, FacultyClass, GradebookHistoryCursor, GradebookHistoryPage } from '@/services/faculty';

/** Read-only decorations supplied by a gradebook host (for example predicted scores or history previews). */
export type GradebookCellOverlay = {
  enrollmentId: string;
  columnId: string;
  mode: 'value' | 'highlight' | 'value-highlight';
  value?: string;
  label?: string;
  color?: string;
};

export type GradebookOverlayControl = { label: string; active: boolean; onToggle: () => void };

export type GradebookConditionalFormattingOperator =
  | 'equals' | 'is_exactly' | 'not_equals' | 'is_one_of' | 'is_not_one_of'
  | 'contains' | 'not_contains' | 'contains_one_of' | 'contains_none_of'
  | 'begins_with' | 'not_begins_with' | 'begins_with_one_of' | 'begins_with_none_of'
  | 'ends_with' | 'not_ends_with' | 'ends_with_one_of' | 'ends_with_none_of'
  | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal'
  | 'between' | 'between_exclusive' | 'not_between'
  | 'date_is' | 'date_on_or_before' | 'date_on_or_after' | 'date_between' | 'date_between_exclusive'
  | 'is_blank' | 'is_not_blank' | 'is_empty' | 'is_not_empty'
  | 'is_duplicate' | 'is_not_duplicate' | 'top_n' | 'top_percent'
  | 'above_average' | 'above_or_equal_average' | 'below_average' | 'below_or_equal_average'
  | 'std_deviations_above_average' | 'std_deviations_above_or_equal_average'
  | 'std_deviations_below_average' | 'std_deviations_below_or_equal_average';

export type GradebookConditionalFormattingRule = {
  /** Stable identifier used by the rule editor for editing and reordering. */
  id?: string;
  /** Applies the matched format to the matching cell or every cell in its row. */
  applyTo?: 'cell' | 'row';
  /** When omitted, the rule applies to every matching cell. */
  columnIds?: string[];
  columnKinds?: ('assessment' | 'component' | 'group' | 'period' | 'non_period' | 'final' | 'final_equivalent' | 'final_status')[];
  operator?: GradebookConditionalFormattingOperator;
  value?: string | number;
  valueTo?: string | number;
  values?: (string | number)[];
  style?: {
    backgroundColor?: string;
    textColor?: string;
    borderColor?: string;
    fontWeight?: 'normal' | 'bold';
  };
  colorScale?: {
    mode: 'discrete' | 'continuous';
    /** Stops use normalized positions from 0 (minimum) to 1 (maximum). */
    stops: { position: number; color: string }[];
  };
  badge?: {
    label: string;
    backgroundColor?: string;
    textColor?: string;
  };
};

/**
 * Data and persistence contract for embedding the gradebook in an app screen.
 * Hosts supply the workspace and keep authorization/data access in their own
 * callbacks; the gradebook handles the editing and validation workflow.
 */
export type GradebookProps = {
  workspace: ClassWorkspace;
  classes: FacultyClass[];
  selectedClassId: string;
  setSelectedClassId: (classId: string | ((current: string) => string)) => void;
  refresh: () => void;
  toast: { show: (message: string) => void };
  onCreateAssessment: (classId: string, input: AssessmentInput) => Promise<void>;
  onUpdateAssessment: (assessmentId: string, input: AssessmentInput) => Promise<void>;
  onSaveScores: (assessmentId: string, rows: { enrollmentId: string; score?: number; categoricalValue?: string }[]) => Promise<void>;
  onSaveScoreBatch: (rows: { assessmentId: string; enrollmentId: string; score?: number; categoricalValue?: string }[]) => Promise<void>;
  onLoadScoreHistory: (assessmentId: string, enrollmentId: string) => Promise<{ id: string; actorId: string | null; actorName: string | null; action: string; createdAt: string; before: any; after: any; restoredFromVersionId: string | null; batchId: string | null }[]>;
  onLoadGradebookHistory: (classId: string, cursor?: GradebookHistoryCursor | null) => Promise<GradebookHistoryPage>;
  onRestoreScoreVersion: (versionId: string, restoreBefore?: boolean, restoreBatch?: boolean) => Promise<void>;
  onRestoreGradebookVersion: (versionId: string) => Promise<number>;
  onRestoreAssessmentVersion: (versionId: string) => Promise<void>;
  onNameGradebookVersion: (versionId: string, name: string) => Promise<void>;
  /** Read-only cell data to display over the saved gradebook values. Keys use student enrollment and gradebook column IDs. */
  cellOverlays?: GradebookCellOverlay[];
  /** Optional host-owned control for showing/hiding supplied overlays, such as AI predicted scores. */
  overlayControl?: GradebookOverlayControl;
  /**
   * Rules are evaluated in order; the first match wins. Numeric assessments use
   * raw points, categorical assessments use their mapped percentage, and
   * calculated grades use percentage points (0–100). Rules can combine
   * conditions with text badges or discrete/continuous numeric color scales.
   */
  conditionalFormattingRules?: GradebookConditionalFormattingRule[];
  /** Receives conditional-formatting edits made through the cell context menu. */
  onConditionalFormattingRulesChange?: (rules: GradebookConditionalFormattingRule[]) => void;
};
