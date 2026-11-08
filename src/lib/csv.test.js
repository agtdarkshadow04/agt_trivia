import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseCategories,
  parseQuestions,
  validateQuestionCategories,
} from "./csv.js";

describe("CSV parsing", () => {
  it("loads the bundled category and question data", () => {
    const categoriesCsv = readFileSync(
      new URL("../../public/data/categories.csv", import.meta.url),
      "utf8",
    );
    const questionsCsv = readFileSync(
      new URL("../../public/data/questions.csv", import.meta.url),
      "utf8",
    );
    const categories = parseCategories(categoriesCsv);
    const questions = parseQuestions(questionsCsv);

    expect(() => validateQuestionCategories(categories, questions)).not.toThrow();
    expect(categories.length).toBeGreaterThan(0);
    expect(questions.length).toBeGreaterThan(0);
  });

  it("maps category fields while ignoring administrative columns", () => {
    const categories = parseCategories(
      "catName,catNameShort,catDesc,catPriority,adminNotes\nLore,LORE,Stories,20,Private note",
    );

    expect(categories).toEqual([
      {
        name: "Lore",
        shortName: "LORE",
        description: "Stories",
        priority: 20,
      },
    ]);
  });

  it("parses quoted answer lists and multiple correct answers", () => {
    const questions = parseQuestions(
      'category,isApproved,adminNotes,isMultiAnswer,question,answers,correctAnswer,author\nLore,true,,true,Choose two,"Alpha,Beta,Gamma","Alpha,Gamma",Luna',
    );

    expect(questions[0]).toMatchObject({
      category: "Lore",
      isMultiAnswer: true,
      answers: ["Alpha", "Beta", "Gamma"],
      correctAnswers: ["Alpha", "Gamma"],
      author: "Luna",
    });
  });

  it("rejects a correct answer missing from the available answers", () => {
    expect(() =>
      parseQuestions(
        'category,isApproved,adminNotes,isMultiAnswer,question,answers,correctAnswer,author\nLore,true,,false,Choose one,"Alpha,Gamma",Beta,Luna',
      ),
    ).toThrow("not in answers");
  });

  it("rejects invalid multi-answer flags", () => {
    expect(() =>
      parseQuestions(
        "category,isApproved,adminNotes,isMultiAnswer,question,answers,correctAnswer,author\nLore,true,,sometimes,Choose one,Alpha,Alpha,Luna",
      ),
    ).toThrow("invalid isMultiAnswer");
  });

  it("rejects questions assigned to an unknown category", () => {
    expect(() =>
      validateQuestionCategories(
        [{ name: "Lore" }],
        [{ category: "Technology" }],
      ),
    ).toThrow("does not match any catName");
  });
});
