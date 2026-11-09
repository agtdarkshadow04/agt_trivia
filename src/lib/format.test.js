import { describe, expect, it } from "vitest";
import { escapeHtml, pluralize, rankForPercent } from "./format.js";

describe("formatting helpers", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#039;s&lt;/a&gt;",
    );
    expect(escapeHtml(42)).toBe("42");
  });

  it("pluralizes counts", () => {
    expect(pluralize(1, "question")).toBe("1 question");
    expect(pluralize(0, "question")).toBe("0 questions");
    expect(pluralize(3, "quiz", "quizzes")).toBe("3 quizzes");
  });

  it("maps score percentages to ranks", () => {
    expect(rankForPercent(100)).toBe("Atlas Archivist");
    expect(rankForPercent(75)).toBe("Galactic Cartographer");
    expect(rankForPercent(50)).toBe("Seasoned Traveller");
    expect(rankForPercent(49)).toBe("Pathfinder");
  });
});
