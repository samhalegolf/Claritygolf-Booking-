// Optix resource bookings are intentionally manual.
//
// The booking card owns the only create action through its explicit
// "Book resource" button. Clarity booking saves, reschedules, cancellations,
// page loads and other API mutations must never create an Optix booking.
export function installOptixBookingMutationSync() {
  // Deliberately no-op.
}
