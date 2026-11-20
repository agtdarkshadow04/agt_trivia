import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readCategories, readQuestions, splitAnswers } from './sheetImport.js';

/** Fixtures cut from the 1.x sheet's own CSV downloads (tests/fixtures/sheet/). */
const categoriesCsv = readFileSync('tests/fixtures/sheet/validCategories.csv', 'utf8');
const questionsCsv = readFileSync('tests/fixtures/sheet/pendingQuestions.csv', 'utf8');
const header = 'category,isApproved,adminNotes,isMultiAnswer,question,answers,correctAnswer,author';
const where = (problems: { code: string; params?: Record<string, unknown> }[]) => problems.map((problem) => [problem.params?.row, problem.params?.column, problem.code]);

describe('reading the sheet\'s CSV downloads (#22)', () => {
  it('reads validCategories, ignoring catTheme and adminNotes', () => {
    const { categories, problems } = readCategories(categoriesCsv);
    assert.deepEqual(problems, []);
    assert.deepEqual(categories.map(({ row, name, shortName, priority }) => [row, name, shortName, priority]), [
      [2, 'Alliance of Galactic Travellers', 'AGT', 0], [3, 'Hyades Travellers Foundation', 'HTF', 0], [4, "No Man's Sky", 'NMS', 10],
    ]);
    // A quoted description with commas.
    assert.equal(categories[2].description, "Answer questions related the game's lore, mechanics, and history.");
  });

  it('reads pendingQuestions: quoted commas, answers split on commas with or without spaces, multi-answer, empty rows skipped', () => {
    const { questions, problems } = readQuestions(questionsCsv);
    assert.deepEqual(problems, []);
    // 11 questions; the rows Google exports as ",FALSE,,,,,," and ",,,,,,," are skipped.
    assert.equal(questions.length, 11);
    assert.deepEqual(questions[0], {
      row: 2, category: 'Hyades Travellers Foundation', approved: true, prompt: 'Who is the founder of the HTF?',
      choices: [{ text: 'Bufalo04', isCorrect: true }, { text: 'Celab99', isCorrect: false }, { text: 'Patholas', isCorrect: false }, { text: 'IGravemind', isCorrect: false }],
      authorCredit: 'AGTDarkShadow04', reviewNote: '',
    });
    assert.deepEqual(questions[5].choices.map((choice) => choice.text), ['2', '3', '4', '5']);
    assert.deepEqual(questions[6].choices.filter((choice) => choice.isCorrect).map((choice) => choice.text), ['Alliance of Galactic Travellers', 'Intergalactic Travellers Foundation']);
    assert.equal(questions[9].prompt, 'Who created the official, current version of the AGT logo?');
    assert.deepEqual(splitAnswers(' a ,b,, c '), ['a', 'b', 'c']);
  });

  it('matches correct answers ignoring case, maps FALSE to pending, and keeps the note and credit', () => {
    const { questions } = readQuestions(`${header}\nLore,FALSE,NEEDS APPROVAL,TRUE,Pick two,"Alpha, Beta, Gamma","alpha, GAMMA",Luna`);
    assert.equal(questions[0].approved, false);
    assert.equal(questions[0].reviewNote, 'NEEDS APPROVAL');
    assert.deepEqual(questions[0].choices.map((choice) => choice.isCorrect), [true, false, true]);
  });

  it('names the file, row and column of every bad row, and reads the good ones', () => {
    const csv = [
      header,
      'Lore,maybe,,FALSE,Q1,"A, B",A,x',
      ',TRUE,,FALSE,,"A",C,x',
      'Lore,TRUE,,FALSE,Q3,"A, B, A",A,x',
      'Lore,TRUE,,TRUE,Q4,"A, B",A,x',
      'Lore,TRUE,,FALSE,Q5,"A, B",B,x',
    ].join('\n');
    const { questions, problems } = readQuestions(csv);
    assert.deepEqual(questions.map((question) => question.row), [6]);
    assert.deepEqual(where(problems), [
      [2, 'isApproved', 'invalid_format'],
      [3, 'category', 'required'], [3, 'correctAnswer', 'not_allowed'], [3, 'question', 'required'], [3, 'answers', 'too_few'],
      // "A" twice: both copies are correct, so the row also contradicts isMultiAnswer.
      [4, 'answers', 'duplicate'], [4, 'isMultiAnswer', 'mismatch'],
      [5, 'isMultiAnswer', 'mismatch'],
    ]);
    assert.match(problems[0].message, /^questions\.csv row 2, isApproved: /);
    assert.equal(problems[0].field, 'questions');
  });

  it('reports a missing column, a broken quote, and categories that repeat a name or are invalid', () => {
    assert.deepEqual(where(readQuestions('category,question\nx,y').problems).map((entry) => entry[1]), ['isApproved', 'adminNotes', 'isMultiAnswer', 'answers', 'correctAnswer', 'author']);
    assert.deepEqual(where(readQuestions(`${header}\n"broken,`).problems), [[2, undefined, 'invalid_format']]);
    const { categories, problems } = readCategories('catName,catNameShort,catDesc,catPriority\nA,a,d,0\na,b,d,0\nB,with space,d,101\nC,A,d,1');
    assert.deepEqual(categories.map((category) => category.name), ['A']);
    assert.deepEqual(where(problems), [[3, 'catName', 'duplicate'], [4, 'catNameShort', 'invalid_format'], [4, 'catPriority', 'out_of_range'], [5, 'catNameShort', 'duplicate']]);
  });
});
