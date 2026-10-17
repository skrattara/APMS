# Deployment

For the complete forecasting deployment, including Docker on another computer, application/Supabase integration, AWS Fargate, Cloudflare Tunnel/Containers and static web hosting, follow [the AI cloud deployment runbook](AI_MODEL_CLOUD_DEPLOYMENT.md). It includes deployment order, server-only secrets, connection checks, quotas, validation and rollback. Use the preserved APMS Supabase connection; do not create a replacement project as part of an AI deployment.

1. Confirm the existing production project and the institution's approved staging environment; any additional project provisioning follows the owner's deployment process.
2. Review migrations, retention, SMTP, storage limits, and backup policy with SWU PHINMA.
3. Link only after explicit owner approval, then apply migrations through CI using protected secrets.
4. Build Expo web/native artifacts with production environment variables.
5. Deploy the Python service privately; configure its server-only token and approved model artifact.
6. Run type, unit, database, E2E, security, and smoke checks before promotion.

Never deploy demo mode, fictional accounts, service-role keys, an unvalidated model, or insecure default credentials.
