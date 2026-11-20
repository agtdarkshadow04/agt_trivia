import type { PublicCategory, PublicQuiz, QuizLength } from '../src/lib/api.js';
import { isUuidV4 } from '../src/lib/api.js';
import { questionsForQuiz, shuffle } from '../src/lib/quiz.js';
import { issueAttempt } from './attempts.js';
import { settingValues, type AppContext } from './context.js';
import { HttpError } from './http.js';
import { getCategory, listCategories, type Category } from './repository/categories.js';
import { approvedQuestions, type Question } from './repository/questions.js';
import { readSettings } from './repository/settings.js';
import type { RouteDefinition } from './routes.js';
import * as S from './schemas.js';

/**
 * The public quiz reads (#15): the categories and a random quiz of approved
 * questions. No session; only the fields of the public schemas leave the
 * server (API-3). Playing writes nothing, so it needs no ALTCHA (§11).
 */

function publicCategory(category: Category): PublicCategory {
  const { id, shortName, name, description, priority, questionCount } = category;
  return { id, shortName, name, description, priority, questionCount };
}

/**
 * A question as visitors see it, its choices shuffled anew for every quiz
 * (#41): the 1.x sheet often lists the correct answer first. A choice keeps
 * its ID, so grading in the browser and on the server (#21) is unchanged.
 */
function publicQuestion(question: Question, random: () => number) {
  const choices = shuffle(question.choices, random);
  return {
    id: question.id,
    prompt: question.prompt,
    choices: choices.map((choice) => ({ id: choice.id, text: choice.text })),
    correctChoiceIds: choices.filter((choice) => choice.isCorrect).map((choice) => choice.id),
    authorCredit: question.authorCredit,
  };
}

/** A random quiz from a category's approved questions, each with its choices shuffled; `random` is for tests. */
export function publicQuiz(context: AppContext, categoryId: string, length: QuizLength, random: () => number = Math.random): PublicQuiz {
  // API-5: a malformed ID is just another unknown category.
  const category = isUuidV4(categoryId) ? getCategory(context.db, categoryId.toLowerCase()) : null;
  if (!category) throw new HttpError(404, 'not_found', 'The category does not exist.');
  const values = settingValues(context.config, readSettings(context.db));
  const count = length === 'short' ? values['quiz.shortLength'] : length === 'long' ? values['quiz.longLength'] : undefined;
  const questions = questionsForQuiz(approvedQuestions(context.db, category.id), count, random);
  // #45: signed, not stored; drawing a quiz writes nothing (BAK-8).
  const attempt = issueAttempt(context.db, { categoryId: category.id, length, questionIds: questions.map((question) => question.id) });
  return { category: publicCategory(category), length, questions: questions.map((question) => publicQuestion(question, random)), attempt };
}

export const quizRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    url: '/api/categories',
    auth: 'none',
    writesData: false,
    operationId: 'listCategories',
    tag: 'public',
    summary: 'List the quiz categories with their number of approved questions.',
    schema: { response: { 200: S.PublicCategoryList } },
    handler: (context) => listCategories(context.db).map(publicCategory),
  },
  {
    method: 'GET',
    url: '/api/categories/:id/quiz',
    auth: 'none',
    writesData: false,
    operationId: 'getQuiz',
    tag: 'public',
    summary: "Draw a random quiz from a category's approved questions.",
    description: 'Each call draws anew, with a new signed `attempt` that a member sends back with their result (#45). The correct answers are included: anonymous play is graded in the browser, as in 1.x.',
    schema: { params: S.CategoryIdParams, querystring: S.QuizQuery, response: { 200: S.PublicQuiz } },
    handler: (context, request) => {
      const { id } = request.params as { id: string };
      const { length } = request.query as { length: QuizLength };
      return publicQuiz(context, id, length);
    },
  },
];
