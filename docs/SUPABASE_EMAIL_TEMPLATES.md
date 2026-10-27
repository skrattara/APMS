# Supabase Auth email templates

APMS provides branded Supabase Auth email templates in `supabase/templates/`.
They use Supabase's supported Go template variables and inline email-safe styles.

## Templates

| Supabase email | Template file | Current APMS use |
| --- | --- | --- |
| Invite user | `invite.html` | Sent when an administrator invites a user to onboarding. |
| Confirm signup | `confirmation.html` | Configured; public sign-up is disabled in APMS. |
| Reset password | `recovery.html` | Sent from password recovery and administrator reset actions. |
| Magic link | `magic_link.html` | Configured for future passwordless sign-in; not currently used by APMS. |
| Change email | `email_change.html` | Configured for Supabase Auth email changes; not currently used by APMS. |
| Reauthentication | `reauthentication.html` | Available for the hosted dashboard template editor. |
| Password changed | `password_changed_notification.html` | Security notification template; disabled by default. |
| Email changed | `email_changed_notification.html` | Security notification template; disabled by default. |
| Phone changed | `phone_changed_notification.html` | Security notification template; disabled by default. |
| MFA method added | `mfa_factor_enrolled_notification.html` | Security notification template; disabled by default. |
| MFA method removed | `mfa_factor_unenrolled_notification.html` | Security notification template; disabled by default. |
| Sign-in method linked | `identity_linked_notification.html` | Security notification template; disabled by default. |
| Sign-in method removed | `identity_unlinked_notification.html` | Security notification template; disabled by default. |

## Local Supabase

`supabase/config.toml` connects the five authentication templates supported by
the current CLI configuration reference. Restart the local Supabase stack after
changing templates so Auth reloads them. Local Auth emails are captured by the
local email testing inbox rather than delivered to recipients.

The reauthentication template is included for the hosted template editor. The
current CLI configuration reference does not list a local `reauthentication`
template key.

Security notification templates are configured with `enabled = false`. Enable
them only after deciding which notices APMS should send and verifying the
project-level notification settings.

## Hosted Supabase project

Hosted Auth templates are managed separately from this repository. In the
Supabase Dashboard, open **Authentication → Emails** and copy the matching
subject and HTML from each file into its email template. Configure security
notification templates in the **Notifications** section; they remain off until
explicitly enabled. Supabase does not deploy hosted email template changes from
`supabase/config.toml`.

As of June 3, 2026, new Free-plan projects using Supabase's default SMTP cannot
customize Auth email templates. A custom SMTP provider is required for those
projects; existing projects retain their template customization.

Keep each template's Supabase variables intact. Invitation, confirmation,
recovery, magic-link, and email-change actions rely on `{{ .ConfirmationURL }}`;
the verification-code email uses `{{ .Token }}`. Email providers should not
rewrite or track these links because link rewriting can break one-time Auth
verification URLs.
