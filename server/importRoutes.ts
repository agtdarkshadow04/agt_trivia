import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';
import { readImportUpload, SheetImportService, type ImportUpload } from './sheetImport.js';

/** The Admin's Import tab (#22): previewing and importing the 1.x Google Sheet's CSV downloads. */

export const importRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    url: '/api/admin/import',
    auth: 'admin',
    // An import writes categories and questions; a preview runs in the same write and changes nothing.
    writesData: true,
    multipart: S.ImportUploadDocument,
    rateLimit: 'adminUploads',
    operationId: 'importSheet',
    tag: 'admin',
    summary: "Preview or import the 1.x Google Sheet's categories and questions from its CSV downloads.",
    description: '`action=preview` reports what an import would create and skip, and every bad row. `action=import` writes it all in one transaction, or nothing when any row is bad (`400 validation_failed`, the rows in `fields`). Existing categories (same name) and questions (same category and text) are skipped, so importing twice adds nothing.',
    schema: { response: { 200: S.ImportReport } },
    // The upload is read before the data write, so a slow client never holds the write lock (BAK-8).
    prepare: (_context, request) => readImportUpload(request),
    handler: (context, request) => {
      const upload = request.prepared as ImportUpload;
      const service = new SheetImportService(context);
      const report = upload.action === 'preview' ? service.preview(upload.files) : service.import(upload.files);
      // LOG-14: the counts only, never the rows.
      request.audit = { details: { action: report.action, files: Object.keys(upload.files), categories: report.categories, questions: report.questions, problems: report.problems.length } };
      return report;
    },
  },
];
