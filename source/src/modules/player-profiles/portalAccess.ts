// What the coach sees about a client's player-portal and Caddy access.

export type CaddyStatus = {
  connected: boolean;
  coachLinked?: boolean;
  coachCount?: number;
  access: string;
  active?: boolean;
  expiresAt?: string | null;
  unavailable?: string;
};

/** A client the coach has given player portal access to. */
export type PortalPlayer = {
  id: string;
  personId: string;
  email: string;
  status: "invited" | "active" | "disabled";
  invitedAt?: string | null;
  lastLoginAt?: string | null;
};
