// Portable mirror of services/ai/src/apms_ai/assessment_context.py.
// Opaque refs are used only for local joins and never become model features.
export const ASSESSMENT_CONTEXT_FEATURE_NAMES = Object.freeze([
  'assessment_query', 'assessment_type_index', 'component_index', 'scoring_linear',
  'scoring_numeric_mapping', 'scoring_value_mapping', 'maximum_score_log',
  'sequence_position', 'period_present', 'period_sequence', 'group_present',
  'group_type_index', 'group_position_within_type', 'group_depth', 'scope_overall',
  'scope_per_period', 'scope_per_group', 'same_type_scope_position',
  'prior_same_type_scope_count', 'prior_latest_present', 'prior_latest_percent',
  'prior_mean_percent', 'prior_std_percent', 'prior_change_percent', 'prior_age_steps',
  'relative_day_present', 'relative_day_scaled', 'due_in_days_present', 'due_in_days_scaled',
  'prior_same_type_count', 'prior_same_type_latest_present', 'prior_same_type_latest_percent',
  'prior_same_type_mean_percent', 'prior_same_type_std_percent',
]);

export const ASSESSMENT_CONTEXT_NORMALIZATION_VERSION =
  'assessment_context_v1_fixed_caps_512_signed_log_days36500_score100';
export const ASSESSMENT_RESULT_CUTOFF = 'strictly_prior_sequence_and_observed_day_le_0';

const MAX_SEQUENCE = 1_000_000_000;
const MAX_SCORE = 100_000;
const DAY_CAP = 36_500;
const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
};
const ordinal = (value, cap = 512) => Math.min(Math.max(Number(value), 0), cap) / cap;
const mean = values => values.length ? [...values].sort((a, b) => a - b).reduce((sum, value) => sum + value, 0) / values.length : 0;
const std = values => {
  if (!values.length) return 0;
  const center = mean(values);
  return Math.sqrt(mean(values.map(value => (value - center) ** 2)));
};
const ranks = values => new Map([...new Set(values)].sort((a, b) => a - b).map((value, index) => [value, index]));
const sameScalar = (a, b) => typeof a === 'number' && typeof b === 'number'
  ? Number.isFinite(a) && Number.isFinite(b) && a === b
  : typeof a === typeof b && a === b;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function validateAssessmentContextMetadata(metadata) {
  const configVersion = metadata?.model_config?.assessment_context_version ?? 0;
  const artifactVersion = metadata?.assessment_context_version ?? configVersion;
  for (const version of [configVersion, artifactVersion]) {
    if (!Number.isInteger(version) || version < 0 || version > 1) throw new TypeError('Artifact assessment context version must be 0 or 1');
  }
  if (configVersion !== artifactVersion) throw new TypeError('Artifact assessment context version fields disagree');
  if (configVersion === 1) {
    if (!Array.isArray(metadata.assessment_context_feature_names)
      || metadata.assessment_context_feature_names.length !== ASSESSMENT_CONTEXT_FEATURE_NAMES.length
      || metadata.assessment_context_feature_names.some((name, index) => name !== ASSESSMENT_CONTEXT_FEATURE_NAMES[index])) {
      throw new TypeError('Artifact assessment context feature names do not match v1');
    }
    if (metadata.assessment_context_normalization_version !== ASSESSMENT_CONTEXT_NORMALIZATION_VERSION) {
      throw new TypeError('Artifact assessment context normalization version is unsupported');
    }
    if (metadata.assessment_result_cutoff !== ASSESSMENT_RESULT_CUTOFF) {
      throw new TypeError('Artifact assessment result cutoff semantics are unsupported');
    }
  }
  return configVersion;
}

function assessmentComponents(grading) {
  const byType = new Map();
  for (let index = 0; index < (grading.components || []).length; index++) {
    const component = grading.components[index];
    const type = component?.assessmentDefinition?.typeId;
    if (!type) continue;
    if (byType.has(type)) throw new TypeError('Assessment type is ambiguous in grading schema');
    byType.set(type, { component, index });
  }
  return byType;
}

function validateScoring(instance, component) {
  const definition = component.assessmentDefinition;
  const declared = definition.scoring;
  const actual = instance.scoring;
  const maximum = finite(instance.maximum_score, 'Assessment maximum score');
  if (maximum <= 0 || maximum > MAX_SCORE || (definition.maxScore != null && maximum > definition.maxScore)) {
    throw new RangeError('Assessment maximum score is outside the grading domain');
  }
  if (!actual || actual.mode !== declared.mode) throw new TypeError('Assessment scoring mode differs from grading schema');
  if (declared.mode === 'linear') {
    if (Object.keys(actual).sort().join(',') !== 'maximum_score,mode' || actual.maximum_score !== maximum) {
      throw new TypeError('Linear scoring maximum must match the assessment instance');
    }
  } else {
    if (Object.keys(actual).sort().join(',') !== 'mapping,mode' || !Array.isArray(actual.mapping)
      || actual.mapping.length !== declared.mapping.length) throw new TypeError('Assessment mapping differs from grading schema');
    for (let i = 0; i < actual.mapping.length; i++) {
      const got = actual.mapping[i], expected = declared.mapping[i];
      if (!got || Object.keys(got).sort().join(',') !== 'percentage,value'
        || !sameScalar(got.value, expected.value) || got.percentage !== expected.percentage) {
        throw new TypeError('Assessment mapping differs from grading schema');
      }
    }
  }
  return { mode: declared.mode, maximum };
}

function validateInstanceSet(grading, instances) {
  if (!Array.isArray(instances) || instances.length > 512) throw new RangeError('Assessment instance limit exceeded');
  const periods = new Map((grading.periods || []).map(item => [item.id, item]));
  const groups = new Map((grading.groups || []).map(item => [item.id, item]));
  const assessmentTypes = new Set((grading.assessmentTypes || []).map(item => item.id));
  const components = assessmentComponents(grading);
  const byRef = new Map();
  for (const item of instances) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Assessment instance must be an object');
    const required = ['assessment_ref', 'assessment_type_ref', 'maximum_score', 'scoring'];
    const optional = ['period_ref', 'group_ref', 'weight', 'optional', 'has_result', 'sequence', 'relative_day', 'due_in_days'];
    if (required.some(key => !own(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) {
      throw new TypeError('Assessment instance fields do not match the supported contract');
    }
    if (typeof item.assessment_ref !== 'string' || !item.assessment_ref || byRef.has(item.assessment_ref)) {
      throw new TypeError('Assessment references must be nonempty and unique');
    }
    if (typeof item.assessment_type_ref !== 'string' || !assessmentTypes.has(item.assessment_type_ref)) {
      throw new TypeError('Assessment instance references an unknown assessment type');
    }
    const componentEntry = components.get(item.assessment_type_ref);
    if (!componentEntry) throw new TypeError('Assessment type is not used by a grading component');
    if (own(item, 'sequence')) {
      const sequence = finite(item.sequence, 'Assessment sequence');
      if (sequence < 0 || sequence > MAX_SEQUENCE) throw new RangeError('Assessment sequence is outside its supported range');
    }
    for (const key of ['relative_day', 'due_in_days']) {
      if (own(item, key) && item[key] !== null) {
        const day = finite(item[key], key);
        if (Math.abs(day) > DAY_CAP) throw new RangeError(`${key} is outside its supported range`);
      }
    }
    const { mode, maximum } = validateScoring(item, componentEntry.component);
    if (item.period_ref != null && !periods.has(item.period_ref)) throw new TypeError('Assessment references an unknown period');
    if (item.group_ref != null && !groups.has(item.group_ref)) throw new TypeError('Assessment references an unknown group');
    const count = componentEntry.component.assessmentDefinition.count;
    const scope = count?.scope || { type: 'overall' };
    if (scope.type === 'per_period' && item.period_ref == null) throw new TypeError('Assessment instance requires a grading period');
    if (scope.type === 'per_group') {
      if (item.group_ref == null || groups.get(item.group_ref)?.typeId !== scope.groupTypeId) throw new TypeError('Assessment instance requires a group of the grading scope type');
    }
    if (item.period_ref != null && item.group_ref != null) {
      const allowed = periods.get(item.period_ref)?.groupIds;
      if (Array.isArray(allowed)) {
        const ancestors = new Set();
        let current = groups.get(item.group_ref);
        while (current) {
          if (ancestors.has(current.id)) throw new TypeError('Assessment group hierarchy contains a cycle');
          ancestors.add(current.id);
          current = current.parentGroupId == null ? null : groups.get(current.parentGroupId);
          if (current === undefined) throw new TypeError('Assessment group hierarchy has an unknown parent');
        }
        if (!allowed.some(id => ancestors.has(id))) throw new TypeError('Assessment group is outside its assigned period');
      }
    }
    if (own(item, 'weight') && item.weight != null && (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight < 0)) {
      throw new TypeError('Assessment weight must be finite and nonnegative');
    }
    if (componentEntry.component.assessmentDefinition.aggregation?.mode === 'weighted' && item.weight == null) {
      throw new TypeError('Weighted assessment instance requires an explicit weight');
    }
    if (own(item, 'optional') && typeof item.optional !== 'boolean') throw new TypeError('Assessment optional flag must be boolean');
    if (own(item, 'has_result') && typeof item.has_result !== 'boolean') throw new TypeError('Assessment result-presence flag must be boolean');
    const definitionScoring = componentEntry.component.assessmentDefinition.scoring;
    const choices = definitionScoring.mode === 'value_mapping'
      ? definitionScoring.mapping.map(row => row.value)
      : definitionScoring.mode === 'numeric_mapping'
        ? definitionScoring.mapping.map(row => row.value)
        : [];
    let minimum = null, maximumDomain = null, kind = 'float';
    if (mode === 'linear') { minimum = 0; maximumDomain = maximum; }
    else if (mode === 'numeric_mapping') {
      const values = choices;
      minimum = Math.min(...values); maximumDomain = Math.max(...values);
      kind = values.every(Number.isInteger) ? 'integer' : 'float';
    } else kind = 'category';
    byRef.set(item.assessment_ref, { item, component: componentEntry.component, componentIndex: componentEntry.index, kind, minimum, maximum: maximumDomain, choices });
  }
  return { byRef, periods, groups, assessmentTypes, components };
}

/**
 * Bind schema-referenced output queries to the legal domain of their concrete
 * assessment instance. This mirrors Python's bind_schema_queries before the
 * shared tensorizer runs. It returns request-local copies so the caller's
 * field specifications and query objects are never changed.
 */
export function bindAssessmentQueries(example) {
  const queries = example?.queries;
  if (!Array.isArray(queries)) throw new TypeError('Example requires queries');
  if (!queries.some(query => own(query, 'assessment_ref'))) return example;
  const grading = example.schema?.gradingSystem;
  if (!grading || typeof grading !== 'object') throw new TypeError('Assessment-bound queries require a grading schema');
  const fields = example.fields;
  if (!Array.isArray(fields)) throw new TypeError('Assessment-bound queries require field specifications');
  const instances = example.assessment_instances;
  if (!Array.isArray(instances) || instances.length === 0) throw new TypeError('Assessment-bound queries require the instance inventory');
  const { byRef } = validateInstanceSet(grading, instances);
  const results = example.assessment_results ?? [];
  if (!Array.isArray(results)) throw new TypeError('Assessment results must be an array');
  const scored = new Set();
  for (const result of results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.assessment_ref !== 'string' || !byRef.has(result.assessment_ref)
      || scored.has(result.assessment_ref)) {
      throw new TypeError('Assessment results must uniquely reference known instances');
    }
    scored.add(result.assessment_ref);
  }

  const fieldByName = new Map(fields.map(field => [field.name, field]));
  const requestDomains = new Map();
  const boundQueries = queries.map(original => {
    const query = { ...original };
    if (!own(query, 'assessment_ref')) return query;
    const info = byRef.get(query.assessment_ref);
    if (!info || scored.has(query.assessment_ref) || info.item.has_result === true) {
      throw new TypeError('Assessment query is unknown or already has a recorded result');
    }
    const spec = fieldByName.get(query.field);
    if (!spec) throw new TypeError('Assessment query identifies an undeclared field');
    if ((info.kind === 'category') !== (spec.kind === 'category')) {
      throw new TypeError('Assessment scoring and output field type disagree');
    }

    let legalChoices = [...info.choices];
    let minimum = info.minimum;
    let maximum = info.maximum;
    // Numeric mapping's upper domain is bounded by both the mapping and this
    // particular assessment's maximum, exactly as the Python domain compiler.
    if (info.item.scoring.mode === 'numeric_mapping') {
      maximum = Math.min(maximum, info.item.maximum_score);
    }

    const lowerCandidates = [spec.minimum, query.minimum, minimum].filter(value => value != null);
    const upperCandidates = [spec.maximum, query.maximum, maximum].filter(value => value != null);
    if (lowerCandidates.length) query.minimum = Math.max(...lowerCandidates);
    if (upperCandidates.length) query.maximum = Math.min(...upperCandidates);
    if (query.minimum != null && query.maximum != null && query.minimum > query.maximum) {
      throw new RangeError('Assessment query has no values within its legal domain');
    }
    if (spec.kind === 'integer' && query.minimum != null && query.maximum != null
      && Math.ceil(query.minimum) > Math.floor(query.maximum)) {
      throw new RangeError('Assessment integer domain contains no legal integer');
    }

    if (legalChoices.length) {
      if (query.choices != null) {
        if (!Array.isArray(query.choices) || query.choices.some(value => !legalChoices.some(choice => sameScalar(choice, value)))) {
          throw new TypeError('Query choices widen the referenced assessment mapping');
        }
        // Preserve the caller's legal narrowing and ordering for decoding.
        query.choices = [...query.choices];
      } else query.choices = legalChoices;
      if (info.kind === 'category') {
        const domain = requestDomains.get(query.field) || [];
        for (const choice of query.choices) {
          if (typeof choice !== 'string') throw new TypeError('Categorical assessment choices must be strings');
          if (!domain.includes(choice)) domain.push(choice);
        }
        requestDomains.set(query.field, domain);
      }
    }
    return query;
  });
  const boundFields = fields.map(field => {
    const additions = requestDomains.get(field.name);
    return additions
      ? { ...field, categories: [...new Set([...(field.categories || []), ...additions])] }
      : { ...field };
  });
  return { ...example, fields: boundFields, queries: boundQueries };
}

function resultPercent(instanceInfo, raw) {
  const { item, kind, maximum } = instanceInfo;
  if (item.scoring.mode === 'linear') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > maximum) throw new RangeError('Linear assessment result is outside its score domain');
    return raw * 100 / maximum;
  }
  const found = item.scoring.mapping.find(row => sameScalar(row.value, raw));
  if (!found) throw new RangeError('Assessment result is outside its grading mapping');
  return found.percentage;
}

function depth(groups, ref) {
  let current = ref, result = 0;
  const visited = new Set();
  while (current != null) {
    if (visited.has(current)) throw new TypeError('Assessment group hierarchy contains a cycle');
    visited.add(current);
    const group = groups.get(current);
    if (!group) throw new TypeError('Assessment references an unknown grading group');
    current = group.parentGroupId ?? null;
    if (current != null) result++;
  }
  return result;
}

const summaryScopeMatches = (candidate, target, type) => type === 'per_group'
  ? candidate.group_ref === target.group_ref
  : type === 'per_period'
    ? candidate.period_ref === target.period_ref
    : type === 'overall';

/** Compile the exact ordered 34-float v1 context for every query. */
export function compileAssessmentContexts(example) {
  const zeros = () => Array(ASSESSMENT_CONTEXT_FEATURE_NAMES.length).fill(0);
  if (!Array.isArray(example.queries) || !example.queries.some(query => own(query, 'assessment_ref'))) {
    return example.queries.map(zeros);
  }
  const grading = example.schema?.gradingSystem;
  if (!grading || typeof grading !== 'object') throw new TypeError('Assessment context requires a grading schema');
  if (!Array.isArray(example.assessment_instances) || example.assessment_instances.length === 0) throw new TypeError('Assessment context requires its full instance inventory');
  const validated = validateInstanceSet(grading, example.assessment_instances);
  const byRef = validated.byRef;
  if (example.assessment_instances.some(item => !own(item, 'sequence'))) throw new TypeError('Assessment context instances require sequence values');
  const resultsByRef = new Map();
  for (const result of example.assessment_results || []) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).some(key => !['assessment_ref', 'value', 'observed_day'].includes(key))
      || !own(result, 'assessment_ref') || !own(result, 'value')) throw new TypeError('Assessment results require a reference and raw value');
    if (typeof result.assessment_ref !== 'string' || !byRef.has(result.assessment_ref) || resultsByRef.has(result.assessment_ref)) {
      throw new TypeError('Assessment results must uniquely reference an instance');
    }
    let observedDay = 0;
    if (own(result, 'observed_day')) {
      if (result.observed_day === null) observedDay = null;
      else {
        observedDay = finite(result.observed_day, 'Observed assessment result time');
        if (observedDay > 0) throw new RangeError('Observed assessment result is after the cutoff');
      }
    }
    const info = byRef.get(result.assessment_ref);
    const percent = resultPercent(info, result.value);
    resultsByRef.set(result.assessment_ref, { result, sequence: info.item.sequence, percent, observedDay });
  }
  const typeIndexes = new Map((grading.assessmentTypes || []).map((item, index) => [item.id, index]));
  const components = assessmentComponents(grading);
  const periodRanks = ranks((grading.periods || []).map(item => finite(item.sequence, 'Grading period sequence')));
  const periodDenom = Math.max(1, periodRanks.size - 1);
  const groupSequenceRanks = new Map();
  for (const type of new Set((grading.groups || []).map(item => item.typeId))) {
    const ranksBySequence = ranks((grading.groups || []).filter(item => item.typeId === type).map(item => finite(item.sequence, 'Grading group sequence')));
    groupSequenceRanks.set(type, ranksBySequence);
  }
  const sequenceRanks = ranks(example.assessment_instances.map(item => finite(item.sequence, 'Assessment sequence')));
  const sequenceDenom = Math.max(1, sequenceRanks.size - 1);
  const querySpecs = new Map(example.fields.map(item => [item.name, item]));
  return example.queries.map(query => {
    const vector = zeros();
    if (!own(query, 'assessment_ref')) return vector;
    const targetInfo = byRef.get(query.assessment_ref);
    if (!targetInfo) throw new TypeError('Assessment query references an unknown instance');
    const target = targetInfo.item;
    if (!own(target, 'sequence')) throw new TypeError('Assessment context instances require sequence values');
    if (resultsByRef.has(query.assessment_ref) || target.has_result === true) throw new TypeError('Assessment query must reference an unscored instance');
    const spec = querySpecs.get(query.field);
    if (!spec || ((targetInfo.kind === 'category') !== (spec.kind === 'category'))) throw new TypeError('Assessment query and grading type disagree');
    const domain = targetInfo;
    if (query.choices != null && query.choices.some(value => !domain.choices.some(choice => sameScalar(choice, value)))) throw new TypeError('Assessment query choices widen the grading mapping');
    for (const [key, lower] of [['minimum', true], ['maximum', false]]) {
      const value = query[key];
      const bound = domain[lower ? 'minimum' : 'maximum'];
      if (value != null && bound != null && (lower ? value < bound : value > bound)) throw new RangeError('Assessment query bounds widen the grading domain');
    }
    const typeRef = target.assessment_type_ref;
    const typeIndex = typeIndexes.get(typeRef);
    const component = components.get(typeRef);
    if (typeIndex === undefined || !component) throw new TypeError('Assessment query type is not in the grading schema');
    const scopeType = component.component.assessmentDefinition.count?.scope?.type ?? 'overall';
    const sequence = finite(target.sequence, 'Assessment sequence');
    const sameType = example.assessment_instances.filter(item => item.assessment_type_ref === typeRef);
    const sameScope = sameType.filter(item => summaryScopeMatches(item, target, scopeType));
    const scopeRanks = ranks(sameScope.map(item => finite(item.sequence, 'Assessment sequence')));
    const period = target.period_ref == null ? null : validated.periods.get(target.period_ref);
    const group = target.group_ref == null ? null : validated.groups.get(target.group_ref);
    const groupType = group?.typeId;
    const groupTypeIndex = groupType == null ? -1 : (grading.groupTypes || []).findIndex(item => item.id === groupType);
    const groupRanks = groupType == null ? new Map() : groupSequenceRanks.get(groupType) || new Map();
    const scoringMode = target.scoring.mode;

    vector[0] = 1;
    vector[1] = ordinal(typeIndex, 511);
    vector[2] = ordinal(targetInfo.componentIndex, 511);
    vector[3] = Number(scoringMode === 'linear');
    vector[4] = Number(scoringMode === 'numeric_mapping');
    vector[5] = Number(scoringMode === 'value_mapping');
    vector[6] = Math.min(Math.log1p(target.maximum_score) / Math.log1p(1_000_000), 1);
    vector[7] = (sequenceRanks.get(sequence) || 0) / sequenceDenom;
    vector[8] = Number(period != null);
    vector[9] = period == null ? 0 : (periodRanks.get(finite(period.sequence, 'Grading period sequence')) || 0) / periodDenom;
    vector[10] = Number(group != null);
    vector[11] = groupTypeIndex < 0 ? 0 : ordinal(groupTypeIndex, 511);
    vector[12] = group == null ? 0 : (groupRanks.get(finite(group.sequence, 'Grading group sequence')) || 0) / Math.max(1, groupRanks.size - 1);
    vector[13] = group == null ? 0 : ordinal(depth(validated.groups, target.group_ref));
    vector[14] = Number(scopeType === 'overall');
    vector[15] = Number(scopeType === 'per_period');
    vector[16] = Number(scopeType === 'per_group');
    vector[17] = ordinal(scopeRanks.get(sequence) || 0);

    const priorScope = [...resultsByRef.values()].filter(entry => entry.observedDay !== null
      && entry.sequence < sequence && entry.result.assessment_ref !== query.assessment_ref
      && byRef.get(entry.result.assessment_ref).item.assessment_type_ref === typeRef
      && summaryScopeMatches(byRef.get(entry.result.assessment_ref).item, target, scopeType));
    const priorType = [...resultsByRef.values()].filter(entry => entry.observedDay !== null
      && entry.sequence < sequence && byRef.get(entry.result.assessment_ref).item.assessment_type_ref === typeRef);
    const summarize = rows => {
      const grouped = new Map();
      for (const entry of rows) grouped.set(entry.sequence, [...(grouped.get(entry.sequence) || []), entry.percent]);
      const sequences = [...grouped.keys()].sort((a, b) => a - b);
      const values = [...grouped.values()].flat();
      return { grouped, sequences, values };
    };
    const scoped = summarize(priorScope);
    vector[18] = ordinal(priorScope.length);
    vector[19] = Number(scoped.sequences.length > 0);
    vector[20] = scoped.sequences.length ? mean(scoped.grouped.get(scoped.sequences.at(-1))) / 100 : 0;
    vector[21] = mean(scoped.values) / 100;
    vector[22] = std(scoped.values) / 100;
    vector[23] = scoped.sequences.length > 1
      ? (mean(scoped.grouped.get(scoped.sequences.at(-1))) - mean(scoped.grouped.get(scoped.sequences.at(-2)))) / 100
      : 0;
    vector[24] = scoped.sequences.length ? ordinal(sequence - scoped.sequences.at(-1)) : 0;
    for (const [position, key] of [[25, 'relative_day'], [27, 'due_in_days']]) {
      if (own(target, key) && target[key] != null) {
        const days = finite(target[key], key);
        if (Math.abs(days) > DAY_CAP) throw new RangeError(`${key} is outside its supported range`);
        vector[position] = 1;
        vector[position + 1] = Math.sign(days) * Math.log1p(Math.abs(days)) / Math.log1p(DAY_CAP);
      }
    }
    const byType = summarize(priorType);
    vector[29] = ordinal(priorType.length);
    vector[30] = Number(byType.sequences.length > 0);
    if (byType.sequences.length) {
      vector[31] = mean(byType.grouped.get(byType.sequences.at(-1))) / 100;
      vector[32] = mean(byType.values) / 100;
      vector[33] = std(byType.values) / 100;
    }
    return vector;
  });
}
