import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { calculateAttendanceRate, type AttendanceStatus } from "@apms/domain";

import { useAuth } from "@/auth/AuthProvider";
import { AppIcon, type AppIconName } from "@/components/Icon";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  SearchFilter,
  SelectField,
  useToast,
} from "@/components/ui";
import { VisualizationPanel } from "@/components/charts/VisualizationPanel";
import {
  FACULTY_EVENTS,
  FACULTY_FEEDBACK_TEMPLATES,
  FACULTY_RECORDS,
  FACULTY_STUDENTS,
  type FacultyRecord,
  type FacultyStudent,
} from "@/data/mockFaculty";
import { changePassword, saveSettings } from "@/services/actions";
import { usePersistentDemoState } from "@/hooks/usePersistentDemoState";
import { colors } from "@/theme/tokens";

export function FacultyPortalContent({ screen }: { screen: string }) {
  if (screen === "overview") return <FacultyOverview />;
  if (screen === "students") return <FacultyStudents />;
  if (screen === "records" || screen === "classes" || screen === "gradebook") return <FacultyRecords />;
  if (screen === "attendance") return <FacultyAttendance />;
  if (screen === "risk") return <FacultyRisk />;
  if (screen === "criteria") return <FacultyCriteria />;
  if (screen === "evaluation") return <FacultyPrediction />;
  if (screen === "events") return <FacultyEvents />;
  if (screen === "feedback") return <FacultyFeedback />;
  if (screen === "analytics") return <FacultyAnalytics />;
  if (screen === "assistant") return <FacultyAssistant />;
  return <FacultySettings />;
}

type AttendanceRow = { id: string; name: string; status: AttendanceStatus };

function FacultyAttendance() {
  const initial = FACULTY_STUDENTS.map((student) => ({ id: student.id, name: student.name, status: 'present' as AttendanceStatus }));
  const [rows, setRows] = usePersistentDemoState<AttendanceRow[]>('apms.demo.attendance.v1', initial);
  const toast = useToast();
  const rate = calculateAttendanceRate(rows.map((row) => row.status));
  return (
    <View style={styles.screen}>
      <View style={styles.titleRow}>
        <View><Text style={styles.pageTitle}>Attendance Roll Call</Text><Text style={styles.pageSubtitle}>Database Systems · BSIT-3A · monitoring session</Text></View>
        <Badge tone="success">{rate}% attendance rate</Badge>
      </View>
      <Card>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Today&apos;s Session</Text>
          <Button label="Mark all present" variant="secondary" onPress={() => setRows((current) => current.map((row) => ({ ...row, status: 'present' })))} />
        </View>
        {rows.map((row) => (
          <View key={row.id} style={styles.attentionRow}>
            <Avatar name={row.name} />
            <View style={styles.flex}><Text style={styles.rowTitle}>{row.name}</Text><Text style={styles.rowMeta}>{row.id}</Text></View>
            <SelectField label="" value={row.status} options={(['present', 'absent', 'late', 'excused'] as AttendanceStatus[]).map((value) => ({ label: value[0].toUpperCase() + value.slice(1), value }))} onChange={(status) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, status: status as AttendanceStatus } : item))} containerStyle={styles.filterSelect} />
          </View>
        ))}
        <View style={styles.dialogActions}><Button label="Save attendance" onPress={() => toast.show('Attendance saved to the persistent validation dataset.')} /></View>
      </Card>
    </View>
  );
}

function FacultyRisk() {
  const rows = FACULTY_STUDENTS.filter((student) => student.score < 75).sort((a, b) => a.score - b.score);
  return (
    <View style={styles.screen}>
      <View><Text style={styles.pageTitle}>Students Requiring Attention</Text><Text style={styles.pageSubtitle}>Decision-support indicators only; faculty judgment remains authoritative.</Text></View>
      <Card>
        <DataTable columns={["Student", "Class", "Current Standing", "Risk", "Trend", "Attendance", "Key Factor"]} rows={rows.map((student) => [student.name, 'Database Systems · BSIT-3A', `${student.score}%`, student.score < 70 ? 'High' : 'Medium', student.score < 70 ? 'Declining' : 'Stable', student.score < 70 ? '72%' : '86%', student.score < 70 ? 'Low recent scores and absences' : 'Missing assessment'])} />
      </Card>
      <Card><Text style={styles.rowMeta}>Current standings are provisional APMS monitoring values and are not official SWU SIS grades.</Text></Card>
    </View>
  );
}

function FacultyCriteria() {
  const [quiz, setQuiz] = useState('40');
  const [project, setProject] = useState('30');
  const [exam, setExam] = useState('30');
  const total = Number(quiz) + Number(project) + Number(exam);
  return (
    <View style={styles.screen}>
      <View><Text style={styles.pageTitle}>Grading Criteria</Text><Text style={styles.pageSubtitle}>Configurable course-level weights for provisional standing.</Text></View>
      <Card>
        <View style={styles.formGrid}>
          <Field label="Quiz weight (%)" value={quiz} onChangeText={setQuiz} keyboardType="numeric" />
          <Field label="Project weight (%)" value={project} onChangeText={setProject} keyboardType="numeric" />
          <Field label="Examination weight (%)" value={exam} onChangeText={setExam} keyboardType="numeric" />
        </View>
        <Text style={[styles.rowMeta, { color: total === 100 ? colors.success : colors.danger }]}>Total: {total}% · {total === 100 ? 'Valid' : 'Weights must total 100%'}</Text>
        <Text style={styles.rowMeta}>Changes apply to monitoring calculations only and are recorded in the audit log.</Text>
      </Card>
    </View>
  );
}

function FacultyPrediction() {
  return (
    <View style={styles.screen}>
      <View><Text style={styles.pageTitle}>AI-Assisted At-Risk Prediction</Text><Text style={styles.pageSubtitle}>Synthetic logistic prototype · not institutionally validated</Text></View>
      <Card>
        <Badge tone="warning">Advisory only</Badge>
        <Text style={styles.cardTitle}>Prediction service is isolated from grade entry</Text>
        <Text style={styles.rowMeta}>The service analyzes current standing, recent score direction, attendance, and missing assessments. If it is unavailable, gradebook, attendance, and calculated standing remain accessible.</Text>
      </Card>
      <FacultyRisk />
    </View>
  );
}

function SectionHeading({
  icon,
  title,
  subtitle,
}: {
  icon: AppIconName;
  title: string;
  subtitle: string;
}) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.headingIcon}>
        <AppIcon name={icon} size={16} color="#FFF" />
      </View>
      <View>
        <Text style={styles.headingTitle}>{title}</Text>
        <Text style={styles.headingSubtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

function FacultyOverview() {
  const attention = FACULTY_STUDENTS.filter(
    (student) => student.remarks === "at risk" || student.remarks === "pending",
  ).slice(0, 3);
  const recent = FACULTY_STUDENTS.slice(0, 3);
  return (
    <View style={styles.screen}>
      <View style={styles.titleRow}>
        <View>
          <Text style={styles.pageTitle}>Faculty Overview</Text>
          <Text style={styles.pageSubtitle}>
            Quick overview — detailed charts and analytics available in the
            Analytics page
          </Text>
        </View>
        <Badge tone="warning">Recorded Monitoring</Badge>
      </View>
      <View style={styles.metricGrid}>
        {[
          ["students", "8", "Total Students", "+12%", "#2477F3"],
          ["error", "2", "At Risk", "Needs attention", "#F20F50"],
          ["success", "78%", "Avg Score", "+5.2%", "#00B66B"],
          ["metric", "0", "Pending", "To grade", "#FF6A00"],
          ["records", "7", "Class Records", "", colors.brand],
          ["students", "274", "Class Students", "", "#5E4DFF"],
          ["trend", "81%", "Class Avg Score", "", "#00A77C"],
          ["success", "85%", "Pass Rate", "", "#04B958"],
        ].map(([icon, value, label, delta, color]) => (
          <Card key={label} style={styles.metricCard}>
            <View style={[styles.metricIcon, { backgroundColor: color }]}>
              <AppIcon name={icon as AppIconName} size={16} color="#FFF" />
            </View>
            <Text style={styles.metricValue}>{value}</Text>
            <Text style={styles.metricLabel}>{label}</Text>
            {delta ? (
              <Text
                style={[
                  styles.metricDelta,
                  {
                    color:
                      delta === "Needs attention" || delta === "To grade"
                        ? "#F04444"
                        : "#00A968",
                  },
                ]}
              >
                {delta}
              </Text>
            ) : null}
          </Card>
        ))}
      </View>
      <Card>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Students Requiring Attention</Text>
          <Badge tone="danger">2 at risk</Badge>
        </View>
        {attention.map((student) => (
          <View key={student.id} style={styles.attentionRow}>
            <Avatar name={student.name} />
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{student.name}</Text>
              <Text style={styles.rowMeta}>
                {student.id} - Year {student.year.slice(1)} {student.section}
              </Text>
            </View>
            <View>
              <Text style={styles.score}>{student.score}%</Text>
              <Text style={styles.rowMeta}>Overall</Text>
            </View>
            <Badge tone={student.score < 70 ? "danger" : "warning"}>
              {student.score < 70 ? "High Risk" : "Medium Risk"}
            </Badge>
          </View>
        ))}
      </Card>
      <View style={styles.twoColumns}>
        <Card style={styles.half}>
          <Text style={styles.cardTitle}>Recent Assessments</Text>
          {recent.map((student, index) => (
            <View key={student.id} style={styles.compactRow}>
              <View>
                <Text style={styles.rowTitle}>{student.name}</Text>
                <Text style={styles.rowMeta}>
                  {
                    [
                      "Mathematics Quiz 1",
                      "Database Activity",
                      "Programming Exercise",
                    ][index]
                  }
                </Text>
              </View>
              <Text style={styles.score}>{student.score}/100</Text>
            </View>
          ))}
        </Card>
        <Card style={styles.half}>
          <Text style={styles.cardTitle}>AI Prediction Status</Text>
          <View style={styles.prediction}>
            <Text style={styles.predictionLabel}>
              Synthetic prototype available
            </Text>
            <Text style={styles.rowMeta}>
              Run advisory analysis from the AI Prediction page. The prototype
              is not institutionally validated and never replaces faculty judgment.
            </Text>
          </View>
        </Card>
      </View>
    </View>
  );
}

function FacultyStudents() {
  const [students, setStudents] = usePersistentDemoState<FacultyStudent[]>(
    "apms.demo.faculty.students.v1",
    FACULTY_STUDENTS,
  );
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("All");
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const filtered = students.filter(
    (student) =>
      `${student.id} ${student.name} ${student.email}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (year === "All" || student.year === year),
  );
  return (
    <View style={styles.screen}>
      <Card>
        <View style={styles.managementHeader}>
          <SectionHeading
            icon="students"
            title="Student Management"
            subtitle={`${students.length} total students`}
          />
          <Button label="＋ Add Student" onPress={() => setOpen(true)} />
        </View>
        <View style={styles.toolbar}>
          <SearchFilter
            value={query}
            onChange={setQuery}
            placeholder="Search by name, ID, or email..."
          />
          <SelectField
            label=""
            value={year}
            options={["All", "Y1", "Y2", "Y3"].map((value) => ({
              label: value === "All" ? "All years" : value,
              value,
            }))}
            onChange={setYear}
            containerStyle={styles.filterSelect}
          />
        </View>
        <DataTable
          columns={["ID", "Name", "Contact", "Year", "Remarks", "Status"]}
          rows={filtered.map((student) => [
            student.id,
            student.name,
            `${student.email}\n${student.phone}`,
            `${student.year} - ${student.section}`,
            student.remarks,
            student.status,
          ])}
        />
      </Card>
      <StudentDialog
        visible={open}
        onClose={() => setOpen(false)}
        onAdd={(student) => {
          setStudents((current) => [student, ...current]);
          setOpen(false);
          toast.show(
            "Student saved to the persistent fictional validation dataset.",
          );
        }}
      />
    </View>
  );
}

function StudentDialog({
  visible,
  onClose,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (student: FacultyStudent) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [year, setYear] = useState("Y1");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [section, setSection] = useState("");
  const valid =
    /^SWU-\d{3,}$/.test(id) &&
    name.trim().length > 2 &&
    /^\S+@\S+\.\S+$/.test(email) &&
    phone.trim().length >= 10 &&
    section.trim().length > 0;
  return (
    <Dialog
      visible={visible}
      title="Add New Student"
      subtitle="Enter the student's information to add them to the system."
      icon="students"
      onClose={onClose}
    >
      <View style={styles.formGrid}>
        <Field
          label="Student ID *"
          value={id}
          onChangeText={setId}
          placeholder="e.g., SWU-2024-001"
          containerStyle={styles.dialogField}
        />
        <Field
          label="Full Name *"
          value={name}
          onChangeText={setName}
          placeholder="e.g., Juan Dela Cruz"
          containerStyle={styles.dialogField}
        />
        <SelectField
          label="Year Level *"
          value={year}
          options={["Y1", "Y2", "Y3", "Y4"].map((value) => ({
            label: value,
            value,
          }))}
          onChange={setYear}
          containerStyle={styles.dialogField}
        />
        <Field
          label="Phone Number *"
          value={phone}
          onChangeText={setPhone}
          placeholder="e.g., +63 912 345 6789"
          containerStyle={styles.dialogField}
        />
        <Field
          label="Email Address *"
          value={email}
          onChangeText={setEmail}
          placeholder="student@university.edu"
          containerStyle={styles.dialogField}
        />
        <Field
          label="Student Section *"
          value={section}
          onChangeText={setSection}
          placeholder="e.g., Section A"
          containerStyle={styles.dialogField}
        />
        <SelectField
          label="Assign Teacher *"
          value="Myco Villomo"
          options={[{ label: "Myco Villomo", value: "Myco Villomo" }]}
          onChange={() => {}}
          containerStyle={styles.fullField}
        />
      </View>
      <View style={styles.dialogActions}>
        <Button
          label="Add Student"
          disabled={!valid}
          onPress={() =>
            onAdd({
              id,
              name: name.trim(),
              email,
              phone,
              year,
              section,
              remarks: "pending",
              status: "incomplete",
              score: 0,
            })
          }
        />
      </View>
    </Dialog>
  );
}

function FacultyRecords() {
  const [records, setRecords] = usePersistentDemoState<FacultyRecord[]>(
    "apms.demo.faculty.records.v1",
    FACULTY_RECORDS,
  );
  const [query, setQuery] = useState("");
  const [semester, setSemester] = useState("All");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<FacultyRecord | null>(null);
  const toast = useToast();
  const filtered = records.filter(
    (record) =>
      `${record.subject} ${record.section}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (semester === "All" || record.semester === semester),
  );
  const avg = Math.round(
    records.reduce((sum, item) => sum + item.average, 0) / records.length,
  );
  const passed = records.reduce((sum, item) => sum + item.passed, 0);
  const total = records.reduce((sum, item) => sum + item.students, 0);
  return (
    <View style={styles.screen}>
      <View>
        <Text accessibilityRole="header" style={styles.pageTitle}>
          Class Records
        </Text>
        <Text style={styles.pageSubtitle}>
          Manage fictional validation records in demo mode
        </Text>
      </View>
      <View style={styles.summaryGrid}>
        {[
          ["records", records.length, "Total Records"],
          ["students", total, "Total Students"],
          ["trend", `${avg}%`, "Avg Score"],
          [
            "success",
            `${Math.round((passed / Math.max(total, 1)) * 100)}%`,
            "Pass Rate",
          ],
        ].map(([icon, value, label]) => (
          <Card key={String(label)} style={styles.summaryCard}>
            <View style={styles.summaryIcon}>
              <AppIcon
                name={icon as AppIconName}
                size={17}
                color={colors.brand}
              />
            </View>
            <View>
              <Text style={styles.rowMeta}>{label}</Text>
              <Text style={styles.summaryValue}>{value}</Text>
            </View>
          </Card>
        ))}
      </View>
      <View style={styles.recordsToolbar}>
        <SearchFilter value={query} onChange={setQuery} />
        <View style={styles.pills}>
          {["All", "1st Semester", "2nd Semester"].map((item) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ selected: semester === item }}
              onPress={() => setSemester(item)}
              style={[styles.pill, semester === item && styles.pillActive]}
            >
              <Text
                style={[
                  styles.pillText,
                  semester === item && styles.pillTextActive,
                ]}
              >
                {item}
              </Text>
            </Pressable>
          ))}
        </View>
        <Button label="＋ Add Record" onPress={() => setOpen(true)} />
      </View>
      <Card>
        <DataTable
          columns={[
            "Subject",
            "Section",
            "Semester",
            "Students",
            "Passed / Failed",
            "Avg Score",
            "Date",
          ]}
          rows={filtered.map((record) => [
            record.subject,
            record.section,
            record.semester,
            String(record.students),
            `${record.passed} / ${record.failed}`,
            `${record.average}%`,
            record.date,
          ])}
          onRowPress={(row) =>
            setSelected(records.find((item) => item.subject === row[0]) ?? null)
          }
        />
      </Card>
      <RecordDialog
        visible={open || !!selected}
        record={selected}
        onClose={() => {
          setOpen(false);
          setSelected(null);
        }}
        onSave={(record) => {
          setRecords((current) =>
            selected
              ? current.map((item) =>
                  item.subject === selected.subject ? record : item,
                )
              : [record, ...current],
          );
          setOpen(false);
          setSelected(null);
          toast.show(
            selected
              ? "Class record updated in the persistent fictional validation dataset."
              : "Class record added to the persistent fictional validation dataset.",
          );
        }}
      />
    </View>
  );
}

function RecordDialog({
  visible,
  record,
  onClose,
  onSave,
}: {
  visible: boolean;
  record: FacultyRecord | null;
  onClose: () => void;
  onSave: (record: FacultyRecord) => void;
}) {
  const [subject, setSubject] = useState(record?.subject ?? "");
  const [section, setSection] = useState(record?.section ?? "");
  const [semester, setSemester] = useState(record?.semester ?? "1st Semester");
  const [students, setStudents] = useState(String(record?.students ?? ""));
  const [passed, setPassed] = useState(String(record?.passed ?? ""));
  const [failed, setFailed] = useState(String(record?.failed ?? ""));
  const [average, setAverage] = useState(String(record?.average ?? ""));
  useEffect(() => {
    if (!visible) return;
    setSubject(record?.subject ?? "");
    setSection(record?.section ?? "");
    setSemester(record?.semester ?? "1st Semester");
    setStudents(String(record?.students ?? ""));
    setPassed(String(record?.passed ?? ""));
    setFailed(String(record?.failed ?? ""));
    setAverage(String(record?.average ?? ""));
  }, [record, visible]);
  const numeric = [students, passed, failed, average].map(Number);
  const valid =
    subject.trim().length > 2 &&
    section.trim().length > 1 &&
    numeric.every(Number.isFinite) &&
    numeric[0] > 0 &&
    numeric[1] + numeric[2] === numeric[0] &&
    numeric[3] >= 0 &&
    numeric[3] <= 100;
  return (
    <Dialog
      visible={visible}
      title={record ? "Edit Class Record" : "Add Class Record"}
      subtitle={
        record
          ? `Students enrolled in ${record.subject}`
          : "Create a validated class performance record."
      }
      icon="records"
      onClose={onClose}
    >
      <View style={styles.formGrid}>
        <Field
          label="Subject *"
          value={subject}
          onChangeText={setSubject}
          placeholder="e.g. Data Structures"
          containerStyle={styles.dialogField}
        />
        <Field
          label="Class Section *"
          value={section}
          onChangeText={setSection}
          placeholder="e.g. BSCS-3A"
          containerStyle={styles.dialogField}
        />
        <SelectField
          label="Semester"
          value={semester}
          options={["1st Semester", "2nd Semester", "Summer"].map((value) => ({
            label: value,
            value,
          }))}
          onChange={setSemester}
          containerStyle={styles.dialogField}
        />
        <Field
          label="Academic Year"
          value="2025-2026"
          editable={false}
          containerStyle={styles.dialogField}
        />
        <Field
          label="Instructor"
          value="Myco Villomo"
          editable={false}
          containerStyle={styles.fullField}
        />
        <Field
          label="Total Students *"
          value={students}
          onChangeText={setStudents}
          keyboardType="number-pad"
          containerStyle={styles.thirdField}
        />
        <Field
          label="Passed"
          value={passed}
          onChangeText={setPassed}
          keyboardType="number-pad"
          containerStyle={styles.thirdField}
        />
        <Field
          label="Failed"
          value={failed}
          onChangeText={setFailed}
          keyboardType="number-pad"
          containerStyle={styles.thirdField}
        />
        <Field
          label="Avg Score"
          value={average}
          onChangeText={setAverage}
          keyboardType="number-pad"
          containerStyle={styles.thirdField}
        />
      </View>
      {!valid && subject ? (
        <Text style={styles.validation}>
          Passed plus failed must equal total students; average must be 0–100.
        </Text>
      ) : null}
      <View style={styles.dialogActions}>
        <Button
          label={record ? "Save Changes" : "Add Record"}
          disabled={!valid}
          onPress={() =>
            onSave({
              subject: subject.trim(),
              section: section.trim(),
              semester,
              students: numeric[0],
              passed: numeric[1],
              failed: numeric[2],
              average: numeric[3],
              lowest: record?.lowest ?? 0,
              highest: record?.highest ?? 100,
              date:
                record?.date ??
                new Date().toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }),
            })
          }
        />
      </View>
    </Dialog>
  );
}

function FacultyFeedback() {
  const [student, setStudent] = useState("");
  const [message, setMessage] = useState("");
  const [recent, setRecent] = usePersistentDemoState(
    "apms.demo.faculty.feedback.v1",
    [
      {
        name: "Maria Santos",
        message:
          "Outstanding work! Keep up the excellent academic performance...",
        when: "2 hours ago",
      },
      {
        name: "Carmen Lopez",
        message: "Your performance requires immediate attention...",
        when: "1 day ago",
      },
      {
        name: "Ana Reyes",
        message: "Great job! You are performing well...",
        when: "2 days ago",
      },
    ],
  );
  const toast = useToast();
  return (
    <View style={styles.screen}>
      <SectionHeading
        icon="feedback"
        title="Performance Feedback"
        subtitle="Prepare fictional feedback records for validation"
      />
      <View style={styles.feedbackGrid}>
        <Card style={styles.templates}>
          <Text style={styles.cardTitle}>Templates</Text>
          {FACULTY_FEEDBACK_TEMPLATES.map(([title, rule, copy]) => (
            <Pressable
              key={title}
              accessibilityRole="button"
              onPress={() => setMessage(copy)}
              style={styles.template}
            >
              <Text style={styles.rowTitle}>{title}</Text>
              <Text style={styles.rowMeta}>{rule}</Text>
            </Pressable>
          ))}
        </Card>
        <Card style={styles.feedbackForm}>
          <Text style={styles.cardTitle}>Create Feedback</Text>
          <SelectField
            label="Select Student"
            value={student}
            placeholder="Choose a student..."
            options={FACULTY_STUDENTS.map((item) => ({
              label: item.name,
              value: item.id,
            }))}
            onChange={setStudent}
          />
          <Field
            label="Feedback Message"
            value={message}
            onChangeText={setMessage}
            multiline
            placeholder="Type your feedback or use a template..."
            style={styles.textarea}
          />
          <View style={styles.sendRow}>
            <Button
              label="Save Demo Feedback"
              disabled={!student || !message.trim()}
              onPress={() => {
                const selected = FACULTY_STUDENTS.find(
                  (item) => item.id === student,
                )!;
                setRecent((current) => [
                  {
                    name: selected.name,
                    message: message.trim(),
                    when: "Just now",
                  },
                  ...current,
                ]);
                setMessage("");
                toast.show(
                  "Feedback saved to the persistent fictional validation dataset; no notification was sent.",
                );
              }}
            />
            <Button
              label="Clear"
              variant="secondary"
              onPress={() => setMessage("")}
            />
          </View>
        </Card>
      </View>
      <Card>
        <Text style={styles.cardTitle}>Recent Feedback</Text>
        {recent.map((item, index) => (
          <View key={`${item.name}-${index}`} style={styles.compactRow}>
            <View style={styles.recentIcon}>
              <AppIcon
                name="feedback"
                size={14}
                color={index === 1 ? "#F59E0B" : "#2477F3"}
              />
            </View>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{item.name}</Text>
              <Text style={styles.rowMeta}>{item.message}</Text>
            </View>
            <Text style={styles.rowMeta}>{item.when}</Text>
          </View>
        ))}
      </Card>
    </View>
  );
}

function FacultyAnalytics() {
  const [section, setSection] = useState("All");
  const [subject, setSubject] = useState("All");
  const [semester, setSemester] = useState("All");
  const records = FACULTY_RECORDS.filter(
    (item) =>
      (section === "All" || item.section === section) &&
      (subject === "All" || item.subject === subject) &&
      (semester === "All" || item.semester === semester),
  );
  const average = Math.round(
    records.reduce((sum, item) => sum + item.average, 0) /
      Math.max(records.length, 1),
  );
  const pass = Math.round(
    (records.reduce((sum, item) => sum + item.passed, 0) /
      Math.max(
        records.reduce((sum, item) => sum + item.students, 0),
        1,
      )) *
      100,
  );
  return (
    <View style={styles.screen}>
      <SectionHeading
        icon="analytics"
        title="Analytics & Insights"
        subtitle="Recorded performance analytics from fictional validation data"
      />
      <Card>
        <Text style={styles.filterTitle}>Score & Grade Filters</Text>
        <View style={styles.analyticsFilters}>
          <SelectField
            label="Section"
            value={section}
            options={[
              "All",
              ...new Set(FACULTY_RECORDS.map((item) => item.section)),
            ].map((value) => ({ label: value, value }))}
            onChange={setSection}
          />
          <SelectField
            label="Subject"
            value={subject}
            options={[
              "All",
              ...new Set(FACULTY_RECORDS.map((item) => item.subject)),
            ].map((value) => ({ label: value, value }))}
            onChange={setSubject}
          />
          <SelectField
            label="Semester"
            value={semester}
            options={["All", "1st Semester", "2nd Semester"].map((value) => ({
              label: value,
              value,
            }))}
            onChange={setSemester}
          />
        </View>
      </Card>
      <View style={styles.metricGrid}>
        {[
          ["students", `${average}%`, "Class Average", "+5.2%"],
          ["success", `${pass}%`, "Pass Rate", "Above target"],
          [
            "records",
            String(FACULTY_STUDENTS.filter((item) => item.score < 70).length),
            "At Risk",
            "Needs attention",
          ],
          ["chart", "83%", "Attendance", "Good standing"],
        ].map(([icon, value, label, delta]) => (
          <Card key={label} style={styles.metricCard}>
            <View style={styles.summaryIcon}>
              <AppIcon
                name={icon as AppIconName}
                size={16}
                color={colors.brand}
              />
            </View>
            <Text style={styles.metricValue}>{value}</Text>
            <Text style={styles.metricLabel}>{label}</Text>
            <Text style={styles.metricDelta}>{delta}</Text>
          </Card>
        ))}
      </View>
      <View style={styles.twoColumns}>
        <VisualizationPanel title="Performance Trends" description="Filtered class average by reporting date." data={[...records].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((item) => ({ label: item.date.split(",")[0], value: item.average, kind: "timeseries" as const, timestamp: new Date(item.date).toISOString() }))} type="line" suffix="%" height={185} />
        <VisualizationPanel title="Grade Distribution" description="Filtered classes grouped by their average score." data={[{ label: "A · 90+", value: records.filter((item) => item.average >= 90).length }, { label: "B · 80–89", value: records.filter((item) => item.average >= 80 && item.average < 90).length }, { label: "C · 70–79", value: records.filter((item) => item.average >= 70 && item.average < 80).length }, { label: "D · 60–69", value: records.filter((item) => item.average >= 60 && item.average < 70).length }, { label: "F · <60", value: records.filter((item) => item.average < 60).length }]} type="pie" height={185} />
      </View>
      <View style={styles.twoColumns}>
        <Card style={styles.half}>
          <Text style={styles.cardTitle}>Category Averages</Text>
          {[
            ["Attendance", 83],
            ["Assignments", 76],
            ["Examinations", 79],
            ["Participation", 71],
          ].map(([label, value]) => (
            <View key={String(label)} style={styles.progressRow}>
              <View style={styles.progressLabel}>
                <Text style={styles.rowMeta}>{label}</Text>
                <Text style={styles.rowMeta}>{value}%</Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${value}%` as never }]} />
              </View>
            </View>
          ))}
        </Card>
        <Card style={styles.half}>
          <Text style={styles.cardTitle}>
            Class Records — Pass vs Fail by Subject
          </Text>
          {records.slice(0, 4).map((item) => (
            <View key={item.subject} style={styles.compactRow}>
              <Text style={styles.rowTitle}>{item.subject}</Text>
              <Text style={styles.passText}>{item.passed} passed</Text>
              <Text style={styles.failText}>{item.failed} failed</Text>
            </View>
          ))}
        </Card>
      </View>
    </View>
  );
}

function FacultyEvents() {
  const [events, setEvents] = usePersistentDemoState(
    "apms.demo.faculty.events.v1",
    FACULTY_EVENTS,
  );
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <View style={styles.screen}>
      <View style={styles.managementHeader}>
        <SectionHeading
          icon="events"
          title="Events"
          subtitle="Manage academic schedules and activities"
        />
        <Button label="＋ Add Event" onPress={() => setOpen(true)} />
      </View>
      <View style={styles.eventGrid}>
        {events.map((event) => (
          <Card key={event.title} style={styles.eventCard}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>{event.title}</Text>
              <Badge tone="info">{event.type}</Badge>
            </View>
            <Text style={styles.rowMeta}>
              📅 {event.date}　⏱ {event.time}
            </Text>
            <Text style={styles.rowMeta}>
              ⌖ {event.location}　♙ {event.attendees} attendees
            </Text>
          </Card>
        ))}
      </View>
      <EventDialog
        visible={open}
        onClose={() => setOpen(false)}
        onCreate={(event) => {
          setEvents((current) => [event, ...current]);
          setOpen(false);
          toast.show(
            "Event saved to the persistent fictional validation dataset.",
          );
        }}
      />
    </View>
  );
}

function EventDialog({
  visible,
  onClose,
  onCreate,
}: {
  visible: boolean;
  onClose: () => void;
  onCreate: (event: (typeof FACULTY_EVENTS)[number]) => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  const [attendees, setAttendees] = useState("");
  const [type, setType] = useState("Assessment");
  const [description, setDescription] = useState("");
  const valid =
    title.trim().length > 2 &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    time.trim() &&
    location.trim() &&
    Number(attendees) > 0;
  return (
    <Dialog
      visible={visible}
      title="Create New Event"
      subtitle="Fill in the event details to schedule a new event."
      icon="events"
      onClose={onClose}
    >
      <View style={styles.formGrid}>
        <Field
          label="Event Title *"
          value={title}
          onChangeText={setTitle}
          placeholder="e.g., Midterm Examination Period"
          containerStyle={styles.fullField}
        />
        <Field
          label="Date *"
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          containerStyle={styles.dialogField}
        />
        <Field
          label="Time *"
          value={time}
          onChangeText={setTime}
          placeholder="e.g., 8:00 AM - 5:00 PM"
          containerStyle={styles.dialogField}
        />
        <Field
          label="Location *"
          value={location}
          onChangeText={setLocation}
          placeholder="e.g., Conference Room A"
          containerStyle={styles.dialogField}
        />
        <Field
          label="Expected Attendees *"
          value={attendees}
          onChangeText={setAttendees}
          keyboardType="number-pad"
          placeholder="e.g., 50"
          containerStyle={styles.dialogField}
        />
        <SelectField
          label="Select Event *"
          value={type}
          options={["Assessment", "Meeting", "Seminar", "Training"].map(
            (value) => ({ label: value, value }),
          )}
          onChange={setType}
          containerStyle={styles.dialogField}
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          multiline
          placeholder="Enter event description (optional)"
          containerStyle={styles.fullField}
          style={styles.textarea}
        />
      </View>
      <View style={styles.dialogActions}>
        <Button
          label="Create Event"
          disabled={!valid}
          onPress={() =>
            onCreate({
              title: title.trim(),
              date: new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              }),
              time,
              location,
              attendees: Number(attendees),
              type,
            })
          }
        />
      </View>
    </Dialog>
  );
}

function FacultySettings() {
  const { user, demoMode } = useAuth();
  const [tab, setTab] = useState("Profile");
  const [first, setFirst] = useState("Myco Angel Lou");
  const [last, setLast] = useState("Villomo");
  const [phone, setPhone] = useState("+63 912 345 6789");
  const [bio, setBio] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      toast.show(
        await saveSettings("settings", user, demoMode, {
          first,
          last,
          phone,
          sessionMinutes: "60",
          systemName: "APMS",
          institutionName: "Southwestern University PHINMA",
          contactEmail: user.email,
          timezone: "Asia/Manila",
          language: "en",
          lockoutThreshold: "5",
          dataRetention: "2 years",
          provider: "Supabase Auth",
          maintenanceMode: false,
          mfaRequired: true,
        }),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <View style={styles.screen}>
      <SectionHeading
        icon="settings"
        title="Settings"
        subtitle="Manage account & preferences"
      />
      <View style={styles.settingsGrid}>
        <Card style={styles.settingsNav}>
          {[
            "Profile",
            "Security",
            "Notifications",
            "Privacy",
            "Data & Backup",
            "Appearance",
            "System",
          ].map((item) => (
            <Pressable
              key={item}
              onPress={() => setTab(item)}
              style={[
                styles.settingsItem,
                tab === item && styles.settingsActive,
              ]}
            >
              <AppIcon
                name={
                  item === "Security"
                    ? "security"
                    : item === "Notifications"
                      ? "notifications"
                      : "settings"
                }
                size={15}
                color={tab === item ? "#FFF" : colors.textMuted}
              />
              <Text
                style={[
                  styles.settingsText,
                  tab === item && styles.settingsTextActive,
                ]}
              >
                {item}
              </Text>
            </Pressable>
          ))}
        </Card>
        <Card style={styles.settingsForm}>
          {tab === "Profile" ? (
            <>
              <Text style={styles.cardTitle}>Profile Information</Text>
              <View style={styles.photoRow}>
                <Avatar name="Myco Villomo" large />
                <Button
                  label="⇧ Change Photo"
                  variant="secondary"
                  onPress={() =>
                    toast.show("Photo chooser is ready for an uploaded image.")
                  }
                />
              </View>
              <View style={styles.formGrid}>
                <Field
                  label="First Name"
                  value={first}
                  onChangeText={setFirst}
                  containerStyle={styles.dialogField}
                />
                <Field
                  label="Last Name"
                  value={last}
                  onChangeText={setLast}
                  containerStyle={styles.dialogField}
                />
                <Field
                  label="Email"
                  value="myco.villomo@university.edu"
                  editable={false}
                  containerStyle={styles.dialogField}
                />
                <Field
                  label="Phone"
                  value={phone}
                  onChangeText={setPhone}
                  containerStyle={styles.dialogField}
                />
                <Field
                  label="Role"
                  value="Faculty"
                  editable={false}
                  containerStyle={styles.dialogField}
                />
                <Field
                  label="Department"
                  value="Administration"
                  editable={false}
                  containerStyle={styles.dialogField}
                />
                <Field
                  label="Bio"
                  value={bio}
                  onChangeText={setBio}
                  multiline
                  containerStyle={styles.fullField}
                  style={styles.textarea}
                />
              </View>
              <View style={styles.dialogActions}>
                <Button
                  label="Cancel"
                  variant="secondary"
                  onPress={() => {
                    setFirst("Myco Angel Lou");
                    setLast("Villomo");
                  }}
                />
                <Button
                  label="▣ Save"
                  loading={saving}
                  disabled={!first.trim() || !last.trim()}
                  onPress={() => void save()}
                />
              </View>
            </>
          ) : tab === "Security" ? (
            <>
              <Text style={styles.cardTitle}>Change Password</Text>
              <Field
                label="Current Password"
                value={current}
                onChangeText={setCurrent}
                secureTextEntry
              />
              <Field
                label="New Password"
                value={next}
                onChangeText={setNext}
                secureTextEntry
              />
              <Field
                label="Confirm Password"
                value={confirm}
                onChangeText={setConfirm}
                secureTextEntry
              />
              <View style={styles.dialogActions}>
                <Button
                  label="Update Password"
                  disabled={next.length < 8 || next !== confirm || !current}
                  onPress={() => {
                    if (!user) return;
                    setSaving(true);
                    void changePassword(user, demoMode, current, next)
                      .then(toast.show)
                      .finally(() => setSaving(false));
                  }}
                />
              </View>
            </>
          ) : (
            <View style={styles.emptyPanel}>
              <Text style={styles.cardTitle}>{tab}</Text>
              <Text style={styles.pageSubtitle}>
                These preferences are stored in your account settings.
              </Text>
              <Button
                label="Save Preferences"
                onPress={() => toast.show(`${tab} preferences saved.`)}
              />
            </View>
          )}
        </Card>
      </View>
    </View>
  );
}

function FacultyAssistant() {
  return (
    <View style={styles.assistant}>
      <View style={styles.assistantIcon}>
        <AppIcon name="assistant" size={32} color="#FFF" />
      </View>
      <Text accessibilityRole="header" style={styles.assistantTitle}>
        APMS AI Assistant unavailable
      </Text>
      <Text style={styles.assistantCopy}>
        Unavailable: no approved model artifact, validated feature schema, or
        authorized query provider is configured. APMS will not fabricate an
        answer.
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.aiStatus}>
        Advisory AI unavailable
      </Text>
      <View style={styles.askRow}>
        <Field
          accessibilityLabel="Assistant question"
          label="Question"
          value=""
          editable={false}
          placeholder="AI service unavailable"
          containerStyle={styles.askField}
        />
        <Button label="Send question" disabled />
      </View>
    </View>
  );
}

function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <View style={[styles.avatar, large && styles.avatarLarge]}>
      <Text style={[styles.avatarText, large && styles.avatarTextLarge]}>
        {name
          .split(" ")
          .map((part) => part[0])
          .slice(0, 2)
          .join("")}
      </Text>
    </View>
  );
}
function Dialog({
  visible,
  title,
  subtitle,
  icon,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  subtitle: string;
  icon: AppIconName;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Card style={styles.dialog}>
          <View style={styles.dialogHead}>
            <View style={styles.dialogTitleRow}>
              <View style={styles.headingIcon}>
                <AppIcon name={icon} size={16} color="#FFF" />
              </View>
              <Text style={styles.dialogTitle}>{title}</Text>
            </View>
            <Pressable accessibilityLabel="Close dialog" onPress={onClose}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.dialogSubtitle}>{subtitle}</Text>
          <View style={styles.divider} />
          {children}
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 16 },
  flex: { flex: 1 },
  pageTitle: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "500",
    color: colors.text,
  },
  pageSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 3 },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionHeading: { flexDirection: "row", alignItems: "center", gap: 8 },
  headingIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "#873625",
    alignItems: "center",
    justifyContent: "center",
  },
  headingTitle: { fontSize: 16, fontWeight: "500", color: colors.text },
  headingSubtitle: { fontSize: 11, color: "#99A1AF", marginTop: 2 },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  metricCard: { minWidth: 185, flex: 1, padding: 16, gap: 3 },
  metricIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  metricValue: { fontSize: 24, color: colors.text },
  metricLabel: { fontSize: 11, color: "#99A1AF" },
  metricDelta: { fontSize: 10, color: "#00A968" },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: {
    fontSize: 14,
    fontWeight: "500",
    color: "#1E2939",
    marginBottom: 10,
  },
  attentionRow: {
    minHeight: 61,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#F9FAFB",
    marginTop: 8,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: "#8A3727",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLarge: { width: 56, height: 56, borderRadius: 15 },
  avatarText: { fontSize: 9, color: "#FFF" },
  avatarTextLarge: { fontSize: 20 },
  rowTitle: { fontSize: 12, color: "#1E2939" },
  rowMeta: { fontSize: 10, color: "#99A1AF", marginTop: 2 },
  score: { fontSize: 14, color: "#1E2939" },
  twoColumns: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  half: { flex: 1, minWidth: 260 },
  compactRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    justifyContent: "space-between",
    paddingHorizontal: 10,
    borderRadius: 9,
    backgroundColor: "#F9FAFB",
    marginTop: 7,
  },
  prediction: { backgroundColor: "#EEF2FF", borderRadius: 10, padding: 14 },
  predictionLabel: { fontSize: 11, color: "#155DFC" },
  predictionValue: { fontSize: 22, color: "#173EA5", marginVertical: 3 },
  managementHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "space-between",
    alignItems: "center",
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "flex-end",
    marginVertical: 18,
  },
  filterSelect: { width: 120 },
  formGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  dialogField: { width: "48%", flexGrow: 1 },
  fullField: { width: "100%" },
  thirdField: { width: "30%", flexGrow: 1 },
  dialogActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "flex-end",
    marginTop: 18,
  },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  summaryCard: {
    flex: 1,
    minWidth: 185,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  summaryIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#F8ECE9",
    alignItems: "center",
    justifyContent: "center",
  },
  summaryValue: { fontSize: 17, color: colors.text, marginTop: 2 },
  recordsToolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
  },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 4, flex: 1 },
  pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  pillActive: {
    backgroundColor: "#FFF",
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillText: { fontSize: 11, color: colors.textMuted },
  pillTextActive: { color: colors.brand, fontWeight: "600" },
  validation: { fontSize: 11, color: colors.danger, marginTop: 10 },
  feedbackGrid: { flexDirection: "row", gap: 14, flexWrap: "wrap" },
  templates: { width: 260, maxWidth: "100%" },
  feedbackForm: { flex: 1, minWidth: 260, gap: 12 },
  template: {
    backgroundColor: "#F9FAFB",
    borderRadius: 9,
    padding: 10,
    marginTop: 6,
  },
  textarea: { minHeight: 64, textAlignVertical: "top", paddingTop: 9 },
  sendRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  recentIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  analyticsFilters: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  filterTitle: { fontSize: 11, color: colors.textMuted, marginBottom: 10 },
  progressRow: { marginTop: 10 },
  progressLabel: { flexDirection: "row", justifyContent: "space-between" },
  track: {
    height: 7,
    borderRadius: 4,
    backgroundColor: "#F0F1F3",
    marginTop: 5,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 4, backgroundColor: colors.brand },
  passText: { fontSize: 10, color: colors.success },
  failText: { fontSize: 10, color: colors.danger },
  chartLegend: { fontSize: 10, textAlign: "center", color: colors.textMuted },
  eventGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  eventCard: { flex: 1, minWidth: 260, gap: 8 },
  settingsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
    alignItems: "flex-start",
  },
  settingsNav: { width: 192, maxWidth: "100%", padding: 10 },
  settingsItem: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  settingsActive: { backgroundColor: "#873625" },
  settingsText: { fontSize: 12, color: colors.text },
  settingsTextActive: { color: "#FFF" },
  settingsForm: { flex: 1, minWidth: 260, gap: 12 },
  photoRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  emptyPanel: { gap: 14 },
  assistant: {
    minHeight: 480,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  assistantIcon: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: "#7F2E1D",
    alignItems: "center",
    justifyContent: "center",
  },
  assistantTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: "#1E2939",
    marginTop: 16,
  },
  assistantCopy: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    color: colors.textMuted,
    marginTop: 8,
  },
  promptGrid: {
    width: "100%",
    maxWidth: 520,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 26,
  },
  prompt: {
    width: "48%",
    flexGrow: 1,
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    gap: 10,
  },
  aiStatus: { fontSize: 11, color: "#99A1AF", marginTop: 18 },
  chat: { width: "100%", maxWidth: 600, marginTop: 18 },
  question: {
    alignSelf: "flex-end",
    backgroundColor: "#F4E8E5",
    padding: 9,
    borderRadius: 9,
    fontSize: 12,
    color: colors.text,
    marginBottom: 6,
  },
  answer: {
    alignSelf: "flex-start",
    backgroundColor: "#F9FAFB",
    padding: 9,
    borderRadius: 9,
    fontSize: 12,
    color: colors.text,
    marginBottom: 6,
  },
  askRow: {
    width: "100%",
    maxWidth: 600,
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
    marginTop: 20,
  },
  askField: { flex: 1 },
  overlay: {
    flex: 1,
    backgroundColor: "#000000B3",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  dialog: { width: "100%", maxWidth: 670, padding: 24 },
  dialogHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  dialogTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dialogTitle: { fontSize: 20, fontWeight: "500", color: colors.text },
  dialogSubtitle: { fontSize: 13, color: colors.textMuted, marginTop: 6 },
  close: { fontSize: 27, color: colors.text },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
});
