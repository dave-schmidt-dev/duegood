export interface Account {
  readonly id: number;
  readonly institutionOrigin: string;
  readonly canvasUserId: string;
  readonly createdAt: number;
}

export type ConnectionStatus = "active" | "revoked";

export interface Connection {
  readonly id: string;
  readonly accountId: number;
  readonly status: ConnectionStatus;
  /** Fencing counter; increments every time the connection is revoked. */
  readonly generation: number;
  readonly keyVersion: number;
  readonly encryptedAccessToken: string;
  readonly encryptedRefreshToken: string | null;
  readonly accessTokenExpiresAt: number | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}
