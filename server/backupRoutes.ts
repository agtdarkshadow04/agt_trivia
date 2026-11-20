import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fieldError } from '../src/lib/errors.js';
import { BackupService } from './backup.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { sessionExpiry } from './repository/admin.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';
import { adminSessionCookie, clearedCookie, hashSessionToken, secureCookie } from './session.js';

/** The Backup & restore tab's routes (BAK-1). */

/** The server log for backups and restores (source `backup`, LOG-7). */
function backupLog(request: FastifyRequest) {
  return {
    info: (details: object, message: string) => request.log.info(details, message),
    warn: (details: object, message: string) => request.log.warn(details, message),
    error: (details: object, message: string) => request.log.error(details, message),
  };
}

/**
 * Reads the multipart body: the `action` field and the `backup` file, streamed
 * to a work directory under `backupsDir` that the caller always deletes (BAK-1,
 * SEC-10). The file may be at most `backup.maxZipBytes`.
 */
async function readUpload(request: FastifyRequest, service: BackupService, dir: string) {
  if (!request.isMultipart()) throw new HttpError(415, 'multipart_required', 'The backup must be uploaded as multipart/form-data.');
  const maxBytes = service.maxUploadBytes();
  let action: string | undefined;
  let file: string | undefined;
  try {
    for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1, fields: 1, parts: 2 } })) {
      if (part.type === 'field' && part.fieldname === 'action') action = String(part.value);
      else if (part.type === 'file' && part.fieldname === 'backup') {
        file = join(dir, 'upload.zip');
        await pipeline(part.file, createWriteStream(file));
      } else if (part.type === 'file') {
        part.file.resume();
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new HttpError(413, 'file_too_large', `The backup is larger than ${maxBytes} bytes.`, { params: { maxBytes } });
    }
    throw error;
  }
  if (action !== 'preview' && action !== 'restore') {
    throw new HttpError(400, 'validation_failed', 'action must be preview or restore.', { fields: [fieldError('action', 'not_allowed', 'action must be preview or restore.')] });
  }
  if (!file) throw new HttpError(400, 'file_required', 'Choose a backup file.');
  return { action, file };
}

async function restoreRoute(context: AppContext, request: FastifyRequest, reply: FastifyReply) {
  const service = new BackupService(context, backupLog(request), context.backupHooks);
  const dir = service.workDir('upload');
  try {
    const { action, file } = await readUpload(request, service, dir);
    request.audit = { details: { action } };
    if (action === 'preview') {
      const report = await service.preview(file);
      request.audit = { details: { action, counts: report.counts, schemaVersion: report.schemaVersion.backup } };
      return report;
    }
    const lock = context.operations;
    const token = request.cookies[adminSessionCookie] ?? '';
    const tokenHash = hashSessionToken(token);
    const caller = lock.state === 'restore_failed' && lock.recovery
      ? lock.recovery
      : { tokenHash, username: request.admin!, expiresAt: sessionExpiry(context.db, tokenHash) ?? new Date(Date.now() + 60 * 60 * 1000) };
    const report = await service.restore(file, caller);
    // LOG-14: the counts and file, never the content (BAK-4 step 6.4).
    request.audit = { details: { action, counts: report.counts, preRestoreBackup: report.preRestoreBackup, ignoredSettings: report.ignoredSettings } };
    // The restored Admin account replaces the caller's; every session is gone.
    reply.header('set-cookie', clearedCookie(secureCookie(context, request)));
    return report;
  } catch (error) {
    // LOG-14: a refused archive's reason, never its content.
    if (error instanceof HttpError && error.params?.reason) request.audit = { ...request.audit, details: { ...request.audit?.details, reason: error.params.reason } };
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const backupRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    url: '/api/admin/backup',
    auth: 'admin',
    // The backup takes the operation lock itself and writes nothing (BAK-8, BAK-9).
    writesData: false,
    audit: true,
    operationId: 'downloadBackup',
    tag: 'admin',
    summary: 'Download a backup archive of the database and config.yaml.',
    description: 'Data writes wait while the snapshot is taken (BAK-8, BAK-9). Sessions, .env and the logs are never included.',
    schema: { response: { 200: S.BackupDownload } },
    handler: async (context, request, reply) => {
      const backup = await new BackupService(context, backupLog(request), context.backupHooks).createBackup();
      request.audit = { details: { size: backup.size } };
      const stream = createReadStream(backup.file);
      stream.on('close', backup.cleanup);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${backup.fileName}"`)
        .send(stream);
    },
  },
  {
    method: 'POST',
    url: '/api/admin/restore',
    auth: 'admin',
    // The restore takes the operation lock itself, which a data write's count would block (BAK-4, BAK-8).
    writesData: false,
    multipart: S.RestoreUploadDocument,
    rateLimit: 'adminUploads',
    operationId: 'restoreBackup',
    tag: 'admin',
    summary: 'Preview a backup archive, or restore it and sign everyone out.',
    description: '`action=preview` validates the archive and changes nothing (BAK-3). `action=restore` validates it again, saves a pre-restore backup, replaces the data and rolls back on failure (BAK-4, BAK-10).',
    schema: { response: { 200: S.RestoreReport } },
    handler: restoreRoute,
  },
];
