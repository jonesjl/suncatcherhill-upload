# Upload dependency update — October 22, 2026

Next.js and eslint-config-next move from 16.2.10 to 16.4.2; NextAuth moves
from 4.24.14 to 4.24.15. The refreshed lockfile includes sharp 0.35.5,
postcss 8.5.23, nanoid 3.3.20, and uuid 11.1.1. No application behavior,
AWS configuration, credentials, or deployment settings are changed.

Validation on Node 22.23.4 / npm 12.2.1:

- Clean `npm ci --ignore-scripts --allow-remote=all` passed. All resolved
  tarball URLs were checked to use registry.npmjs.org. The per-command remote
  option was needed for npm 12 URL dependency resolution; no persistent npm
  configuration was changed.
- `npm run lint` and `npm run build` passed, including TypeScript checking.
- Local production-server checks with synthetic settings passed: homepage
  requires sign-in, anonymous session is empty, only Cognito is advertised,
  and anonymous upload URL requests return HTTP 401. No AWS calls or real
  credentials were needed.
- `npm audit --omit=dev --package-lock-only` reports zero vulnerabilities.
- Full audit reports five high package entries, all stemming from the same
  unpatched braces advisory in the ESLint tooling chain. This is not five
  independent flaws. Do not accept untrusted glob patterns in development
  tooling. No custom dependency patch or major-version downgrade was applied.

Primary advisories:

- https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw
- https://github.com/nextauthjs/next-auth/security/advisories/GHSA-x445-f3h2-j279
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm

The reviewed Auth.js provider-mix-up prerequisites are not met by this
Cognito-only configuration. Updating does not imply confirmed exploitation.

## Deployment and remaining verification

This branch is for Forgejo review. GitHub and the running Amplify deployment
have not been changed. Before deployment, verify Amplify's connected GitHub
branch, auto-build setting, and build Node version. After owner approval,
publish the reviewed commit to the correct GitHub deployment branch, inspect
Amplify build logs, and verify normal owner sign-in, a small authorized upload,
and denial for an account outside the allowlist. Keep the prior deployment
available for rollback if any check fails.

This dependency patch does not close the separate upload-size enforcement,
file-count limit, security-header, Cognito/IAM/S3 configuration, or deployment
runtime verification findings. Production dependency audit results describe
this lockfile at query time, not the still-running old deployment.
