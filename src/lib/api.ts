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

/** The member roles (#17), each with every power of the ones before it. */
export const memberRoles = ['Player', 'Editor', 'Moderator'] as const;
export type MemberRole = typeof memberRoles[number];

/**
 * Whether `role` has at least the powers of `minimum` (#17): Players play and
 * keep a score history, Editors also write questions, Moderators also review
 * them and manage categories. The server authorizes with this, never the UI.
 */
export function roleAtLeast(role: MemberRole, minimum: MemberRole) {
  return memberRoles.indexOf(role) >= memberRoles.indexOf(minimum);
}

export type AuthSource = 'local' | 'agt_iam';

/** `GET /api/member/session` (#17): the signed-in member. */
export interface MemberSession {
  id: string;
  username: string | null;
  displayName: string;
  role: MemberRole;
  authSource: AuthSource;
}

/** A member account as the Admin sees it (#17). */
export interface AdminMember extends MemberSession {
  isActive: boolean;
  /** An AGT member's traveller ID and AGT IAM tier (#18); null for a local member. */
  travellerId: string | null;
  iamPermission: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/categories` (#15): a category as visitors see it. */
export interface PublicCategory {
  id: string;
  shortName: string;
  name: string;
  description: string;
  priority: number;
  /** Approved questions. */
  questionCount: number;
}

export type QuizLength = 'short' | 'long' | 'all';

/** An approved question as visitors see it (#15). */
export interface PublicQuestion {
  id: string;
  prompt: string;
  /** 2 to 4 answers, in the author's order. */
  choices: { id: string; text: string }[];
  /** More than one for a multi-answer question. */
  correctChoiceIds: string[];
  authorCredit: string | null;
}

/** `GET /api/categories/{id}/quiz?length=` (#15). */
export interface PublicQuiz {
  category: PublicCategory;
  length: QuizLength;
  questions: PublicQuestion[];
}

/** `GET /api/settings/public` (CFG-10): what the player UI needs, nothing sensitive. */
export interface PublicSettings {
  siteTitle: string;
  supportUrl: string;
  quizShortLength: number;
  quizLongLength: number;
  /** Members can sign in with their AGT account (#18). */
  agtSignIn: boolean;
}

// --- Question authoring and review (#19) -----------------------------------------

export type MemberQuestionStatus = 'draft' | 'pending' | 'approved' | 'rejected';

/** A question as its author or a Moderator sees it (#19). */
export interface MemberQuestion {
  id: string;
  categoryId: string;
  prompt: string;
  status: MemberQuestionStatus;
  /** 2 to 4 answers, in the author's order; more than one correct for a multi-answer question. */
  choices: { id: string; text: string; isCorrect: boolean }[];
  /** The "Submitted by" credit, or null. */
  authorCredit: string | null;
  /** A Moderator's reason for rejecting it; empty when there is none. */
  reviewNote: string;
  createdBy: string | null;
  /** The author's display name, or null when they are gone or it was imported. */
  createdByName: string | null;
  approvedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionPage {
  items: MemberQuestion[];
  nextCursor: string | null;
}

/** `GET /api/member/question-counts`: the member's own questions by status, and for Moderators the review queue. */
export interface QuestionCounts {
  mine: Record<MemberQuestionStatus, number>;
  /** Every pending question, for Moderators; null for Editors. */
  reviewQueue: number | null;
}

/** The body of a new or changed question. */
export interface QuestionBody {
  categoryId: string;
  prompt: string;
  choices: { text: string; isCorrect: boolean }[];
  /** Moderators only; left out, it is the author's display name (new) or stays (changed). */
  authorCredit?: string | null;
}

// --- Category management (#20) ----------------------------------------------------

/** A category as Moderators manage it: its questions counted by status, and its version. */
export interface ManagedCategory {
  id: string;
  shortName: string;
  name: string;
  description: string;
  priority: number;
  questionCounts: Record<MemberQuestionStatus, number>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryBody {
  shortName: string;
  name: string;
  description: string;
  priority: number;
}
