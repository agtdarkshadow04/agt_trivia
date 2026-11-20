import type { ManagedCategory, MemberSession } from '../src/lib/api.js';
import { isUuidV4, roleAtLeast } from '../src/lib/api.js';
import { fieldError } from '../src/lib/errors.js';
import { categoryErrors, normalizeCategory, type CategoryInput } from '../src/lib/validation.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import * as repo from './repository/categories.js';

/**
 * Category management (#20): Moderators list, create, replace and delete
 * categories. Every change carries the category's `version` (`409 conflict`
 * when it has changed); a category with questions cannot be deleted
 * (`409 category_not_empty`), so no question is ever orphaned.
 */

const noCounts = { draft: 0, pending: 0, approved: 0, rejected: 0 };

function notFound(): never {
  throw new HttpError(404, 'not_found', 'No such category.');
}

function conflict(): never {
  throw new HttpError(409, 'conflict', 'The category has changed since it was read. Reload it and try again.');
}

export interface CategoryChange {
  category: ManagedCategory;
  /** The names of the fields that changed, for the audit summary (LOG-14). */
  changed: string[];
}

export class CategoryService {
  constructor(private readonly context: AppContext, member: MemberSession, private readonly now: () => Date = () => new Date()) {
    if (!roleAtLeast(member.role, 'Moderator')) throw new HttpError(403, 'forbidden', 'Only Moderators manage categories.');
  }

  private get db() {
    return this.context.db;
  }

  private managed(category: repo.Category, counts = repo.categoryStatusCounts(this.db)): ManagedCategory {
    const { id, shortName, name, description, priority, version, createdAt, updatedAt } = category;
    return { id, shortName, name, description, priority, version, createdAt, updatedAt, questionCounts: counts.get(id) ?? { ...noCounts } };
  }

  private existing(id: string): repo.Category {
    const category = isUuidV4(id) ? repo.getCategory(this.db, id.toLowerCase()) : null;
    if (!category) notFound();
    return category;
  }

  /** The checked, normalized input; a short name or name another category uses is a `duplicate` field error. */
  private checked(input: CategoryInput, exceptId: string | null): CategoryInput {
    const problems = categoryErrors(input);
    const normalized = normalizeCategory(input);
    if (!problems.length) {
      for (const field of repo.categoryConflicts(this.db, normalized, exceptId)) {
        problems.push(fieldError(field, 'duplicate', field === 'shortName' ? 'Another category already has this short name.' : 'Another category already has this name.'));
      }
    }
    if (problems.length) throw new HttpError(400, 'validation_failed', 'The category is not valid.', { fields: problems });
    return normalized;
  }

  /** Every category in display order, with its questions counted by status. */
  list(): ManagedCategory[] {
    const counts = repo.categoryStatusCounts(this.db);
    return repo.listCategories(this.db).map((category) => this.managed(category, counts));
  }

  create(input: CategoryInput): ManagedCategory {
    return this.managed(repo.insertCategory(this.db, this.checked(input, null), this.now()));
  }

  replace(id: string, version: number, input: CategoryInput): CategoryChange {
    const current = this.existing(id);
    if (current.version !== version) conflict();
    const normalized = this.checked(input, current.id);
    if (!repo.updateCategory(this.db, current.id, version, normalized, this.now())) conflict();
    const changed = (['shortName', 'name', 'description', 'priority'] as const).filter((field) => current[field] !== normalized[field]);
    return { category: this.managed(repo.getCategory(this.db, current.id)!), changed };
  }

  delete(id: string, version: number): repo.Category {
    const current = this.existing(id);
    if (current.version !== version) conflict();
    const count = repo.categoryQuestionCount(this.db, current.id);
    if (count > 0) throw new HttpError(409, 'category_not_empty', 'The category still has questions. Move or delete them first.', { params: { count } });
    if (!repo.deleteCategory(this.db, current.id, version)) conflict();
    return current;
  }
}
