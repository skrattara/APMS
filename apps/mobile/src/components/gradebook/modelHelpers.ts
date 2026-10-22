import type { ClassWorkspace } from '@/services/faculty';

export function valueMappingForType(system: any, typeId: string) {
  for (const component of system.components ?? []) {
    const definition = component.assessmentDefinition;
    if (definition?.typeId === typeId && definition.scoring?.mode === 'value_mapping') return definition.scoring.mapping as { value: string; percentage: number }[];
  }
  return undefined;
}

export function storedAssessmentValue(workspace: ClassWorkspace, enrollmentId: string, assessmentId: string) {
  const key = `${enrollmentId}:${assessmentId}`;
  return workspace.categoricalScores[key] ?? workspace.scores[key] ?? null;
}
