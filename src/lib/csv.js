import Papa from "papaparse";

const CATEGORY_HEADERS = ["catName", "catNameShort", "catDesc", "catPriority"];
const QUESTION_HEADERS = [
  "category",
  "isMultiAnswer",
  "question",
  "answers",
  "correctAnswer",
  "author",
];

function parseRows(csvText, requiredHeaders, sourceName) {
  const result = Papa.parse(csvText.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });

  const missingHeaders = requiredHeaders.filter(
    (header) => !result.meta.fields?.includes(header),
  );

  if (missingHeaders.length) {
    throw new Error(
      `${sourceName} is missing required column${missingHeaders.length === 1 ? "" : "s"}: ${missingHeaders.join(", ")}.`,
    );
  }

  if (result.errors.length) {
    const firstError = result.errors[0];
    throw new Error(
      `${sourceName} could not be parsed${Number.isInteger(firstError.row) ? ` near row ${firstError.row + 2}` : ""}: ${firstError.message}`,
    );
  }

  return result.data;
}

function clean(value) {
  return String(value ?? "").trim();
}

function parseBoolean(value, rowNumber) {
  const normalized = clean(value).toLowerCase();
  if (!["true", "false", "1", "0", "yes", "no"].includes(normalized)) {
    throw new Error(
      `Questions CSV row ${rowNumber} has an invalid isMultiAnswer value.`,
    );
  }
  return ["true", "1", "yes"].includes(normalized);
}

function parseAnswerList(value) {
  return clean(value)
    .split(",")
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function ensureUnique(values, errorMessage) {
  const normalized = values.map((value) => value.toLocaleLowerCase());
  if (new Set(normalized).size !== values.length) {
    throw new Error(errorMessage);
  }
}

export function parseCategories(csvText) {
  const rows = parseRows(csvText, CATEGORY_HEADERS, "Categories CSV");
  const categories = rows.map((row, index) => {
    const rowNumber = index + 2;
    const name = clean(row.catName);
    const shortName = clean(row.catNameShort);
    const description = clean(row.catDesc);
    const priorityText = clean(row.catPriority);
    const priority = Number(priorityText);

    if (!name || !shortName || !description || !priorityText) {
      throw new Error(
        `Categories CSV row ${rowNumber} requires catName, catNameShort, catDesc, and catPriority.`,
      );
    }

    if (!Number.isFinite(priority) || priority < 0 || priority > 100) {
      throw new Error(
        `Categories CSV row ${rowNumber} has a catPriority outside 0-100.`,
      );
    }

    return { name, shortName, description, priority };
  });

  ensureUnique(
    categories.map((category) => category.name),
    "Categories CSV has duplicate catName values.",
  );
  ensureUnique(
    categories.map((category) => category.shortName),
    "Categories CSV has duplicate catNameShort values.",
  );

  return categories;
}

export function parseQuestions(csvText) {
  const rows = parseRows(csvText, QUESTION_HEADERS, "Questions CSV");

  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const category = clean(row.category);
    const prompt = clean(row.question);
    const author = clean(row.author);
    const answers = parseAnswerList(row.answers);
    const suppliedCorrectAnswers = parseAnswerList(row.correctAnswer);
    const isMultiAnswer = parseBoolean(row.isMultiAnswer, rowNumber);

    if (!category || !prompt) {
      throw new Error(
        `Questions CSV row ${rowNumber} requires category and question.`,
      );
    }

    if (answers.length < 2 || answers.length > 4) {
      throw new Error(
        `Questions CSV row ${rowNumber} must contain between 2 and 4 answers.`,
      );
    }

    ensureUnique(
      answers,
      `Questions CSV row ${rowNumber} has duplicate answers.`,
    );

    if (!suppliedCorrectAnswers.length) {
      throw new Error(
        `Questions CSV row ${rowNumber} requires at least one correctAnswer.`,
      );
    }

    const correctAnswers = suppliedCorrectAnswers.map((correctAnswer) => {
      const match = answers.find(
        (answer) =>
          answer.toLocaleLowerCase() === correctAnswer.toLocaleLowerCase(),
      );

      if (!match) {
        throw new Error(
          `Questions CSV row ${rowNumber} lists a correctAnswer that is not in answers.`,
        );
      }

      return match;
    });

    ensureUnique(
      correctAnswers,
      `Questions CSV row ${rowNumber} has duplicate correct answers.`,
    );

    if (isMultiAnswer !== (correctAnswers.length > 1)) {
      throw new Error(
        `Questions CSV row ${rowNumber} has inconsistent isMultiAnswer and correctAnswer values.`,
      );
    }

    return {
      category,
      isMultiAnswer,
      prompt,
      answers,
      correctAnswers,
      author,
    };
  });
}

export function validateQuestionCategories(categories, questions) {
  const categoryNames = new Set(
    categories.map((category) => category.name.toLocaleLowerCase()),
  );
  const unknownCategory = questions.find(
    (question) => !categoryNames.has(question.category.toLocaleLowerCase()),
  );

  if (unknownCategory) {
    throw new Error(
      `Question category “${unknownCategory.category}” does not match any catName in the Categories CSV.`,
    );
  }
}

async function fetchCsv(url, label) {
  let response;

  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error(
      `${label} could not be reached. Check its URL and cross-origin access settings.`,
    );
  }

  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }

  return response.text();
}

export async function loadQuizData(categoriesUrl, questionsUrl) {
  const [categoriesCsv, questionsCsv] = await Promise.all([
    fetchCsv(categoriesUrl, "Categories CSV"),
    fetchCsv(questionsUrl, "Questions CSV"),
  ]);
  const categories = parseCategories(categoriesCsv);
  const questions = parseQuestions(questionsCsv);

  validateQuestionCategories(categories, questions);
  return { categories, questions };
}
