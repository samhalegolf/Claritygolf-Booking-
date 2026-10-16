# Proper Locations Acceptance Checklist

Use this checklist to accept the Proper Locations, Coach Calendar, Location Calendar, and Workspace Account branch.

1. Sam admin can sign in and load the app without clearing existing data.
2. The calendar workspace labels Sam's default view as `Coach Calendar - Sam Hale`.
3. Existing bookings without new ownership fields still appear through fallback account, coach, and location resolution.
4. Public booking can create a booking for an active public service.
5. A new booking stores `accountId`, `coachId`, `locationId`, a coach snapshot, and a location snapshot.
6. Booking confirmation shows the real location, coach, service, date, and time.
7. Legacy `service.location` text such as `Bay hire included` never appears as a physical venue.
8. Location Calendar shows bookings for the selected location grouped by coach.
9. A location-wide block prevents public bookings at that location for every coach.
10. A coach/location block prevents public bookings for that coach at that location.
11. A coach-only backend user cannot update another coach's calendar, services, availability, clients, or notifications.
12. Entitlement-disabled features are hidden, disabled, or rejected with a clear plan message.
13. Public routes resolve account, coach, and location server-side and do not trust client-supplied ownership fields.
14. Google Calendar links, Apple calendar downloads, ICS feeds, emails, and notifications use the resolved real location.
15. `source/node_modules/` and `source/dist/` remain ignored and uncommitted.
