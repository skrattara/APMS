# Testing

```powershell
npm run typecheck
npm test
npm run test:schema
npm run test:e2e
npm run build
```

Vitest covers generic weights, missing-versus-zero scores, score validation, SWUNEXT rubric transmutation, P1/P2/P3 running views, final-grade conversion, the dual 80% passing rule, attendance, trends, CSV parsing/duplicates/errors, reports, three-role permissions, and scopes. The schema contract verifies attendance/import additions and the safe legacy-role migration. Playwright covers invalid login, unauthenticated routes, all three role redirects, cross-role denial, and Faculty workflows. The isolated AI package has its own pytest suite and synthetic lifecycle checks; see [the service guide](../services/ai/README.md). Model quality must be measured separately from software correctness, using independent real validation, calibration, and test cohorts.

Connected-project smoke tests should use the public/publishable key and a role-specific session. Verify that Academic Admin receives only its department-scoped classes and that System Admin can call `admin-users` with `action: list`. Never place a service-role credential in Expo environment files or browser tests. Account creation tests must use a disposable environment with a documented cleanup path.

Database reset/lint requires Docker Desktop. When Docker is unavailable, run the static schema contract and verify the connected schema through authorized read-only inspection; deployment remains a separate recorded step.
