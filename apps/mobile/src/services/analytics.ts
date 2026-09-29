import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import type { ChartDatum } from "@/components/ui";
import { supabase } from "./supabase";

const MAX_ANALYTICS_ROWS = 5_000;

export type EvaluationRecord = {
  id?: string;
  label: string;
  score: number;
  risk: string;
  classification: string;
  category: string;
  timestamp?: string;
};

export type LiveAnalytics = {
  loading: boolean;
  error: string | null;
  metrics: { students: string; model: string; average: string; highRisk: string };
  scoreSeries: ChartDatum[];
  riskSeries: ChartDatum[];
  records: EvaluationRecord[];
  truncated: boolean;
  refresh: () => void;
};

function labelRisk(value: string) {
  if (value === "low") return "Low";
  if (value === "medium") return "Medium";
  if (value === "high") return "High";
  return "Unclassified";
}

export function useLiveAnalytics(): LiveAnalytics {
  const { demoMode, user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [evaluations, setEvaluations] = useState<EvaluationRecord[]>([]);
  const [evaluationTotal, setEvaluationTotal] = useState(0);
  const [modelStatus, setModelStatus] = useState("Unavailable");
  const hasLoaded = useRef(false);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const client = supabase;
    if (demoMode || !user || !client) return;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 300);
    };
    const channel = client
      .channel(`apms-live-analytics-${user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "performance_evaluations" }, scheduleRefresh)
      .subscribe();
    const poll = setInterval(refresh, 60_000);
    return () => {
      clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
      void client.removeChannel(channel);
    };
  }, [demoMode, refresh, user]);

  useEffect(() => {
    const client = supabase;
    if (demoMode || !user || !client) {
      setEvaluations([]);
      setEvaluationTotal(0);
      setModelStatus("Unavailable");
      setError(null);
      setLoading(false);
      hasLoaded.current = false;
      return;
    }

    let active = true;
    setLoading(!hasLoaded.current);
    Promise.all([
      client
        .from("performance_evaluations")
        .select(
          "score,risk_level,classification,calculated_at,enrollments(students(first_name,last_name,institutional_id),class_records(section,subjects(code)))",
          { count: "exact" },
        )
        .order("calculated_at", { ascending: false })
        .range(0, MAX_ANALYTICS_ROWS - 1),
      client
        .from("model_versions")
        .select("name,version,status")
        .eq("status", "active")
        .limit(1)
        .maybeSingle(),
    ])
      .then(([evaluationResult, modelResult]) => {
        if (!active) return;
        if (evaluationResult.error) throw evaluationResult.error;
        if (modelResult.error) throw modelResult.error;
        const rows = evaluationResult.data ?? [];
        setEvaluations(rows.map((item: any, index) => {
          const student = item.enrollments?.students;
          const classRecord = item.enrollments?.class_records;
          const studentName = student?.first_name && student?.last_name
            ? `${student.first_name} ${student.last_name}`
            : student?.institutional_id ?? `Record ${index + 1}`;
          const subject = classRecord?.subjects?.code;
          return {
            label: studentName,
            score: Number(item.score) || 0,
            risk: String(item.risk_level ?? "unclassified").toLowerCase(),
            classification: String(item.classification ?? "Unclassified"),
            category: subject ? `${subject}${classRecord?.section ? ` · ${classRecord.section}` : ""}` : "Unassigned",
            timestamp: item.calculated_at ? String(item.calculated_at) : undefined,
          };
        }));
        setEvaluationTotal(evaluationResult.count ?? rows.length);
        setModelStatus(modelResult.data ? `${modelResult.data.version} active` : "Unavailable");
        setError(null);
        hasLoaded.current = true;
      })
      .catch(() => {
        if (!active) return;
        setEvaluations([]);
        setEvaluationTotal(0);
        setModelStatus("Unavailable");
        setError("Unable to load persisted APMS analytics.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [demoMode, user, version]);

  const scoreSeries = useMemo(() => {
    const byDay = new Map<string, { total: number; count: number }>();
    for (const item of evaluations) {
      if (!item.timestamp) continue;
      const day = item.timestamp.slice(0, 10);
      const current = byDay.get(day) ?? { total: 0, count: 0 };
      current.total += item.score;
      current.count += 1;
      byDay.set(day, current);
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({
      label: new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: value.total / value.count,
    }));
  }, [evaluations]);

  const riskSeries = useMemo(() => {
    const counts = new Map<string, number>([["Low", 0], ["Medium", 0], ["High", 0], ["Unclassified", 0]]);
    for (const item of evaluations) {
      const label = labelRisk(item.risk);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts, ([label, value]) => ({ label, value }));
  }, [evaluations]);

  const average = evaluations.length
    ? evaluations.reduce((sum, item) => sum + item.score, 0) / evaluations.length
    : null;
  const highRisk = evaluations.filter((item) => item.risk === "high").length;

  return {
    loading,
    error,
    metrics: {
      students: evaluationTotal.toLocaleString(),
      model: modelStatus,
      average: average == null ? "—" : `${average.toFixed(1)}%`,
      highRisk: String(highRisk),
    },
    scoreSeries,
    riskSeries,
    records: evaluations,
    truncated: evaluationTotal > MAX_ANALYTICS_ROWS,
    refresh,
  };
}
