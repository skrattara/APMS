import { getErrorMessage } from '@/services/errors';
import type { Role } from "@apms/domain";
import { lazy, Suspense, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { useAuth, type AuthUser } from "@/auth/AuthProvider";
import { AppShell } from "@/components/AppShell";
import { AppIcon } from "@/components/Icon";
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  MetricCard,
  PageState,
  SearchFilter,
  SelectField,
  Tabs,
  useToast,
} from "@/components/ui";
import { ROLE_LABELS } from "@/config/navigation";
import {
  ANALYTICS_SERIES,
  AUTH_PROVIDER_OPTIONS,
  DASHBOARD_MOCKS,
  EVENT_AUDIENCE_OPTIONS,
  EVENT_CATEGORY_OPTIONS,
  EVENT_DEPARTMENT_OPTIONS,
  EVENT_FORM_DEFAULTS,
  EVENT_PRIORITY_OPTIONS,
  EVENT_STATUS_OPTIONS,
  LANGUAGE_OPTIONS,
  LOCKOUT_OPTIONS,
  RETENTION_OPTIONS,
  SESSION_OPTIONS,
  SYSTEM_DEFAULTS,
  TIMEZONE_OPTIONS,
} from "@/data/mockDashboard";
import {
  changePassword,
  loadAutosavePreference,
  performScreenAction,
  saveSettings,
  type SettingsValues,
} from "@/services/actions";
import { useDashboardMetrics } from "@/services/dashboard";
import { useLiveAnalytics, type LiveAnalytics } from "@/services/analytics";
import {
  createEvent,
  type EventCategory,
  type EventInput,
  type EventPriority,
  type EventStatus,
} from "@/services/events";
import { useScreenRecords } from "@/services/records";
import { FacultyLivePortalContent } from "@/screens/FacultyLivePortalContent";
import { colors, radius, space } from "@/theme/tokens";
import { useAnalyticsFilters } from "@/components/charts/AnalyticsFilters";
import type { EvaluationRecord } from "@/services/analytics";

const LazyFacultyPortalContent = lazy(() => import("@/screens/FacultyPortalContent").then((module) => ({ default: module.FacultyPortalContent })));
const LazyAcademicAdminPortalContent = lazy(() => import("@/screens/AcademicAdminPortalContent").then((module) => ({ default: module.AcademicAdminPortalContent })));
const LazySystemAdminPortalContent = lazy(() => import("@/screens/SystemAdminPortalContent").then((module) => ({ default: module.SystemAdminPortalContent })));
const LazyDataGeneratorDevScreen = lazy(() => import("@/screens/DataGeneratorDevScreen").then((module) => ({ default: module.DataGeneratorDevScreen })));
const LazyVisualizationPanel = lazy(() => import("@/components/charts/VisualizationPanel").then((module) => ({ default: module.VisualizationPanel })));
type VisualizationPanelProps = ComponentProps<typeof LazyVisualizationPanel>;

function DashboardChart(props: VisualizationPanelProps) {
  return <Suspense fallback={<Card><Text style={styles.sectionTitle}>Preparing chart…</Text></Card>}><LazyVisualizationPanel {...props} /></Suspense>;
}

type ScreenKind =
  "dashboard" | "table" | "analytics" | "settings" | "assistant" | "security";
type ScreenDefinition = {
  title: string;
  subtitle: string;
  kind: ScreenKind;
  action?: string;
};

const SCREENS: Record<string, ScreenDefinition> = {
  overview: {
    title: "Dashboard Overview",
    subtitle:
      "Monitor performance, recent activity, and items requiring attention.",
    kind: "dashboard",
  },
  backup: {
    title: "Backup Management",
    subtitle: "Create, verify, restore, and monitor protected system backups.",
    kind: "table",
    action: "Create Backup",
  },
  grades: {
    title: "Grades",
    subtitle: "View assessment results and grade status by subject.",
    kind: "table",
    action: "Submit Grades",
  },
  feedback: {
    title: "Performance Feedback",
    subtitle: "Review targeted feedback and recommended next actions.",
    kind: "table",
    action: "Send Feedback",
  },
  students: {
    title: "Student Management",
    subtitle: "Search and manage students within your authorized scope.",
    kind: "table",
    action: "Add Student",
  },
  faculty: {
    title: "Faculty Directory",
    subtitle: "Review faculty assignments and active class responsibilities.",
    kind: "table",
    action: "Add Faculty",
  },
  records: {
    title: "Class Records",
    subtitle:
      "Manage class templates, assessments, grading weights, and records.",
    kind: "table",
    action: "Create Class Record",
  },
  classes: {
    title: "Classes Overview",
    subtitle: "Review assigned or authorized monitoring classes.",
    kind: "table",
  },
  gradebook: {
    title: "Class Gradebook",
    subtitle: "Create assessments and batch-enter current monitoring scores.",
    kind: "table",
  },
  attendance: {
    title: "Attendance",
    subtitle: "Create sessions and record class roll call.",
    kind: "table",
  },
  risk: {
    title: "At-Risk Students",
    subtitle: "Prioritize authorized students who may need faculty attention.",
    kind: "table",
  },
  units: {
    title: "Academic Units",
    subtitle: "Review authorized program and department scope.",
    kind: "table",
  },
  criteria: {
    title: "Evaluation Criteria",
    subtitle: "Configure transparent evaluation and prediction criteria.",
    kind: "table",
    action: "Add Criteria",
  },
  evaluation: {
    title: "Performance & Prediction",
    subtitle: "Run decision-support analysis from approved academic records.",
    kind: "analytics",
    action: "Run Evaluation",
  },
  analytics: {
    title: "Analytics & Insights",
    subtitle: "Explore performance trends and risk distributions.",
    kind: "analytics",
    action: "Export Report",
  },
  events: {
    title: "Events",
    subtitle: "Manage academic deadlines and performance-related events.",
    kind: "table",
    action: "Add Event",
  },
  roles: {
    title: "Roles & Permissions",
    subtitle: "Manage role assignments and feature-level access.",
    kind: "table",
    action: "Add Role",
  },
  admins: {
    title: "Admin Accounts",
    subtitle: "Manage system operator accounts and account status.",
    kind: "table",
    action: "Add Admin",
  },
  logs: {
    title: "System Logs",
    subtitle: "Inspect security, access, integration, and audit activity.",
    kind: "table",
    action: "Export Logs",
  },
  system: {
    title: "System Settings",
    subtitle: "Configure global system settings and preferences.",
    kind: "settings",
  },
  "data-generator": {
    title: "Synthetic Data Generator",
    subtitle: "Create deterministic, grading-system-aware synthetic data.",
    kind: "table",
  },
  settings: {
    title: "Settings",
    subtitle: "Update your profile, notifications, and password.",
    kind: "settings",
  },
  notifications: {
    title: "Notifications",
    subtitle: "Configure delivery channels and notification rules.",
    kind: "settings",
  },
  security: {
    title: "Security",
    subtitle: "Review authentication policy, sessions, and safeguards.",
    kind: "security",
  },
  info: {
    title: "System Information",
    subtitle: "View deployed service versions, health, and storage status.",
    kind: "security",
  },
  assistant: {
    title: "APMS AI Assistant",
    subtitle: "Ask questions about authorized academic performance data.",
    kind: "assistant",
  },
};

export function AppPortalScreen({
  role,
  screen,
}: {
  role: Role;
  screen: string;
}) {
  const baseDefinition = SCREENS[screen] ?? {
    title: "Unavailable",
    subtitle: "This page is not configured.",
    kind: "table" as const,
  };
  const facultyCopy: Record<
    string,
    Pick<ScreenDefinition, "title" | "subtitle">
  > = {
    overview: {
      title: "Faculty Overview",
      subtitle: "Quick overview of recorded student performance",
    },
    students: {
      title: "Student Management",
      subtitle: "Manage assigned student records",
    },
    records: {
      title: "Class Records",
      subtitle: "Manage class records and student performance data",
    },
    events: {
      title: "Events",
      subtitle: "Manage academic schedules and activities",
    },
    feedback: {
      title: "Performance Feedback",
      subtitle: "Prepare and send personalized feedback",
    },
    analytics: {
      title: "Analytics & Insights",
      subtitle: "Recorded performance analytics",
    },
    settings: { title: "Settings", subtitle: "Manage account & preferences" },
  };
  const definition = role === "faculty" && facultyCopy[screen]
    ? { ...baseDefinition, ...facultyCopy[screen] }
    : baseDefinition;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [createdEventRows, setCreatedEventRows] = useState<string[][]>([]);
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const { user, demoMode } = useAuth();
  const liveRolePortal = !demoMode && (role === "faculty" || role === "academic_admin" || role === "system_admin");
  const runAction = async () => {
    if (!user || !definition.action) return;
    setPending(true);
    try {
      toast.show(
        await performScreenAction({
          screen,
          role,
          user,
          demoMode,
          label: definition.action,
        }),
      );
      setDialogOpen(false);
    } catch (cause) {
      toast.show(
        getErrorMessage(cause, "The action could not be completed."),
      );
    } finally {
      setPending(false);
    }
  };
  const action = liveRolePortal ? undefined : definition.action ? (
      <Button
        label={definition.action}
        onPress={() =>
          screen === "events" ? setEventDialogOpen(true) : setDialogOpen(true)
        }
      />
    ) : undefined;
  return (
    <AppShell
      role={role}
      screen={screen}
      title={definition.title}
      subtitle={definition.subtitle}
      actions={action}
    hidePageHeader={(liveRolePortal || role === "faculty") && screen !== "settings"}
    >
      {role === "faculty" && screen !== "settings" ? (
        demoMode ? <Suspense fallback={<PageState kind="loading" title="Loading Faculty dashboard" message="Preparing your dashboard." />}><LazyFacultyPortalContent screen={screen} /></Suspense> : <FacultyLivePortalContent screen={screen} />
      ) : role === "academic_admin" && !demoMode ? (
        <Suspense fallback={<PageState kind="loading" title="Loading academic workspace" message="Preparing your workspace." />}><LazyAcademicAdminPortalContent screen={screen} /></Suspense>
      ) : role === "system_admin" && screen === "data-generator" && __DEV__ && !demoMode ? (
        <Suspense fallback={<PageState kind="loading" title="Loading data generator" message="Preparing the generator." />}><LazyDataGeneratorDevScreen /></Suspense>
      ) : role === "system_admin" && !demoMode ? (
        <Suspense fallback={<PageState kind="loading" title="Loading system workspace" message="Preparing your workspace." />}><LazySystemAdminPortalContent screen={screen} /></Suspense>
      ) : (
        <>
          {definition.kind === "dashboard" ? <Dashboard role={role} /> : null}
          {definition.kind === "table" ? (
            <Records
              role={role}
              screen={screen}
              appendedRows={screen === "events" ? createdEventRows : []}
            />
          ) : null}
          {definition.kind === "analytics" ? (
            <Analytics screen={screen} />
          ) : null}
          {definition.kind === "settings" ? (
            <Settings role={role} screen={screen} onMessage={toast.show} />
          ) : null}
          {definition.kind === "security" ? <Security screen={screen} /> : null}
          {definition.kind === "assistant" ? <Assistant role={role} /> : null}
          <ConfirmDialog
            visible={dialogOpen}
            pending={pending}
            title={definition.action ?? "Confirm"}
            message={
              screen === "students"
                ? "Student enrollment requires a validated institutional identifier and assigned class."
                : "This action is permission checked and recorded in the audit log. Continue?"
            }
            confirmLabel={definition.action}
            cancelLabel="Close"
            onClose={() => setDialogOpen(false)}
            onConfirm={() => void runAction()}
            danger={screen === "backup"}
          />
          {user ? (
            <EventDialog
              visible={eventDialogOpen}
              user={user}
              demoMode={demoMode}
              onClose={() => setEventDialogOpen(false)}
              onCreated={(message, row) => {
                setCreatedEventRows((current) => [row, ...current]);
                setEventDialogOpen(false);
                toast.show(message);
              }}
            />
          ) : null}
        </>
      )}
    </AppShell>
  );
}

function EventDialog({
  visible,
  user,
  demoMode,
  onClose,
  onCreated,
}: {
  visible: boolean;
  user: AuthUser;
  demoMode: boolean;
  onClose: () => void;
  onCreated: (message: string, row: string[]) => void;
}) {
  const [values, setValues] = useState<EventInput>({
    ...EVENT_FORM_DEFAULTS,
    category: EVENT_FORM_DEFAULTS.category as EventCategory,
    priority: EVENT_FORM_DEFAULTS.priority as EventPriority,
    status: EVENT_FORM_DEFAULTS.status as EventStatus,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = <Key extends keyof EventInput>(
    key: Key,
    value: EventInput[Key],
  ) => setValues((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const created = await createEvent(values, user, demoMode);
      onCreated(created.message, created.row);
      setValues({
        ...EVENT_FORM_DEFAULTS,
        category: EVENT_FORM_DEFAULTS.category as EventCategory,
        priority: EVENT_FORM_DEFAULTS.priority as EventPriority,
        status: EVENT_FORM_DEFAULTS.status as EventStatus,
      });
    } catch (cause) {
      setError(
        getErrorMessage(cause, "The event could not be created."),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={saving ? undefined : onClose}
    >
      <View style={styles.overlay}>
        <Card style={styles.eventDialog}>
          <View>
            <Text style={styles.dialogTitle}>Add Event</Text>
            <Text style={styles.muted}>
              Create a scheduled or draft academic event. Times use Asia/Manila.
            </Text>
          </View>
          <Field
            label="Event title"
            value={values.title}
            onChangeText={(value) => update("title", value)}
            maxLength={120}
          />
          <Field
            label="Description"
            value={values.description}
            onChangeText={(value) => update("description", value)}
            multiline
            numberOfLines={3}
            maxLength={1000}
            style={styles.eventDescription}
          />
          <View style={styles.eventFormGrid}>
            <SelectField
              containerStyle={styles.eventField}
              label="Department"
              value={values.department}
              options={EVENT_DEPARTMENT_OPTIONS}
              onChange={(value) => update("department", value)}
            />
            <SelectField
              containerStyle={styles.eventField}
              label="Category"
              value={values.category}
              options={EVENT_CATEGORY_OPTIONS}
              onChange={(value) => update("category", value as EventCategory)}
            />
            <SelectField
              containerStyle={styles.eventField}
              label="Priority"
              value={values.priority}
              options={EVENT_PRIORITY_OPTIONS}
              onChange={(value) => update("priority", value as EventPriority)}
            />
            <SelectField
              containerStyle={styles.eventField}
              label="Audience"
              value={values.audience}
              options={EVENT_AUDIENCE_OPTIONS}
              onChange={(value) => update("audience", value)}
            />
            <SelectField
              containerStyle={styles.eventField}
              label="Status"
              value={values.status}
              options={EVENT_STATUS_OPTIONS}
              onChange={(value) => update("status", value as EventStatus)}
            />
            <Field
              containerStyle={styles.eventField}
              label="Starts at"
              value={values.startsAt}
              onChangeText={(value) => update("startsAt", value)}
              placeholder="YYYY-MM-DD HH:mm"
            />
            <Field
              containerStyle={styles.eventField}
              label="Ends at"
              value={values.endsAt}
              onChangeText={(value) => update("endsAt", value)}
              placeholder="YYYY-MM-DD HH:mm"
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={styles.dialogError}>
              {error}
            </Text>
          ) : null}
          <View style={styles.dialogActions}>
            <Button
              label="Cancel"
              variant="secondary"
              disabled={saving}
              onPress={onClose}
            />
            <Button
              label="Create event"
              loading={saving}
              disabled={
                !values.title.trim() ||
                !values.startsAt.trim() ||
                !values.endsAt.trim()
              }
              onPress={() => void submit()}
            />
          </View>
        </Card>
      </View>
    </Modal>
  );
}

function Dashboard({ role }: { role: Role }) {
  const { metrics, error } = useDashboardMetrics(role);
  const { demoMode } = useAuth();
  const data = DASHBOARD_MOCKS[role];
  return (
    <>
      {demoMode ? (
        <Card>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Fictional validation mode
          </Text>
          <Text style={styles.muted}>
            All values on this dashboard are local validation data, not live
            academic or operational records.
          </Text>
        </Card>
      ) : null}
      {error ? (
        <PageState kind="error" title="Dashboard unavailable" message={error} />
      ) : null}
      <View style={styles.metrics}>
        <MetricCard label={metrics.primaryLabel} value={metrics.primary} />
        <MetricCard
          label={metrics.secondaryLabel}
          value={metrics.secondary}
          tone="success"
        />
        <MetricCard
          label={metrics.tertiaryLabel}
          value={metrics.tertiary}
          tone="warning"
        />
        <MetricCard
          label={metrics.quaternaryLabel}
          value={metrics.quaternary}
          tone="info"
        />
      </View>
      {demoMode ? (
        <>
          <View style={styles.columns}>
            <DashboardChart title={data.trendTitle} description={data.trendSubtitle} data={data.trend.map((point) => ({ ...point, kind: "timeseries" as const }))} type="line" suffix={role === "system_admin" ? "" : "%"} />
            <DashboardChart title={role === "system_admin" ? "User Distribution" : "Risk Distribution"} description="Breakdown of the current monitoring data." data={data.risk} type="pie" suffix={role === "academic_admin" ? "%" : ""} />
          </View>
          <Card>
            <Text style={styles.sectionTitle}>{data.tableTitle}</Text>
            <View style={styles.tableGap}>
              <DataTable columns={data.tableColumns} rows={data.tableRows} />
            </View>
          </Card>
        </>
      ) : (
        <PageState
          kind="empty"
          title="No chart history"
          message="Charts appear after authorized records are persisted."
        />
      )}
    </>
  );
}

function Records({
  role,
  screen,
  appendedRows = [],
}: {
  role: Role;
  screen: string;
  appendedRows?: string[][];
}) {
  const { demoMode } = useAuth();
  const records = useScreenRecords(screen, role);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [selected, setSelected] = useState<string[] | null>(null);
  const rows = useMemo(
    () =>
      [...appendedRows, ...records.data.rows].filter((row) => {
        const matchesQuery = row
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase());
        const last = row.at(-1)?.toLowerCase() ?? "";
        const matchesStatus =
          status === "All" ||
          (status === "Active"
            ? /active|approved|complete|success|read|delivered|published|scheduled/.test(
                last,
              )
            : /pending|draft|inactive|warning|queued/.test(last));
        return matchesQuery && matchesStatus;
      }),
    [appendedRows, query, records.data.rows, status],
  );
  return (
    <>
      <Card>
        <View style={styles.toolbar}>
          <SearchFilter
            value={query}
            onChange={setQuery}
            placeholder={
              screen === "students"
                ? "Search by name, ID, or email..."
                : "Search records..."
            }
          />
          <Tabs
            values={["All", "Active", "Pending"]}
            selected={status}
            onSelect={setStatus}
          />
        </View>
        {records.loading ? (
          <PageState
            kind="loading"
            title="Loading records"
            message="Retrieving authorized APMS records…"
          />
        ) : records.error ? (
          <PageState
            kind="error"
            title="Unable to load records"
            message={records.error}
            action={<Button label="Try again" onPress={records.refresh} />}
          />
        ) : rows.length ? (
          <DataTable
            columns={records.data.columns}
            rows={rows}
            onRowPress={setSelected}
          />
        ) : (
          <PageState
            kind="empty"
            title="No records found"
            message="Adjust the search or status filter."
          />
        )}
      </Card>
      {selected ? (
        <Card>
          <View style={styles.detailHeader}>
            <View>
              <Text style={styles.sectionTitle}>Record details</Text>
              <Text style={styles.muted}>{selected.join(" · ")}</Text>
            </View>
            <Button
              label="Close"
              variant="ghost"
              onPress={() => setSelected(null)}
            />
          </View>
          <View style={styles.detailGrid}>
            <Info label="Access scope" value={ROLE_LABELS[role]} />
            <Info label="Audit status" value="Tracked" />
            <Info
              label="Source"
              value={demoMode ? "Validated mock dataset" : "Live Supabase"}
            />
          </View>
        </Card>
      ) : null}
    </>
  );
}

function Analytics({ screen }: { screen: string }) {
  const { demoMode } = useAuth();
  const live = useLiveAnalytics();
  const [tab, setTab] = useState("Overview");
  const series = ANALYTICS_SERIES[tab];
  const demoRecords: EvaluationRecord[] = series.map((item, index) => ({
    label: item.label,
    score: item.value,
    risk: index % 3 === 0 ? "high" : index % 2 === 0 ? "medium" : "low",
    classification: "Fictional validation data",
    category: tab,
    timestamp: new Date(Date.now() - index * 7 * 86_400_000).toISOString(),
  }));
  const demoFilters = useAnalyticsFilters(demoRecords);
  const filteredSeries = demoFilters.filtered.map((record) => ({ label: record.label, value: record.score }));
  const filteredHistogram = demoFilters.filtered.map((record) => ({ label: record.label, value: record.score, kind: "continuous" as const }));
  if (!demoMode) {
    if (live.loading)
      return (
        <PageState
          kind="loading"
          title="Loading analytics"
          message="Calculating persisted APMS evaluation data..."
        />
      );
    if (live.error)
      return (
        <PageState
          kind="error"
          title="Analytics unavailable"
          message={live.error}
          action={<Button label="Try again" onPress={live.refresh} />}
        />
      );
    if (!live.scoreSeries.length)
      return (
        <PageState
          kind="empty"
          title="No approved analysis available"
          message="Analytics will appear after approved evaluation records are persisted."
        />
      );
    return (
      <LiveAnalyticsContent
        screen={screen}
        metrics={live.metrics}
        records={live.records}
        truncated={live.truncated}
      />
    );
  }
  const average =
    filteredSeries.reduce((sum, item) => sum + item.value, 0) /
    Math.max(filteredSeries.length, 1);
  return (
    <>
      <Card>
        <View style={styles.toolbar}>
          <Tabs
            values={Object.keys(ANALYTICS_SERIES)}
            selected={tab}
            onSelect={setTab}
          />
        </View>
        <View style={styles.metrics}>
          <MetricCard label="Fictional Students" value="1,247" />
          <MetricCard
            label="Model Availability"
            value="Unavailable"
            tone="warning"
          />
          <MetricCard
            label="Series Average"
            value={`${average.toFixed(1)}%`}
            tone="success"
          />
        </View>
      </Card>
      {demoFilters.controls}
      <View style={styles.columns}>
        <DashboardChart title={`${tab} validation analysis`} description="Fictional validation series; this chart is not an AI output." data={filteredSeries} type={tab === "Risk Factors" ? "pie" : "line"} suffix="%" height={230} />
        {tab !== "Risk Factors" ? <DashboardChart title="Score histogram" description="Filtered fictional scores grouped into percentage bands." data={filteredHistogram} type="histogram" suffix="%" height={230} /> : null}
      </View>
    </>
  );
}

function LiveAnalyticsContent({
  screen,
  metrics,
  records,
  truncated,
}: {
  screen: string;
  metrics: LiveAnalytics["metrics"];
  records: EvaluationRecord[];
  truncated: boolean;
}) {
  const title =
    screen === "evaluation"
      ? "Rule-based performance evaluation"
      : "Persisted performance analytics";
  const filters = useAnalyticsFilters(records);
  const scoreByDay = new Map<string, { total: number; count: number }>();
  for (const record of filters.filtered) {
    if (!record.timestamp) continue;
    const day = record.timestamp.slice(0, 10);
    const current = scoreByDay.get(day) ?? { total: 0, count: 0 };
    current.total += record.score;
    current.count += 1;
    scoreByDay.set(day, current);
  }
  const filteredScoreSeries = [...scoreByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ label: new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: value.total / value.count, kind: "timeseries" as const, timestamp: day }));
  const riskCounts = new Map<string, number>([["Low", 0], ["Medium", 0], ["High", 0], ["Unclassified", 0]]);
  for (const record of filters.filtered) {
    const risk = record.risk === "low" ? "Low" : record.risk === "medium" ? "Medium" : record.risk === "high" ? "High" : "Unclassified";
    riskCounts.set(risk, (riskCounts.get(risk) ?? 0) + 1);
  }
  const filteredRiskSeries = [...riskCounts.entries()].map(([label, value]) => ({ label, value }));
  const filteredScoreDistribution = filters.filtered.map((record) => ({ label: record.label, value: record.score, kind: "continuous" as const }));
  const average = filters.filtered.length ? filters.filtered.reduce((sum, item) => sum + item.score, 0) / filters.filtered.length : null;
  const highRisk = filters.filtered.filter((item) => item.risk === "high").length;
  return (
    <>
      {filters.controls}
      {truncated ? <Card><Text style={styles.muted}>Charts and filtered metrics use the latest 5,000 evaluation records. The total evaluation count remains complete.</Text></Card> : null}
      <Card>
        <View style={styles.metrics}>
          <MetricCard label="Total evaluations" value={metrics.students} />
          <MetricCard label="Matching Records" value={filters.filtered.length.toLocaleString()} />
          <MetricCard
            label="AI Engine"
            value={metrics.model}
            tone="success"
          />
          <MetricCard label="Average Score" value={average == null ? "—" : `${average.toFixed(1)}%`} />
          <MetricCard label="High Risk" value={String(highRisk)} tone="danger" />
        </View>
      </Card>
      <View style={styles.columns}>
        <DashboardChart title={title} description="Daily average evaluation score from records matching the selected filters." data={filteredScoreSeries} type="line" suffix="%" height={230} />
        <DashboardChart title="Score histogram" description="Filtered continuous evaluation scores grouped into percentage bands." data={filteredScoreDistribution} type="histogram" suffix="%" height={230} />
        <DashboardChart title="Risk Distribution" description="Persisted low, medium, high, and unclassified risk levels." data={filteredRiskSeries} type="pie" height={230} />
      </View>
    </>
  );
}

export function Settings({
  role,
  screen,
  onMessage,
}: {
  role: Role;
  screen: string;
  onMessage: (message: string) => void;
}) {
  const { user, demoMode } = useAuth();
  const personal = screen === "settings";
  const notification = screen === "notifications";
  const tabs = personal
    ? ["Profile", "Password", "MFA", "Notifications"]
    : notification
      ? ["Delivery", "Rules"]
      : ["General", "Authentication", "Integrations"];
  const [tab, setTab] = useState(tabs[0]);
  const [first, setFirst] = useState(user?.firstName ?? "");
  const [last, setLast] = useState(user?.lastName ?? "");
  const [phone, setPhone] = useState("+63 917 555 0142");
  const [gradebookAutosave, setGradebookAutosave] = useState(true);
  const [systemName, setSystemName] = useState(SYSTEM_DEFAULTS.systemName);
  const [institutionName, setInstitutionName] = useState(
    SYSTEM_DEFAULTS.institutionName,
  );
  const [contactEmail, setContactEmail] = useState(
    SYSTEM_DEFAULTS.contactEmail,
  );
  const [timezone, setTimezone] = useState(SYSTEM_DEFAULTS.timezone);
  const [language, setLanguage] = useState(SYSTEM_DEFAULTS.language);
  const [sessionMinutes, setSessionMinutes] = useState(
    SYSTEM_DEFAULTS.sessionMinutes,
  );
  const [lockoutThreshold, setLockoutThreshold] = useState(
    SYSTEM_DEFAULTS.lockoutThreshold,
  );
  const [dataRetention, setDataRetention] = useState(
    SYSTEM_DEFAULTS.dataRetention,
  );
  const [provider, setProvider] = useState(SYSTEM_DEFAULTS.provider);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(true);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [pushAlerts, setPushAlerts] = useState(true);
  const [weeklyDigest, setWeeklyDigest] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void loadAutosavePreference(user?.id).then((enabled) => { if (active) setGradebookAutosave(enabled); }).catch(() => {});
    return () => { active = false; };
  }, [user?.id]);
  const [connection, setConnection] = useState(
    demoMode
      ? "Fictional validation mode; no external service connected"
      : "Not tested",
  );
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail);
  const payload: SettingsValues = {
    first,
    last,
    phone,
    autosaveEnabled: gradebookAutosave,
    sessionMinutes,
    systemName,
    institutionName,
    contactEmail,
    timezone,
    language,
    lockoutThreshold,
    dataRetention,
    provider,
    maintenanceMode,
    mfaRequired,
  };
  const save = async () => {
    if (!user) return;
    if (!first.trim() || !last.trim()) {
      onMessage("First and last name are required.");
      return;
    }
    if (
      !personal &&
      !notification &&
      (!systemName.trim() || !institutionName.trim() || !validEmail)
    ) {
      onMessage("Enter valid system, institution, and contact details.");
      return;
    }
    setSaving(true);
    try {
      onMessage(await saveSettings(screen, user, demoMode, payload));
    } catch (cause) {
      onMessage(
        getErrorMessage(cause, "Settings could not be saved."),
      );
    } finally {
      setSaving(false);
    }
  };
  const updatePassword = async () => {
    if (!user || newPassword !== confirmPassword) return;
    setSaving(true);
    try {
      onMessage(
        await changePassword(user, demoMode, currentPassword, newPassword),
      );
    } catch (cause) {
      onMessage(
        getErrorMessage(cause, "Password could not be changed."),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card style={styles.formCard}>
      <Tabs values={tabs} selected={tab} onSelect={setTab} />
      {personal && tab === "Profile" ? (
        <View style={styles.form}>
          <View style={styles.formGrid}>
            <Field label="First name" value={first} onChangeText={setFirst} />
            <Field label="Last name" value={last} onChangeText={setLast} />
            <Field label="Email" value={user?.email ?? ""} editable={false} />
            <Field
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
            />
            <Field label="Role" value={ROLE_LABELS[role]} editable={false} />
          </View>
          <ToggleRow
            title="Gradebook autosave"
            detail="Save score edits automatically across your gradebooks. You can also turn autosave off for an individual gradebook page."
            value={gradebookAutosave}
            onChange={setGradebookAutosave}
          />
          <SaveButton saving={saving} onPress={save} />
        </View>
      ) : null}
      {personal && tab === "Password" ? (
        <View style={styles.form}>
          <Field
            label="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
          />
          <View style={styles.formGrid}>
            <Field
              label="New password"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
            />
            <Field
              label="Confirm password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              error={
                confirmPassword && newPassword !== confirmPassword
                  ? "Passwords do not match."
                  : undefined
              }
            />
          </View>
          <SaveButton
            label="Update password"
            saving={saving}
            disabled={
              !currentPassword ||
              newPassword.length < 12 ||
              newPassword !== confirmPassword
            }
            onPress={updatePassword}
          />
        </View>
      ) : null}
      {personal && tab === "MFA" ? <MfaSettings onMessage={onMessage} /> : null}
      {personal && tab === "Notifications" ? (
        <View style={styles.form}>
          <ToggleRow
            title="Academic updates"
            detail="Grades, feedback, records, and evaluation status."
            value={emailAlerts}
            onChange={setEmailAlerts}
          />
          <ToggleRow
            title="Push alerts"
            detail="Immediate in-app alerts for urgent academic items."
            value={pushAlerts}
            onChange={setPushAlerts}
          />
          <ToggleRow
            title="Weekly digest"
            detail="A weekly summary of performance and pending tasks."
            value={weeklyDigest}
            onChange={setWeeklyDigest}
          />
          <SaveButton saving={saving} onPress={save} />
        </View>
      ) : null}
      {notification ? (
        <View style={styles.form}>
          {tab === "Delivery" ? (
            <>
              <ToggleRow
                title="Email delivery"
                detail="Send system announcements and backup status by email."
                value={emailAlerts}
                onChange={setEmailAlerts}
              />
              <ToggleRow
                title="In-app delivery"
                detail="Show alerts in the notification drawer."
                value={pushAlerts}
                onChange={setPushAlerts}
              />
            </>
          ) : (
            <>
              <ToggleRow
                title="High-risk alerts"
                detail="Notify staff when approved evaluations flag high risk."
                value={emailAlerts}
                onChange={setEmailAlerts}
              />
              <ToggleRow
                title="Weekly digest"
                detail="Combine non-urgent notices into a weekly message."
                value={weeklyDigest}
                onChange={setWeeklyDigest}
              />
            </>
          )}
          <SaveButton saving={saving} onPress={save} />
        </View>
      ) : null}
      {!personal && !notification ? (
        <View style={styles.form}>
          {tab === "General" ? (
            <>
              <Field
                label="System name"
                value={systemName}
                onChangeText={setSystemName}
              />
              <Field
                label="Institution name"
                value={institutionName}
                onChangeText={setInstitutionName}
              />
              <View style={styles.formGrid}>
                <Field
                  label="Contact email"
                  value={contactEmail}
                  onChangeText={setContactEmail}
                  keyboardType="email-address"
                  error={
                    contactEmail && !validEmail
                      ? "Enter a valid email address."
                      : undefined
                  }
                />
                <SelectField
                  label="Timezone"
                  value={timezone}
                  options={TIMEZONE_OPTIONS}
                  onChange={setTimezone}
                />
                <SelectField
                  label="Language"
                  value={language}
                  options={LANGUAGE_OPTIONS}
                  onChange={setLanguage}
                />
                <SelectField
                  label="Session duration"
                  value={sessionMinutes}
                  options={SESSION_OPTIONS}
                  onChange={setSessionMinutes}
                />
                <SelectField
                  label="Data retention"
                  value={dataRetention}
                  options={RETENTION_OPTIONS}
                  onChange={setDataRetention}
                />
              </View>
              <ToggleRow
                title="Maintenance mode"
                detail="Temporarily restrict student and faculty access."
                value={maintenanceMode}
                onChange={setMaintenanceMode}
              />
            </>
          ) : null}
          {tab === "Authentication" ? (
            <>
              <View style={styles.settingRow}>
                <View style={styles.settingCopy}>
                  <Text style={styles.settingTitle}>MFA enforcement</Text>
                  <Text style={styles.muted}>Authenticator-app MFA is managed and enforced per account from the personal MFA tab.</Text>
                </View>
                <Text style={styles.statusText}>Supabase Auth</Text>
              </View>
              <View style={styles.formGrid}>
                <SelectField
                  label="Authentication provider"
                  value={provider}
                  options={AUTH_PROVIDER_OPTIONS}
                  onChange={setProvider}
                />
                <SelectField
                  label="Lockout threshold"
                  value={lockoutThreshold}
                  options={LOCKOUT_OPTIONS}
                  onChange={setLockoutThreshold}
                />
              </View>
            </>
          ) : null}
          {tab === "Integrations" ? (
            <>
              <View style={styles.settingRow}>
                <View>
                  <Text style={styles.settingTitle}>Connection status</Text>
                  <Text style={styles.muted}>{connection}</Text>
                </View>
                <Button
                  label="Test connection"
                  variant="secondary"
                  onPress={() =>
                    setConnection(
                      demoMode
                        ? "Validation check completed; no external service was contacted."
                        : "Connection check is not configured for this provider.",
                    )
                  }
                />
              </View>
              <ToggleRow
                title="AI assistant"
                detail="Requires an approved model and authorized records provider."
                value={pushAlerts}
                onChange={setPushAlerts}
              />
              <ToggleRow
                title="Automated backups"
                detail="Requires a configured protected backup provider."
                value={emailAlerts}
                onChange={setEmailAlerts}
              />
            </>
          ) : null}
          <SaveButton
            saving={saving}
            disabled={
              !systemName.trim() || !institutionName.trim() || !validEmail
            }
            onPress={save}
          />
        </View>
      ) : null}
    </Card>
  );
}

function MfaSettings({ onMessage }: { onMessage: (message: string) => void }) {
  const { demoMode, mfaEnabled, enrollMfa, verifyMfa, disableMfa } = useAuth();
  const [enrollment, setEnrollment] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); const result = await enrollMfa(); setBusy(false);
    if (!result.ok) onMessage(result.message); else setEnrollment(result.enrollment);
  };
  const confirm = async () => {
    if (!enrollment) return;
    setBusy(true); const result = await verifyMfa(code, enrollment.factorId); setBusy(false);
    if (!result.ok) onMessage(result.message); else { setEnrollment(null); setCode(""); onMessage("MFA is enabled for this account."); }
  };
  const disable = async () => { setBusy(true); const result = await disableMfa(); setBusy(false); onMessage(result.message); };
  if (demoMode) return <Text style={styles.muted}>MFA setup is unavailable in development-only demo mode.</Text>;
  if (enrollment) return <View style={styles.form}>
    <Text style={styles.sectionTitle}>Scan this QR code</Text>
    <Text style={styles.muted}>Use Google Authenticator, Microsoft Authenticator, or another TOTP app.</Text>
    <View style={styles.qrCode} accessibilityLabel="MFA setup QR code">
      <SvgXml xml={enrollment.qrCode} width="180" height="180" />
    </View>
    <Text style={styles.muted}>Can’t scan? Enter this secret manually: {enrollment.secret}</Text>
    <Field label="Six-digit verification code" value={code} onChangeText={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad" />
    <View style={styles.actions}><Button label="Enable MFA" loading={busy} disabled={code.length !== 6} onPress={() => void confirm()} /><Button label="Cancel" variant="secondary" onPress={() => setEnrollment(null)} /></View>
  </View>;
  return <View style={styles.form}>
    <Text style={styles.sectionTitle}>Authenticator-app MFA</Text>
    <Text style={styles.muted}>{mfaEnabled ? "Enabled. A six-digit code is required at sign-in." : "Add an authenticator app as a second factor."}</Text>
    <Button label={mfaEnabled ? "Disable MFA" : "Set up MFA"} loading={busy} variant={mfaEnabled ? "secondary" : "primary"} onPress={() => void (mfaEnabled ? disable() : start())} />
  </View>;
}

function SaveButton({
  label = "Save changes",
  saving,
  disabled = false,
  onPress,
}: {
  label?: string;
  saving: boolean;
  disabled?: boolean;
  onPress: () => void | Promise<void>;
}) {
  return (
    <View style={styles.formActions}>
      <Button
        label={label}
        loading={saving}
        disabled={disabled}
        onPress={() => void onPress()}
      />
    </View>
  );
}
function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={[styles.toggle, value && styles.toggleOn]}
    >
      <View style={[styles.toggleKnob, value && styles.toggleKnobOn]} />
    </Pressable>
  );
}
function ToggleRow({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingCopy}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.muted}>{detail}</Text>
      </View>
      <Toggle value={value} onChange={onChange} />
    </View>
  );
}

function Security({ screen }: { screen: string }) {
  const values =
    screen === "info"
      ? [
          ["Application", "v1.0.0", "success"],
          ["Database", "PostgreSQL 15", "success"],
          ["Runtime", "Expo SDK 57", "info"],
          ["Environment", "Validation", "warning"],
        ]
      : [
          ["MFA Coverage", "100%", "success"],
          ["Active Sessions", "24", "info"],
          ["Failed Logins (24h)", "3", "warning"],
          ["Critical Alerts", "0", "success"],
        ];
  return (
    <View style={styles.metrics}>
      {values.map(([label, value, tone]) => (
        <MetricCard
          key={label}
          label={label}
          value={value}
          tone={tone as "success" | "info" | "warning"}
        />
      ))}
    </View>
  );
}

function Assistant({ role }: { role: Role }) {
  return (
    <Card style={styles.assistant}>
      <View style={styles.assistantIntro}>
        <AppIcon name="assistant" size={40} color={colors.brand} />
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          APMS AI Assistant unavailable
        </Text>
        <Text style={styles.muted}>
          No approved model, feature schema, or authorized query provider is
          configured for the {ROLE_LABELS[role]} role. No answer was generated.
        </Text>
      </View>
      <View style={styles.prompt}>
        <Field
          label="Question"
          value=""
          editable={false}
          placeholder="AI service unavailable"
        />
        <Button label="Send" disabled />
      </View>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 24 },
  columns: { flexDirection: "row", flexWrap: "wrap", gap: 24 },
  chartCard: { flex: 1, minWidth: 340 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  muted: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  tableGap: { marginTop: 16 },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    marginBottom: 16,
  },
  detailHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  detailGrid: {
    marginTop: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 36,
  },
  infoLabel: { color: colors.textMuted, fontSize: 11 },
  infoValue: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 13,
    marginTop: 4,
  },
  formCard: { maxWidth: 940 },
  form: { marginTop: 20, gap: 16 },
  formGrid: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 6,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
  statusText: { color: colors.success, fontSize: 12, fontWeight: "700" },
  settingRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  settingCopy: { flex: 1 },
  settingTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  qrCode: { width: 180, height: 180, alignSelf: "center", marginVertical: 16 },
  toggle: {
    width: 46,
    height: 26,
    borderRadius: 13,
    padding: 3,
    backgroundColor: "#D1D5DB",
  },
  toggleOn: { backgroundColor: colors.brand },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#FFF",
  },
  toggleKnobOn: { transform: [{ translateX: 20 }] },
  assistant: { minHeight: 560 },
  assistantIntro: { alignItems: "center", gap: 8, paddingVertical: 30 },
  messages: { flex: 1, gap: 8 },
  message: {
    alignSelf: "flex-end",
    maxWidth: "78%",
    padding: 12,
    borderRadius: radius.large,
    backgroundColor: "#F7ECE9",
  },
  assistantMessage: {
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceMuted,
  },
  messageText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  prompt: {
    gap: space.md,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 16,
    marginTop: 18,
  },
  overlay: {
    flex: 1,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#00000066",
  },
  eventDialog: {
    width: "100%",
    maxWidth: 860,
    maxHeight: "94%",
    gap: 14,
    padding: 22,
  },
  dialogTitle: { color: colors.text, fontSize: 19, fontWeight: "700" },
  eventDescription: { minHeight: 76, paddingTop: 10, textAlignVertical: "top" },
  eventFormGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  eventField: { flex: 1, minWidth: 220 },
  dialogActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  dialogError: { color: colors.danger, fontSize: 12 },
});
