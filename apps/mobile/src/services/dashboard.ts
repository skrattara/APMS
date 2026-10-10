import type { Role } from "@apms/domain";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { supabase } from "./supabase";
import { captureDatabasePlan, tracePerformanceSpan, tracePerformanceEvent } from "./performanceTrace";

export type DashboardMetrics = {
  primaryLabel: string;
  primary: string;
  secondaryLabel: string;
  secondary: string;
  tertiaryLabel: string;
  tertiary: string;
  quaternaryLabel: string;
  quaternary: string;
};

const demoStaff: DashboardMetrics = {
  primaryLabel: "Students Monitored",
  primary: "1,284",
  secondaryLabel: "Active Classes",
  secondary: "12",
  tertiaryLabel: "At-Risk Students",
  tertiary: "37",
  quaternaryLabel: "Pending Actions",
  quaternary: "8",
};
const unavailable: DashboardMetrics = {
  primaryLabel: "Students Monitored",
  primary: "—",
  secondaryLabel: "Active Classes",
  secondary: "—",
  tertiaryLabel: "At-Risk Students",
  tertiary: "—",
  quaternaryLabel: "Pending Actions",
  quaternary: "—",
};

async function count(table: string, filters?: (query: any) => any) {
  let query: any = supabase!
    .from(table)
    .select("*", { count: "exact", head: true });
  if (filters) query = filters(query);
  captureDatabasePlan(`dashboard.${table}`, () => {
    let explainQuery: any = supabase!.from(table).select("*", { count: "exact", head: true });
    if (filters) explainQuery = filters(explainQuery);
    return explainQuery;
  });
  const { count: value, error } = await tracePerformanceSpan<any>(`dashboard.query.${table}`, () => query);
  if (error) throw error;
  return value ?? 0;
}

async function loadAcademicStaff(): Promise<DashboardMetrics> {
  const [students, classes, atRisk, pending] = await Promise.all([
    count("students", (query) => query.eq("status", "active")),
    count("class_records", (query) => query.eq("status", "active")),
    count("performance_evaluations", (query) => query.eq("risk_level", "high")),
    count("assessment_results", (query) => query.eq("approval_status", "draft")),
  ]);
  return {
    primaryLabel: "Students Monitored",
    primary: students.toLocaleString(),
    secondaryLabel: "Active Classes",
    secondary: classes.toLocaleString(),
    tertiaryLabel: "At-Risk Students",
    tertiary: atRisk.toLocaleString(),
    quaternaryLabel: "Pending Actions",
    quaternary: pending.toLocaleString(),
  };
}

async function loadSystemAdmin(): Promise<DashboardMetrics> {
  const [total, active, inactive] = await Promise.all([
    count("profiles"),
    count("profiles", (query) => query.eq("status", "active")),
    count("profiles", (query) => query.eq("status", "inactive")),
  ]);
  const activeRate = total ? `${((active / total) * 100).toFixed(1)}%` : "—";
  return {
    primaryLabel: "Total Users",
    primary: total.toLocaleString(),
    secondaryLabel: "Active Users",
    secondary: active.toLocaleString(),
    tertiaryLabel: "Inactive Users",
    tertiary: inactive.toLocaleString(),
    quaternaryLabel: "System Health",
    quaternary: activeRate,
  };
}

export function useDashboardMetrics(role: Role) {
  const { demoMode, user } = useAuth();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const [metrics, setMetrics] = useState<DashboardMetrics>(
    demoStaff,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (demoMode) {
      setMetrics(demoStaff);
      setError(null);
      return () => {
        active = false;
      };
    }
    if (!supabase || !user) {
      setMetrics(unavailable);
      setError("Dashboard data is unavailable until APMS is connected.");
      return () => {
        active = false;
      };
    }
    tracePerformanceEvent('dashboard.metrics.start', { role });
    const loader = tracePerformanceSpan('dashboard.metrics.load', () => role === "system_admin" ? loadSystemAdmin() : loadAcademicStaff(), { role });
    loader
      .then((next) => {
        if (active) {
          setMetrics(next);
          setError(null);
        }
      })
      .catch(() => {
        if (active) {
          setMetrics(unavailable);
          setError("Unable to load authorized dashboard totals.");
        }
      });
    return () => {
      active = false;
    };
  }, [demoMode, role, user, version]);

  useEffect(() => {
    const client = supabase;
    if (demoMode || !client || !user) return;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        refresh();
      }, 300);
    };
    const tables = role === "system_admin"
      ? ["profiles"]
      : ["students", "class_records", "performance_evaluations", "assessment_results"];
    const channel = client.channel(`dashboard-${user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of tables) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleRefresh);
    }
    channel.subscribe();
    const poll = setInterval(scheduleRefresh, 60_000);
    return () => {
      clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
      void client.removeChannel(channel);
    };
  }, [demoMode, refresh, role, user]);

  return { metrics, error };
}
