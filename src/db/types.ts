export interface Account {
  readonly id: number;
  readonly institutionOrigin: string;
  readonly canvasUserId: string;
  readonly createdAt: number;
}

export type ConnectionStatus = "active" | "revoked";

export interface Course {
  readonly id: string;
  readonly accountId: number;
  readonly canvasCourseId: string;
  readonly courseCode: string | null;
  readonly title: string | null;
  readonly term: string | null;
  /** Fencing counter; bumped exactly once per successful import commit. */
  readonly snapshotGeneration: number;
  readonly importLeaseToken: string | null;
  readonly importLeaseExpiresAt: number | null;
  readonly lastSuccessfulCheckAt: number | null;
  readonly createdAt: number;
}

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

/** A student's own completion mark for one `source_items` row. Never written by import — see
 * `migrations/0002_import.sql`'s `task_state` table comment. */
export interface TaskState {
  readonly id: string;
  readonly accountId: number;
  readonly sourceItemId: string;
  readonly completed: boolean;
  readonly completedAt: number | null;
  readonly updatedAt: number;
}
