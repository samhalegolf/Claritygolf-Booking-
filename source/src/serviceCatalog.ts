// Inbound integrations file bookings under this reserved service id. It is a
// system filing bucket, not a lesson type a coach can create, sell or manage.
const RESERVED_EXTERNAL_BOOKING_SERVICE_ID = "external-booking";

export function isManagedService(service: { id?: string | null }) {
  return service.id !== RESERVED_EXTERNAL_BOOKING_SERVICE_ID;
}
