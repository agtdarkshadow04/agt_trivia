import { randomUUID } from 'node:crypto';
import type { MemberQuestionStatus, QuestionReport } from '../../src/lib/api.js';
import type { ReportInput, ReportReason, ReportStatus } from '../../src/lib/validation.js';
import { assertDataWrite } from '../dataWrite.js';
import type { Database } from '../db.js';

/** The `question_reports` table (#46). Callers validate and normalize input first. */

export interface StoredReport extends QuestionReport {
  memberId: string | null;
}

interface ReportRow {
  id: string;
  question_id: string;
  question_prompt: string;
  question_status: MemberQuestionStatus;
  category_id: string;
  category_name: string;
  member_id: string | null;
  member_name: string | null;
  reason: ReportReason;
  note: string;
  status: ReportStatus;
  resolution_note: string;
  resolved_by_name: string | null;
  resolved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const selectReports = `SELECT question_reports.*, questions.prompt AS question_prompt, questions.status AS question_status,
    categories.id AS category_id, categories.name AS category_name,
    reporter.display_name AS member_name, resolver.display_name AS resolved_by_name
  FROM question_reports
  JOIN questions ON questions.id = question_reports.question_id
  JOIN categories ON categories.id = questions.category_id
  LEFT JOIN members AS reporter ON reporter.id = question_reports.member_id
  LEFT JOIN members AS resolver ON resolver.id = question_reports.resolved_by`;

function toReport(row: ReportRow): StoredReport {
  return {
    id: row.id,
    questionId: row.question_id,
    questionPrompt: row.question_prompt,
    questionStatus: row.question_status,
    categoryId: row.category_id,
    categoryName: row.category_name,
    reason: row.reason,
    note: row.note,
    status: row.status,
    memberId: row.member_id,
    reportedBy: row.member_id,
    reportedByName: row.member_name,
    resolvedByName: row.resolved_by_name,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getReport(db: Database, id: string): StoredReport | null {
  const row = db.connection.prepare(`${selectReports} WHERE question_reports.id = ?`).get(id) as ReportRow | undefined;
  return row ? toReport(row) : null;
}

/** Whether `memberId` has an open report on the question. */
export function hasOpenReport(db: Database, questionId: string, memberId: string) {
  return db.connection.prepare("SELECT 1 FROM question_reports WHERE question_id = ? AND member_id = ? AND status = 'open'").get(questionId, memberId) !== undefined;
}

export function insertReport(db: Database, input: ReportInput & { questionId: string; memberId: string }, now = new Date()): StoredReport {
  assertDataWrite();
  const id = randomUUID();
  const at = now.toISOString();
  db.connection.prepare(`INSERT INTO question_reports (id, question_id, member_id, reason, note, status, resolution_note, resolved_by, resolved_at, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', '', NULL, NULL, 1, ?, ?)`).run(id, input.questionId, input.memberId, input.reason, input.note, at, at);
  return getReport(db, id)!;
}

/**
 * Closes an open report at `version` as `resolved` or `dismissed`; false when
 * it is no longer open at that version (nothing changed).
 */
export function closeReport(db: Database, id: string, version: number, change: { status: 'resolved' | 'dismissed'; note: string; by: string }, now = new Date()) {
  assertDataWrite();
  const at = now.toISOString();
  return db.connection.prepare(`UPDATE question_reports SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND version = ? AND status = 'open'`).run(change.status, change.note, change.by, at, at, id, version).changes > 0;
}

export interface ReportPagePosition {
  createdAt: string;
  id: string;
}

/** One page of reports with `status`, oldest first, the ID breaking ties (API-8). */
export function listReports(db: Database, options: { status: ReportStatus; limit: number; after: ReportPagePosition | null }) {
  const conditions = ['question_reports.status = ?'];
  const values: (string | number)[] = [options.status];
  if (options.after) {
    conditions.push('(question_reports.created_at > ? OR (question_reports.created_at = ? AND question_reports.id > ?))');
    values.push(options.after.createdAt, options.after.createdAt, options.after.id);
  }
  const rows = db.connection.prepare(`${selectReports} WHERE ${conditions.join(' AND ')}
    ORDER BY question_reports.created_at, question_reports.id LIMIT ?`).all(...values, options.limit + 1) as ReportRow[];
  return { reports: rows.slice(0, options.limit).map(toReport), more: rows.length > options.limit };
}

export function openReportCount(db: Database) {
  return (db.connection.prepare("SELECT count(*) AS n FROM question_reports WHERE status = 'open'").get() as { n: number }).n;
}
