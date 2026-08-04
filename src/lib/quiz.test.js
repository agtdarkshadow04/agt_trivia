import { describe, expect, it } from "vitest";
import {
  isCorrectSelection,
  questionsForCategory,
  questionsForQuiz,
  shuffle,
  sortCategories,
} from "./quiz.js";

describe("quiz helpers", () => {
  it("sorts by ascending priority and then alphabetically", () => {
    const sorted = sortCategories([
      { name: "Technology", priority: 20 },
      { name: "Lore", priority: 10 },
      { name: "Exploration", priority: 10 },
    ]);

    expect(sorted.map((category) => category.name)).toEqual([
      "Exploration",
      "Lore",
      "Technology",
    ]);
  });

  it("matches question categories without case sensitivity", () => {
    const questions = [{ category: "Lore" }, { category: "Technology" }];
    expect(questionsForCategory(questions, "lore")).toEqual([questions[0]]);
  });

  it("selects short, long, and full quizzes from the category questions", () => {
    const questions = Array.from({ length: 35 }, (_, index) => index);

    expect(questionsForQuiz(questions, 10, () => 0)).toHaveLength(10);
    expect(questionsForQuiz(questions, 30, () => 0)).toHaveLength(30);
    expect(questionsForQuiz(questions, undefined, () => 0)).toHaveLength(35);
    expect(questions).toEqual(Array.from({ length: 35 }, (_, index) => index));
  });

  it("uses every available question when a requested length is longer", () => {
    expect(questionsForQuiz([1, 2, 3], 10, () => 0)).toHaveLength(3);
  });

  it("requires an exact answer set for multi-answer questions", () => {
    expect(isCorrectSelection(["Gek", "Korvax"], ["Korvax", "Gek"])).toBe(true);
    expect(isCorrectSelection(["Gek"], ["Korvax", "Gek"])).toBe(false);
    expect(
      isCorrectSelection(["Gek", "Korvax", "Vy'keen"], ["Korvax", "Gek"]),
    ).toBe(false);
  });

  it("shuffles a copy without mutating the input", () => {
    const original = [1, 2, 3];
    expect(shuffle(original, () => 0)).toEqual([2, 3, 1]);
    expect(original).toEqual([1, 2, 3]);
  });
});

