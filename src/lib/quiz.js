export function sortCategories(categories) {
  return [...categories].sort(
    (first, second) =>
      first.priority - second.priority ||
      first.name.localeCompare(second.name, undefined, { sensitivity: "base" }),
  );
}

export function questionsForCategory(questions, categoryName) {
  return questions.filter(
    (question) =>
      question.category.toLocaleLowerCase() === categoryName.toLocaleLowerCase(),
  );
}

export function shuffle(items, random = Math.random) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[targetIndex]] = [
      shuffled[targetIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

export function isCorrectSelection(selectedAnswers, correctAnswers) {
  if (selectedAnswers.length !== correctAnswers.length) {
    return false;
  }

  const normalizedCorrectAnswers = new Set(
    correctAnswers.map((answer) => answer.toLocaleLowerCase()),
  );
  return selectedAnswers.every((answer) =>
    normalizedCorrectAnswers.has(answer.toLocaleLowerCase()),
  );
}
