import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Field, SelectField } from "@/components/ui";
import { colors } from "@/theme/tokens";
import type { EvaluationRecord } from "@/services/analytics";
import type { RiskSelectOption } from "@/services/evaluationRiskOptions";

const periodOptions = [
  { label: "Any time", value: "all" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
];
const defaultRiskOptions = [
  { label: "All risks", value: "all" },
  { label: "Low risk", value: "low" },
  { label: "Medium risk", value: "medium" },
  { label: "High risk", value: "high" },
  { label: "Unavailable", value: "unavailable" },
];

export function useAnalyticsFilters<T extends EvaluationRecord>(records: T[], configuredRiskOptions?: RiskSelectOption[]) {
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState("all");
  const [category, setCategory] = useState("all");
  const [classification, setClassification] = useState("all");
  const [period, setPeriod] = useState("all");
  const [minimumScore, setMinimumScore] = useState("");
  useEffect(() => {
    if (configuredRiskOptions && !configuredRiskOptions.some((option) => option.value === risk)) setRisk("all");
  }, [configuredRiskOptions, risk]);
  const categoryOptions = useMemo(() => [
    { label: "All classes / categories", value: "all" },
    ...Array.from(new Set(records.map((record) => record.category).filter(Boolean))).sort().map((value) => ({ label: value, value })),
  ], [records]);
  const classificationOptions = useMemo(() => [
    { label: "All classifications", value: "all" },
    ...Array.from(new Set(records.map((record) => record.classification).filter(Boolean))).sort().map((value) => ({ label: value, value })),
  ], [records]);
  const filtered = useMemo(() => {
    const cutoff = period === "all" ? null : Date.now() - Number(period) * 86_400_000;
    const min = minimumScore.trim() ? Number(minimumScore) : null;
    const query = search.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (risk !== "all" && record.risk !== risk) return false;
      if (category !== "all" && record.category !== category) return false;
      if (classification !== "all" && record.classification !== classification) return false;
      if (min !== null && Number.isFinite(min) && record.score < min) return false;
      if (query && !`${record.label} ${record.category} ${record.classification}`.toLocaleLowerCase().includes(query)) return false;
      if (cutoff !== null && (!record.timestamp || new Date(record.timestamp).getTime() < cutoff)) return false;
      return true;
    });
  }, [category, classification, minimumScore, period, records, risk, search]);

  const controls = (
    <View style={styles.wrapper}>
      <View style={styles.row}>
        <Field label="Search student or class" value={search} onChangeText={setSearch} placeholder="Name, subject, or section" containerStyle={styles.search} />
        <SelectField label="Class / category" value={category} options={categoryOptions} onChange={setCategory} containerStyle={styles.field} searchable />
        <SelectField label="Risk" value={risk} options={configuredRiskOptions ?? defaultRiskOptions} onChange={setRisk} containerStyle={styles.field} />
        <SelectField label="Classification" value={classification} options={classificationOptions} onChange={setClassification} containerStyle={styles.field} />
        <SelectField label="Period" value={period} options={periodOptions} onChange={setPeriod} containerStyle={styles.field} />
        <Field label="Minimum score" value={minimumScore} onChangeText={setMinimumScore} placeholder="0–100" keyboardType="decimal-pad" containerStyle={styles.field} />
      </View>
      <Text style={styles.count}>{filtered.length.toLocaleString()} records match these filters</Text>
    </View>
  );

  return { filtered, controls };
}

const styles = StyleSheet.create({
  wrapper: { padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface, marginBottom: 14 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 10 },
  search: { flexGrow: 1, flexBasis: 220, minWidth: 190, marginBottom: 0 },
  field: { flexGrow: 1, flexBasis: 145, minWidth: 140, marginBottom: 0 },
  count: { color: colors.textMuted, fontSize: 11, marginTop: 10 },
});
