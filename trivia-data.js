export const DATA_PATHS = {
  categories: "/data/categories.csv",
  questions: "/data/questions.csv",
};

export const LOGO_PATH = "/agt-logo-placeholder.svg";

function detectDelimiter(text) {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  return (header.match(/\t/g) ?? []).length >
    (header.match(/,/g) ?? []).length
    ? "\t"
    : ",";
}

export function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("CSV does not contain any data rows.");

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, ""));
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function requireColumns(rows, columns, label) {
  const firstRow = rows[0] ?? {};
  const missing = columns.filter((column) => !(column in firstRow));
  if (missing.length) {
    throw new Error(`${label} CSV is missing: ${missing.join(", ")}.`);
  }
}

function splitAnswers(value) {
  return value
    .split(",")
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function normalize(value) {
  return value.trim().toLocaleLowerCase();
}

export function parseCategories(text) {
  const rows = parseCsv(text);
  requireColumns(
    rows,
    ["catName", "catNameShort", "catDesc", "catPriority"],
    "Categories",
  );

  return rows
    .map((row, index) => {
      const priority = Number(row.catPriority);
      if (!row.catName || !row.catNameShort) {
        throw new Error(`Categories CSV row ${index + 2} needs a name and short name.`);
      }
      if (!Number.isFinite(priority) || priority < 0 || priority > 100) {
        throw new Error(`Categories CSV row ${index + 2} has an invalid priority.`);
      }
      return {
        name: row.catName,
        shortName: row.catNameShort,
        description: row.catDesc,
        priority,
      };
    })
    .sort(
      (first, second) =>
        first.priority - second.priority || first.name.localeCompare(second.name),
    );
}

export function parseQuestions(text) {
  const rows = parseCsv(text);
  requireColumns(
    rows,
    ["category", "isMultiAnswer", "question", "answers", "correctAnswer", "author"],
    "Questions",
  );

  return rows.map((row, index) => {
    const answers = splitAnswers(row.answers);
    const correctAnswers = splitAnswers(row.correctAnswer);
    const answerSet = new Set(answers.map(normalize));

    if (!row.category || !row.question || answers.length < 2 || !correctAnswers.length) {
      throw new Error(`Questions CSV row ${index + 2} is incomplete.`);
    }
    if (answers.length > 4) {
      throw new Error(`Questions CSV row ${index + 2} contains more than four answers.`);
    }
    if (correctAnswers.some((answer) => !answerSet.has(normalize(answer)))) {
      throw new Error(`Questions CSV row ${index + 2} has a correct answer not in its answer list.`);
    }

    return {
      category: row.category,
      multiAnswer: /^(true|1|yes)$/i.test(row.isMultiAnswer),
      question: row.question,
      answers,
      correctAnswers,
      author: row.author || "Unknown Traveller",
    };
  });
}

export async function fetchQuizData() {
  const [categoryResponse, questionResponse] = await Promise.all([
    fetch(DATA_PATHS.categories),
    fetch(DATA_PATHS.questions),
  ]);

  if (!categoryResponse.ok || !questionResponse.ok) {
    throw new Error("The trivia archives could not be reached.");
  }

  const [categoryText, questionText] = await Promise.all([
    categoryResponse.text(),
    questionResponse.text(),
  ]);
  const categories = parseCategories(categoryText);
  const questions = parseQuestions(questionText);
  const knownCategories = new Set(categories.map((category) => category.name));
  const orphan = questions.find((question) => !knownCategories.has(question.category));

  if (orphan) {
    throw new Error(`Question category not found: ${orphan.category}.`);
  }

  return { categories, questions };
}

export function isSelectionCorrect(selectedAnswers, correctAnswers) {
  const selected = new Set(selectedAnswers.map(normalize));
  const correct = new Set(correctAnswers.map(normalize));
  return selected.size === correct.size && [...selected].every((answer) => correct.has(answer));
}

export function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
