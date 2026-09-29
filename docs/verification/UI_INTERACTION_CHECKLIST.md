# UI Interaction Verification Checklist

Status is conservative: **Complete** requires a real backend/Auth operation, server permission enforcement, pending/error handling, refresh persistence, and meaningful automated verification. “Partial” or “Blocked” rows are not accepted as done.

| Role | Route | Screen | Control | Intended behavior | Backend operation | Permission | Status | Test coverage | Verification |
|---|---|---|---|---|---|---|---|---|---|
| Public | `/` | Login | Role/email/password/Sign In | Create correct-role session | Supabase Auth + profile/role read | active account + selected role | Complete | auth E2E | 10-test E2E run passed; E2E still uses demo accounts |
| Public | `/` | Login | Forgot password | Send reset instructions safely | `resetPasswordForEmail` | public/rate limited by Auth | Complete | missing E2E | Typecheck passed |
| Public | `/` | Login | Sign In with Google | Complete configured OAuth flow | Supabase OAuth + Expo WebBrowser | configured provider + active profile | Complete | missing E2E | Typecheck passed; provider configuration required |
| Public | `/` | Login | Remember me | Persist/remove saved email preference | local device storage | local user | Complete | missing E2E | Typecheck passed |
| All | protected routes | Guard | Direct URL | Reject unauthenticated/cross-role/unknown views | session + role navigation allowlist | matching role | Complete | auth E2E | Typecheck passed |
| All | all portal routes | Shell | Sidebar/mobile menu | Navigate permitted pages with active state | router | matching role | Complete | auth/student E2E | Existing E2E |
| All | all portal routes | Shell | Search pages | Find and navigate permitted pages | role navigation index | matching role | Complete | missing E2E | Typecheck passed |
| All | all portal routes | Shell | Notification bell/items | Load unread/list and open related screen | select/update `notifications` | recipient RLS | Complete | missing E2E | Typecheck/schema passed |
| All | all portal routes | Shell | Mark one/all read | Persist read timestamps | update `notifications.read_at` | recipient RLS | Complete | missing E2E | Typecheck/schema passed |
| All | all portal routes | Shell | Profile/sign out | Open settings/end session | router/Auth sign out | own session | Complete | student E2E | Existing E2E |
| All | table routes | List | Search | Search entire authorized result set | server query | route read permission | Partial | faculty demo E2E | Currently loaded rows only |
| All | table routes | List | Status tabs | Combine status with search/sort/page | server query | route read permission | Not implemented | none | Tab is visual only |
| All | table routes | List | Sort headers | Stable server sort | server query | route read permission | Not implemented | none | No control |
| All | table routes | List | Pagination | Stable server page/count | server query/count | route read permission | Not implemented | none | No control |
| All | table routes | Row | Detail/action menu | Load identified record and permitted actions | record query/mutations | per-record RLS | Partial | none | Generic string-only detail |
| All | settings | Profile | Save | Validate and persist own profile | update `profiles` | self-update RLS | Complete | none | Typecheck/schema passed |
| All | settings | Password | Update password | Reauthenticate and change password | Auth sign-in + update user | own account | Complete | none | Typecheck passed |
| All | settings | Preferences | Save notifications | Persist all displayed preferences | `notification_preferences` | self RLS | Partial | none | Only one fixed event preference saved |
| Student | overview | Dashboard | Metrics/charts/profile | Show own persisted aggregates | scoped academic queries | self read | Partial | student demo E2E | Metrics real; charts/profile not |
| Student | grades | Grades | List | Read own approved grades | select assessment results | self enrollment RLS | Complete | demo E2E | Production query exists |
| Student | grades | Grades | Submit Grades | Must not be available to student | none | denied | Broken | none | Incorrect primary action exposed |
| Student | feedback | Feedback | List | Read own sent feedback | select feedback | self RLS | Complete | demo E2E | Production query exists |
| Student | feedback | Feedback | Send Feedback | Must not be available to student | none | denied | Broken | none | Incorrect primary action exposed |
| Grader | overview | Dashboard | Metrics/attention | Assigned work and risk summary | scoped aggregates | assigned submissions | Partial | none | Generic staff metrics/hard-coded chart |
| Grader | grades | Workflow | Collect/edit/submit | Persist results and transition once | assessments/results/submissions | assigned grader | Not implemented | none | Form and lifecycle missing |
| Grader | grades | Workflow | Review status | Display faculty review | submissions/reviews read | assigned grader | Partial | none | Generic table only |
| Faculty | overview | Dashboard | Cards/charts | Assigned-class aggregates | scoped counts/evaluations + Realtime | assigned classes | Partial | none | Live filtered score trend and risk chart with PNG export; automated interaction coverage missing |
| Faculty | students | Students | Search/detail/add/import | Manage assigned roster | students/enrollments/import | assigned classes | Not implemented | modal-only demo E2E | Read only |
| Faculty | records | Class records | CRUD/version/export | Manage assigned records | class records/versions | assigned classes | Not implemented | none | Read only |
| Faculty | feedback | Feedback | Compose/send/history | Persist, deliver, notify, audit | feedback/delivery/notifications | assigned classes | Not implemented | none | Read only |
| Faculty | analytics | Analytics | Filters/charts/export | Query scoped aggregates/report | evaluation/result queries + Realtime | assigned analytics | Partial | none | Live filtered score, risk, pass-rule, and assessment charts; PNG/CSV export; automated interaction coverage missing |
| Faculty | assistant | Assistant | Send | Answer from authorized APMS data | approved AI service | scoped data | Blocked | none | No approved model/provider |
| Dean | overview | Dashboard | Cards/charts | Department aggregates | scoped counts/evaluations + Realtime | department | Partial | none | Live filtered dashboard charts and PNG export; automated interaction coverage missing |
| Dean | students | Students | CRUD/import/unenroll | Manage department roster | students/enrollments/import | department manage | Not implemented | none | Read only |
| Dean | faculty | Faculty | Invite/assign/edit | Manage faculty assignments | Auth worker/profiles/assignments | department manage | Not implemented | none | Read only |
| Dean | records | Class records | CRUD/version/export | Manage department records | records/versions | department manage | Not implemented | none | Read only |
| Dean | criteria | Criteria | CRUD/version/publish | Validate 100% and activate version | criteria sets/nodes | department manage | Not implemented | none | Read only |
| Dean | evaluation | Evaluation | Run | Create protected approved-model run | prediction run/worker | department run | Blocked | none | No approved model/provider |
| Dean | analytics | Analytics | Filters/charts/export | Department aggregate report | evaluations/results + Realtime | department analytics | Partial | none | Filtered class, risk, and pass-rule charts with PNG export; CSV remains authorized department report; automated interaction coverage missing |
| Dean | events | Events | CRUD/audience notify | Persist event and notifications | events/notifications/audit | department events | Not implemented | none | Read only |
| Dean | assistant | Assistant | Send | Authorized data answer | approved AI service | department scope | Blocked | none | No approved model/provider |
| Operator | overview | Dashboard | User metrics/activity | Real technical summary | profiles/audit queries + Realtime | dashboard/logs | Partial | none | Role/status filtered account charts, audit trend, and PNG export; automated interaction coverage missing |
| Operator | roles | Roles | CRUD/assignment | Persist permission changes safely | roles/role permissions/user roles | roles.manage | Not implemented | none | Read only |
| Operator | logs | Logs | Filter/detail/export | Server filter and auditable export | audit/access/system logs | logs.read/export | Not implemented | none | Basic audit read only |
| Operator | system | Settings | General/Auth/Integration save/test | Persist every displayed setting | system settings/integrations | system.configure | Partial | none | Session timeout only |
| Super Admin | backup | Backups | Create | Queue protected backup | insert `backups` + worker | backups.manage | Partial | none | Queue persists; worker absent |
| Super Admin | backup | Backups | Details/restore/delete/settings | Protected lifecycle with confirmation | backup/restores/worker | backups.manage | Not implemented | none | No controls/workers |
| Super Admin | admins | Admins | Invite/edit/disable/delete | Protected account lifecycle | Auth admin worker + profiles/roles | admin_accounts.manage | Not implemented | none | Read only |
| Super Admin | logs | Logs | Filter/detail/export | Technical audit inspection/export | log queries/export | logs.read/export | Not implemented | none | Basic audit read only |
| Super Admin | security | Security | Telemetry/policy | Real session/login/security state | protected logging/Auth admin | super-admin policy | Not implemented | none | Hard-coded/empty |
| Super Admin | notifications | Settings | Delivery/templates/rules | Persist all notification configuration | preferences/settings/templates | authorized setting | Partial | none | Fixed preference only |
| Super Admin | system/info | System | Settings/health | Real service settings and health | protected settings/health | authorized setting | Partial | none | One setting; health hard-coded/empty |
| Super Admin | assistant | Assistant | Send | Authorized technical answer | approved AI service | technical scope | Blocked | none | No approved model/provider |

## Release gate

The production release gate remains **not passed**. Complete the non-complete rows, replace demo-auth E2E with local Supabase seed users, run cross-role persistence tests, run database advisors against the target project, and record visual comparisons for every Figma frame before changing this status.

Latest automated run (2026-08-06): typecheck passed, lint passed, production web export passed, 12 domain tests passed, schema contract passed (44 tables / 9 contracts), and 10 Playwright tests passed. These results do not override the incomplete interaction rows above.
