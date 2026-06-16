White screen hotfix for claritygolf.app

Cause seen in browser console:
  TypeError: Cannot read properties of null (reading 'toLowerCase')

Fix applied:
- Hardened text normalisation against null/undefined values in source App.tsx.
- Patched the deployed/minified JS bundle so client records with null name/email/phone/notes/profile fields no longer crash the whole app.
- Kept the crash guard from the previous package.

Deploy option:
- Upload the contents of the deploy/ folder to Netlify as a manual deploy, or replace your current deploy folder with it.
- For source-based deploys, use the source/ folder changes and run npm install + npm run build in your normal project environment.
