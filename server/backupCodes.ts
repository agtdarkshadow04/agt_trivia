/**
 * The stable codes the backup routes report beside their English text, so the
 * admin dashboard can translate them (I18N-6). No imports: the browser's
 * translation tests read these lists.
 */

/** Why a backup archive was refused, as `params.reason` of `422 archive_rejected`. */
export const archiveRejectionReasons = [
  'too_large', 'not_zip', 'unsafe_zip', 'missing_manifest', 'invalid_manifest', 'not_a_backup', 'newer_format',
  'unlisted_file', 'missing_file', 'checksum_mismatch', 'invalid_database', 'disallowed_entry', 'newer_schema',
  'schema_mismatch', 'missing_tables', 'invalid_admin',
] as const;

export type ArchiveRejectionReason = typeof archiveRejectionReasons[number];

/** The warnings a preview or a restore can give, with their English text. */
export const restoreWarnings = {
  no_admin: 'The backup has no Admin account; first-run setup will be needed after the restore.',
  set_aside_not_deleted: 'The replaced data could not be deleted from the data directory; delete the files named in the server log by hand.',
} as const;

export type RestoreWarningCode = keyof typeof restoreWarnings;
