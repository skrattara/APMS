import { getErrorMessage } from '@/services/errors';
import { useCallback, useEffect, useState } from "react";
import type { Role } from "@apms/domain";

import { useAuth } from "@/auth/AuthProvider";
import { EMPTY_SCREEN_RECORDS, MOCK_SCREEN_RECORDS } from "@/data/mockRecords";
import { supabase } from "./supabase";

export type ScreenData = { columns: string[]; rows: string[][] };
type State = {
  data: ScreenData;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const empty: ScreenData = { columns: [], rows: [] };
const dash = "-";

export function demoScreenData(screen: string): ScreenData {
  const data = MOCK_SCREEN_RECORDS[screen] ?? EMPTY_SCREEN_RECORDS;
  return {
    columns: [...data.columns],
    rows: data.rows.map((row) => [...row]),
  };
}

function text(value: unknown) {
  return value == null || value === "" ? dash : String(value);
}

function date(value: unknown) {
  return value ? new Date(String(value)).toLocaleDateString() : dash;
}

function audience(value: unknown) {
  if (value && typeof value === "object" && "label" in value) {
    return text((value as { label?: unknown }).label);
  }
  return text(value);
}

async function fetchScreenData(screen: string, role: Role): Promise<ScreenData> {
  if (!supabase) throw new Error("APMS is not connected to Supabase.");

  if (screen === "students") {
    const { data, error } = await supabase
      .from("students")
      .select(
        "institutional_id,email,first_name,last_name,year_level,status,programs(code),profiles(email,phone)",
      )
      .order("institutional_id");
    if (error) throw error;
    return {
      columns: ["ID", "Name", "Contact", "Year", "Remarks", "Status"],
      rows: (data ?? []).map((item: any) => [
        text(item.institutional_id),
        `${text(item.first_name)} ${text(item.last_name)}`,
        `${text(item.profiles?.email ?? item.email)}${
          item.profiles?.phone ? `\n${text(item.profiles.phone)}` : ""
        }`,
        text(item.year_level),
        text(item.status),
        text(item.status === "active" ? "complete" : "incomplete"),
      ]),
    };
  }

  if (screen === "records") {
    const { data, error } = await supabase
      .from("class_records")
      .select("section,status,subjects(code,title),enrollments(count)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return {
      columns: ["Code", "Class", "Section", "Students", "Status"],
      rows: (data ?? []).map((item: any) => [
        text(item.subjects?.code),
        text(item.subjects?.title),
        text(item.section),
        text(item.enrollments?.[0]?.count ?? 0),
        text(item.status),
      ]),
    };
  }

  if (screen === "logs") {
    const { data, error } = await supabase
      .from("audit_logs")
      .select("created_at,actor_id,action,entity_type")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return {
      columns: ["Timestamp", "Actor", "Action", "Entity"],
      rows: (data ?? []).map((item) => [
        date(item.created_at),
        text(item.actor_id),
        text(item.action),
        text(item.entity_type),
      ]),
    };
  }

  if (screen === "grades") {
    const { data, error } = await supabase
      .from("assessment_results")
      .select(
        "score,approval_status,assessments(title,maximum_score,class_records(subjects(code)))",
      )
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return {
      columns: ["Subject", "Assessment", "Score", "Percentage", "Status"],
      rows: (data ?? []).map((item: any) => {
        const maximum = Number(item.assessments?.maximum_score);
        const percentage =
          maximum > 0
            ? `${((Number(item.score) / maximum) * 100).toFixed(1)}%`
            : dash;
        return [
          text(item.assessments?.class_records?.subjects?.code),
          text(item.assessments?.title),
          `${text(item.score)} / ${text(maximum)}`,
          percentage,
          text(item.approval_status),
        ];
      }),
    };
  }

  if (screen === "feedback") {
    const { data, error } = await supabase
      .from("feedback_records")
      .select("created_at,category,body,status")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return {
      columns: ["Date", "Category", "Summary", "Delivery", "Status"],
      rows: (data ?? []).map((item) => [
        date(item.created_at),
        text(item.category),
        text(item.body).slice(0, 80),
        item.status === "sent" || item.status === "published" ? "Published" : "Not published",
        text(item.status),
      ]),
    };
  }

  if (screen === "faculty") {
    const { data, error } = await supabase
      .from("faculty_profiles")
      .select(
        "employee_id,status,profiles(first_name,last_name),departments(name),faculty_assignments(count)",
      )
      .order("employee_id");
    if (error) throw error;
    return {
      columns: ["Employee ID", "Faculty", "Department", "Classes", "Status"],
      rows: (data ?? []).map((item: any) => [
        text(item.employee_id),
        `${text(item.profiles?.first_name)} ${text(item.profiles?.last_name)}`,
        text(item.departments?.name),
        text(item.faculty_assignments?.[0]?.count ?? 0),
        text(item.status),
      ]),
    };
  }

  if (screen === "criteria") {
    const { data, error } = await supabase
      .from("criteria_sets")
      .select("name,version,total_weight,status,class_records(section)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return {
      columns: ["Criteria Set", "Version", "Scope", "Total Weight", "Status"],
      rows: (data ?? []).map((item: any) => [
        text(item.name),
        text(item.version),
        text(item.class_records?.section),
        `${text(item.total_weight)}%`,
        text(item.status),
      ]),
    };
  }

  if (screen === "events") {
    const { data, error } = await supabase
      .from("events")
      .select("title,starts_at,audience,created_by,status")
      .order("starts_at");
    if (error) throw error;
    return {
      columns: ["Event", "Date", "Audience", "Owner", "Status"],
      rows: (data ?? []).map((item) => [
        text(item.title),
        date(item.starts_at),
        audience(item.audience),
        text(item.created_by),
        text(item.status),
      ]),
    };
  }

  if (screen === "roles") {
    const { data, error } = await supabase
      .from("roles")
      .select("name,description,role_permissions(count),user_roles(count)")
      .order("name");
    if (error) throw error;
    return {
      columns: ["Role", "Users", "Permissions", "Description", "Status"],
      rows: (data ?? []).map((item: any) => [
        text(item.name),
        text(item.user_roles?.[0]?.count ?? 0),
        text(item.role_permissions?.[0]?.count ?? 0),
        text(item.description),
        "Active",
      ]),
    };
  }

  if (screen === "admins") {
    const { data, error } = await supabase
      .from("profiles")
      .select(
        "first_name,last_name,email,status,last_login_at,user_roles!user_roles_user_id_fkey!inner(roles!inner(name,key))",
      );
    if (error) throw error;
    return {
      columns: ["Admin", "Email", "Role", "Last Active", "Status"],
      rows: (data ?? [])
        .filter((item: any) => item.user_roles?.[0]?.roles?.key === "system_admin")
        .map((item: any) => [
          `${text(item.first_name)} ${text(item.last_name)}`,
          text(item.email),
          text(item.user_roles?.[0]?.roles?.name),
          date(item.last_login_at),
          text(item.status),
        ]),
    };
  }

  if (screen === "backup") {
    const { data, error } = await supabase
      .from("backups")
      .select("id,scope,created_at,size_bytes,checksum,status")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return {
      columns: ["Backup", "Started", "Size", "Verification", "Status"],
      rows: (data ?? []).map((item) => [
        text(item.id).slice(0, 8),
        date(item.created_at),
        item.size_bytes
          ? `${Math.round(Number(item.size_bytes) / 1048576)} MB`
          : dash,
        item.checksum ? "Checksum stored" : "Pending",
        text(item.status),
      ]),
    };
  }

  return { columns: ["Item", "Description", "Owner", "Updated", "Status"], rows: [] };
}

export function useScreenRecords(screen: string, role: Role): State {
  const { demoMode } = useAuth();
  const [data, setData] = useState<ScreenData>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    if (demoMode) {
      setData(demoScreenData(screen));
      setLoading(false);
      return () => {
        active = false;
      };
    }
    fetchScreenData(screen, role)
      .then((next) => {
        if (active) setData(next);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            getErrorMessage(cause, "Unable to load records."),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [demoMode, role, screen, version]);

  return { data, loading, error, refresh };
}
