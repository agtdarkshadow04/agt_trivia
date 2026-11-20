import type { MemberSession, QuestionReport } from '../src/lib/api.js';
import { isUuidV4, roleAtLeast } from '../src/lib/api.js';
import { normalizeReport, reportInputErrors, resolutionNoteError, type ReportInput, type ReportStatus } from '../src/lib/validation.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { decodeQuestionCursor, encodeQuestionCursor } from './questions.js';
import { getQuestion } from './repository/questions.js';
import * as repo from './repository/reports.js';

/**
 * Question reports (#46). Every signed-in member, any role, can report a
 * problem with an approved question: a reason and an optional note, at most
 * one open report per member and question. Moderators list the reports and
 * resolve or dismiss them at a `version`. Never anonymous, so no ALTCHA (ALT-1).
 */

function toReport(report: repo.StoredReport): QuestionReport {
  const { memberId: _memberId, ...rest } = report;
  return rest;
}

export class ReportService {
  constructor(private readonly context: AppContext, private readonly member: MemberSession, private readonly now: () => Date = () => new Date()) {}

  private get db() {
    return this.context.db;
  }

  private requireModerator() {
    if (!roleAtLeast(this.member.role, 'Moderator')) throw new HttpError(403, 'forbidden', 'Only Moderators handle question reports.');
  }

  /** Reports an approved question; anything else, or an unknown ID, answers 404 as if it did not exist. */
  create(questionId: string, input: ReportInput): QuestionReport {
    const id = questionId.toLowerCase();
    const question = isUuidV4(id) ? getQuestion(this.db, id) : null;
    if (!question || question.status !== 'approved') throw new HttpError(404, 'not_found', 'The question does not exist.');
    const problems = reportInputErrors(input);
    if (problems.length) throw new HttpError(400, 'validation_failed', 'The report is not valid.', { fields: problems });
    if (repo.hasOpenReport(this.db, question.id, this.member.id)) {
      throw new HttpError(409, 'report_exists', 'You have already reported this question; a Moderator will look at it.');
    }
    return toReport(repo.insertReport(this.db, { ...normalizeReport(input), questionId: question.id, memberId: this.member.id }, this.now()));
  }

  /** Moderators: the reports with `status` (open by default), oldest first. */
  list(query: { status?: ReportStatus; limit?: number; cursor?: string }) {
    this.requireModerator();
    const after = query.cursor ? decodeQuestionCursor(query.cursor) : null;
    if (query.cursor && !after) throw new HttpError(400, 'invalid_request', 'The cursor is not valid.');
    const page = repo.listReports(this.db, { status: query.status ?? 'open', limit: query.limit ?? 50, after });
    const last = page.reports.at(-1);
    return { items: page.reports.map(toReport), nextCursor: page.more && last ? encodeQuestionCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

  /** Moderators: closes an open report at `version`, with an optional note for the record. */
  close(reportId: string, version: number, status: 'resolved' | 'dismissed', note: string): QuestionReport {
    this.requireModerator();
    const id = reportId.toLowerCase();
    const report = isUuidV4(id) ? repo.getReport(this.db, id) : null;
    if (!report) throw new HttpError(404, 'not_found', 'The report does not exist.');
    const problem = resolutionNoteError(note);
    if (problem) throw new HttpError(400, 'validation_failed', 'The note is not valid.', { fields: [problem] });
    if (!repo.closeReport(this.db, report.id, version, { status, note: note.trim(), by: this.member.id }, this.now())) {
      throw new HttpError(409, 'conflict', 'The report has changed since it was read, or is no longer open. Reload and try again.');
    }
    return toReport(repo.getReport(this.db, report.id)!);
  }
}
