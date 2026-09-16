import type { Account } from "./types";

interface AccountRow {
  readonly id: number;
  readonly institution_origin: string;
  readonly canvas_user_id: string;
  readonly created_at: number;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    institutionOrigin: row.institution_origin,
    canvasUserId: row.canvas_user_id,
    createdAt: row.created_at,
  };
}

/**
 * Finds the account for this institution + Canvas user id, creating it on first sighting.
 * The composite key means the same Canvas user id at a different institution is always a
 * distinct account, never a collision. Never takes a caller-supplied account id — identity is
 * derived only from the institution/Canvas-user-id pair a caller has already verified.
 */
export async function findOrCreateAccount(
  db: D1Database,
  institutionOrigin: string,
  canvasUserId: string,
  now: number,
): Promise<Account> {
  const inserted = await db
    .prepare(
      `INSERT INTO accounts (institution_origin, canvas_user_id, created_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (institution_origin, canvas_user_id) DO NOTHING
       RETURNING id, institution_origin, canvas_user_id, created_at`,
    )
    .bind(institutionOrigin, canvasUserId, now)
    .first<AccountRow>();
  if (inserted) return toAccount(inserted);

  const existing = await db
    .prepare(
      `SELECT id, institution_origin, canvas_user_id, created_at
       FROM accounts
       WHERE institution_origin = ?1 AND canvas_user_id = ?2`,
    )
    .bind(institutionOrigin, canvasUserId)
    .first<AccountRow>();
  if (!existing) throw new Error("account lookup failed after insert conflict");
  return toAccount(existing);
}
