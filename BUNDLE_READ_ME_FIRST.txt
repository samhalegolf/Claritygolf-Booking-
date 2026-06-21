CLARITY GOLF BOOKING — GITHUB-READY REPAIR BUNDLE

1. Extract the ZIP.
2. Copy the CONTENTS of the clarity-golf-booking-production-repair folder into the ROOT of the existing GitHub repository.
3. Do not upload the ZIP itself and do not create another nested source/deploy folder.
4. Push on a safety branch first.
5. Netlify should build with:
     Build command: npm run build
     Publish directory: dist
     Functions directory: netlify/functions
     Node version: 24
6. Confirm the production Netlify variable EMAIL_NOTIFICATIONS_ENABLED is set to 1.
7. After deploy, run the checks in GITHUB_PUSH_CHECKLIST.md.

This bundle contains source only. It intentionally contains no Netlify, Supabase, Resend or password secrets.
