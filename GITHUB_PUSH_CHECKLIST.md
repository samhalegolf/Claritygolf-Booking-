# GitHub push checklist

1. Create a safety branch from the current repository.
2. Extract this bundle.
3. Copy the files inside `clarity-golf-booking-production-repair/` into the repository root.
4. Do not retain a second nested `source/` or `deploy/` app copy.
5. Run `npm ci`, `npm test`, and `npm run build`.
6. Commit and push the branch.
7. Let Netlify create a deploy preview first.
8. Test login and password reset on the preview.
9. Test saving an appointment for a client whose email already exists.
10. Test editing that appointment twice in quick succession.
11. Test cancelling it, including the case where it is the final calendar item.
12. Confirm booking/reschedule/cancellation receipts appear in notification history.
13. Promote/merge only after those checks pass.

Suggested commit message:

```text
Fix production calendar persistence, auth and notifications
```
