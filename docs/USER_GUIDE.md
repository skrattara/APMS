# APMS User Guide

Welcome to the Academic Performance Monitoring System (APMS). This guide outlines key workflows for Faculty, Academic Administrators, and System Administrators.

---

## 1. Faculty Workflows

Faculty members can manage their entire teaching and monitoring workflow autonomously:

### Creating Classes
1. Navigate to **My Classes** in the sidebar.
2. Click **Create Class**.
3. Select your assigned department subject, active academic term, and specify the section (e.g., `BSIT-3A`).
4. Click **Create and assign class**. APMS automatically configures the standardized SWUNEXT grading criteria (Start of Class 5%, Let's Practice 35%, Reflection 15%, Wrap-Up Quiz 15%, Final Project 30%).

### Requesting New Subjects
If a subject you teach is not listed:
1. Click **Request Subject** from the My Classes screen.
2. Enter the subject code (e.g. `IT311`), title, units, and a brief rationale (minimum 10 characters).
3. Track the status of your request (**Pending**, **Approved**, **Rejected**) under the *My Subject Requests* section.

### Managing Student Rosters & CSV Import
1. Navigate to **Students**.
2. To add a student manually, click **Add Student** and fill in their institutional ID, name, email, year level, and section.
3. To batch-import students, click **Import CSV**:
   - Download the official sample CSV template via **Download Template**.
   - Choose your CSV file. APMS performs client-side validation, duplicate detection, and error reporting before import.
   - Click **Confirm import** to enroll valid rows.

### Entering SWUNEXT Grades
1. Navigate to **Gradebook**.
2. Select your assessment or click **Create Assessment** with the corresponding SWUNEXT component and module number.
3. Enter scores for students on the roster. Blank scores are excluded from provisional calculations until recorded.
4. Click **Save all scores**.

### Roll Call Attendance
1. Navigate to **Attendance**.
2. Create a dated session or select an existing one.
3. Mark attendance status (`Present`, `Absent`, `Late`, `Excused`) and save.

### At-Risk Monitoring & Feedback
1. Navigate to **At-Risk Students** to view real-time provisional standings, mastery progress, attendance rates, and predictive risk levels.
2. Navigate to **Performance Feedback** to generate customized performance letters and save drafts for communication.
3. Open **Overview** or **Analytics & Reports** to review live score trends, score distributions, risk groups, and pass-rule summaries. Use the search, class/category, risk, classification, period, and minimum-score filters to narrow the displayed summaries. Hover over a chart point, bar, histogram band, or pie slice for its value and category details.
4. Click **Export PNG** on any chart to save or share its current filtered view. On **Analytics & Reports**, click **Export CSV** to download the class monitoring report.

---

## 2. Academic Admin Workflows

Academic Administrators maintain departmental oversight and subject management:

1. **Subjects Management**: Navigate to **Subjects** to create, edit, activate, or deactivate department subjects.
2. **Reviewing Subject Requests**: Review pending faculty requests, view faculty rationales, and approve (auto-activates the subject) or reject (requires a review note).
3. **Department Monitoring**: Inspect live aggregated class averages, student performance, at-risk alerts, and filter dashboard charts by class, risk, classification, period, and minimum score. Export charts as PNG or department-wide records as CSV.
4. **Grading Criteria Oversight**: Inspect and save versioned grading criteria for any class in the department.

---

## 3. System Admin Workflows

System Administrators maintain technical infrastructure and security:

1. **User Management**: Provision and manage accounts across the institution.
2. **Roles & Security**: Assign department scopes and verify role permissions.
3. **Audit & System Logs**: Inspect structured security, access, and academic mutation logs.
4. **Backup & Status**: Monitor database backup operations and system health.
5. **Dashboard charts**: Filter account distributions by role and status, inspect audit activity, and export charts as PNG.

