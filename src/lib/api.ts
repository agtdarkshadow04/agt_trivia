/**
 * API types and helpers shared by the server and the browser (REPO-3, FE-2).
 */

/** A lowercase or uppercase RFC 9562 UUIDv4 (DATA-6); IDs are stored lowercase. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** `GET /api/health` (SRV-11). */
export interface Health {
  status: 'ok' | 'maintenance';
}

/** `GET /api/settings/public` (CFG-10): what the player UI needs, nothing sensitive. */
export interface PublicSettings {
  siteTitle: string;
  supportUrl: string;
  quizShortLength: number;
  quizLongLength: number;
}
