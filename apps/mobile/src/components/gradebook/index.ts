/**
 * Stable entry point for embedding the gradebook outside the Faculty portal.
 * Keep consumers on this path so implementation can be split into smaller
 * gradebook components without changing their imports.
 */
export { Gradebook } from './Gradebook';
export type { GradebookProps } from './types';
export { FullAssessmentView as GradebookFullView } from './FullAssessmentView';
export type { FullAssessmentViewProps } from './FullAssessmentView';
export type { GradebookCellOverlay, GradebookOverlayControl, GradebookConditionalFormattingRule } from './types';
