import { describe, expect, it } from "vitest";
import {
  isCorrectSelection,
  questionsForCategory,
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
