# Developer Portal privacy policy link

This is the operator checklist for linking the community privacy policy in the
Discord Developer Portal. It describes the steps. It does not record that the
portal was changed.

**Status: not changed.** This repository has no access to the Developer Portal,
so nothing here edits or verifies the portal setting. An operator with portal
access performs the steps below and records the date and the policy version they
saw in the release notes.

## The public URL

- The policy is served at `/privacy`. The full URL is the value of `APP_URL`
  with `/privacy` appended. Confirm the exact host against the live deployment
  before entering it.
- The page shows Version 3 (`POLICY_VERSION` in `src/privacy.ts`). Confirm the
  page shows the version you expect before saving the portal setting.

## Portal steps

1. Open the application in the Discord Developer Portal and go to its general
   information settings.
2. In the **Privacy Policy URL** field, enter the full URL above. If the field
   is labelled differently in the portal, use the field that takes the privacy
   policy link.
3. Save. Open the public URL in a private browser window and confirm it returns
   the policy page with the expected version.
4. Record the save date, the version and who made the change in the release
   notes, not in this file.

## Privileged data and review

- The bot can request three privileged data scopes: the server member list,
  message content, and presence (online status). Which of them are requested
  depends on how the deployment is configured. The policy's "Why the bot asks
  Discord for sensitive data" section describes each one.
- Discord's post of June 10, 2026 says apps that reach 10,000 or more total users
  must go through a review to keep access to member lists, message content and
  presence, and must reapply for that access every year:
  https://discord.com/blog/updated-requirements-to-how-apps-access-data-in-servers
- The threshold counts total users reached, not servers. Track total users
  reached and the reapplication date. Do not rely on the older server-count rule.
- The Developer Policy and Developer Terms pages on Discord's support site could
  not be retrieved when this document was written, so this document cites no
  section numbers from them. Check the current text before the portal step.

## Related

- Deletion requests: `docs/moderator-admin-guide.md`, "Member deletion requests".
- Deletion scope and what it does not cover: `docs/member-erasure.md`.
