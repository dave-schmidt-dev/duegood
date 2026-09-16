import type { KeyRing } from "./config";

/** Envelope layout: [formatVersion:1][nonce:12][ciphertext+tag]. Distinct from the key ring's
 * key version — this byte identifies the envelope's own encoding shape. */
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const ACCOUNT_ID_BYTES = 8;
/** Canonical UUID string length (8-4-4-4-12 plus hyphens). Fixed width, so concatenating it with
 * the fixed-width account id below can never produce an ambiguous associated-data encoding. */
const CONNECTION_ID_BYTES = 36;

export interface CredentialIdentity {
  readonly accountId: number;
  readonly connectionId: string;
}

export interface EncryptedCredential {
  readonly keyVersion: number;
  readonly envelopeB64: string;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Fixed-width fields only: a 1-byte format version, an 8-byte big-endian account id, and a
 * 36-byte canonical UUID. No delimiters, so no two distinct (accountId, connectionId) pairs can
 * ever serialize to the same bytes — the property `credential-envelope.test.ts` locks in. */
function buildAssociatedData(identity: CredentialIdentity): Uint8Array<ArrayBuffer> {
  if (identity.connectionId.length !== CONNECTION_ID_BYTES) {
    throw new Error("connectionId must be a canonical 36-character UUID");
  }
  const aad = new Uint8Array(1 + ACCOUNT_ID_BYTES + CONNECTION_ID_BYTES);
  new DataView(aad.buffer).setUint8(0, FORMAT_VERSION);
  new DataView(aad.buffer).setBigUint64(1, BigInt(identity.accountId), false);
  aad.set(new TextEncoder().encode(identity.connectionId), 1 + ACCOUNT_ID_BYTES);
  return aad;
}

function importKey(rawKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts under the ring's active key version, with a fresh random 96-bit nonce every call
 * (never a counter — GCM's security depends on nonce uniqueness, and randomness is the only
 * source of that guarantee available here). */
export async function encryptCredential(
  keyRing: KeyRing,
  identity: CredentialIdentity,
  plaintext: string,
): Promise<EncryptedCredential> {
  const key = keyRing.keys.get(keyRing.activeVersion);
  if (!key) throw new Error("active key version missing from key ring");

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const aad = buildAssociatedData(identity);
  const cryptoKey = await importKey(key);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      cryptoKey,
      new TextEncoder().encode(plaintext),
    ),
  );

  const envelope = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  envelope[0] = FORMAT_VERSION;
  envelope.set(nonce, 1);
  envelope.set(ciphertext, 1 + NONCE_BYTES);

  return { keyVersion: keyRing.activeVersion, envelopeB64: base64Encode(envelope) };
}

/** Decrypts using whichever ring key matches the envelope's declared key version — active or
 * legacy — so a credential encrypted under a since-retired version still decrypts as long as
 * that version's key is still present in the ring's legacy map. AES-GCM's tag verification
 * itself rejects any identity mismatch (wrong account/connection) or tampering; no separate
 * check is needed beyond constructing the same associated data the encryptor used. */
export async function decryptCredential(
  keyRing: KeyRing,
  identity: CredentialIdentity,
  encrypted: EncryptedCredential,
): Promise<string> {
  const envelope = base64Decode(encrypted.envelopeB64);
  if (envelope.length < 1 + NONCE_BYTES) throw new Error("malformed credential envelope");

  const formatVersion = envelope[0];
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(`unsupported credential envelope format ${String(formatVersion)}`);
  }

  const key = keyRing.keys.get(encrypted.keyVersion);
  if (!key) throw new Error(`key version ${String(encrypted.keyVersion)} not present in key ring`);

  const nonce = envelope.slice(1, 1 + NONCE_BYTES);
  const ciphertext = envelope.slice(1 + NONCE_BYTES);
  const aad = buildAssociatedData(identity);
  const cryptoKey = await importKey(key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    cryptoKey,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
