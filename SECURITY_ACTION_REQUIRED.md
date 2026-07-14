# Security: rotate your admin password

**14 July 2026. This one needs you, not code.**

## What happened

`source/server/clarity-booking.sqlite` was committed to the repository. The repo — `github.com/samhalegolf/Claritygolf-Booking-` — is **public**.

The file contained:

| | |
|---|---|
| `admin_users.email` | `samhalegolf@gmail.com` |
| `admin_users.password_hash` | 128 chars, present |
| `admin_users.password_salt` | 32 chars, present |
| `settings.adminPasswordSeedKey` | present |
| `settings.syncKey` | present |
| `admin_sessions` | 2 rows, expired June 2026 (harmless) |

No client data (`people` and `calendar_items` were both empty), and no API keys or `.env` files were ever committed — I checked the full history. So the exposure is your admin credential, not your clients.

## What I did

- Removed the file from git tracking (`git rm --cached`) — the file is still on your disk, your local dev server is unaffected.
- Added `*.sqlite`, `*.sqlite-shm`, `*.sqlite-wal` to `.gitignore` so it cannot be re-committed.

## What you need to do

**Untracking it does not remove it from git history.** The hash is in the public commit log and will stay there. So:

1. **Change your admin password.** This is the actual fix. The hash is scrypt, so it is not trivially reversible — but it is a real credential sitting in a public repo, and rotating it makes the exposed hash worthless.
2. **Rotate `CLARITY_ADMIN_PASSWORD`** in Netlify to match.
3. **Regenerate `adminPasswordSeedKey` and `syncKey`** if either is still in use.
4. *Optional:* purge the file from history with `git filter-repo` or the BFG. Only worth it if you want the record clean — rotating the password is what actually protects you, and it's what matters.

The good news: your admin login was never hardcoded in the source. `ensureAdminUser()` reads `CLARITY_ADMIN_EMAIL` / `CLARITY_ADMIN_PASSWORD` from the environment, which is the right design. The leak was the committed dev database, not the code.
