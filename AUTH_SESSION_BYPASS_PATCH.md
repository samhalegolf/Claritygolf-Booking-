# Temporary auth startup patch

The app no longer calls `/api/auth/session` during initial page startup.

This prevents the login page becoming permanently stuck on **Checking** when the session request or its database lookup hangs. The patch does **not** bypass authentication:

- the login form is shown immediately;
- `/api/auth/login` is still required to enter the coach app;
- all protected APIs still validate the `clarity_session` cookie;
- password reset and logout remain enabled;
- refreshing the browser requires signing in again until automatic session restoration is re-enabled.

Re-enable later by restoring the initial session check in `src/App.tsx` after the session endpoint has a bounded server-side timeout.
