import "./styles.css";
import { APP_CONFIG } from "./config.js";
import { loadQuizData } from "./lib/csv.js";
import {
  isCorrectSelection,
  questionsForCategory,
  questionsForQuiz,
  sortCategories,
} from "./lib/quiz.js";

const app = document.querySelector("#app");

const state = {
  categories: [],
  questions: [],
  activeCategory: null,
  activeQuestions: [],
  quizLength: null,
  questionIndex: 0,
  selectedAnswers: new Set(),
  answered: false,
  lastAnswerCorrect: false,
  score: 0,
  loading: true,
  error: "",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shell(content) {
  return `
    <div class="starfield" aria-hidden="true"></div>
    <header class="site-header">
      <button class="brand" type="button" data-action="home" aria-label="Return to category selection">
        <img class="brand__logo" src="${escapeHtml(APP_CONFIG.logoPath)}" alt="" />
        <span>
          <strong>AGT</strong>
          <small>Galactic Trivia Network</small>
        </span>
      </button>
      <div class="signal" aria-label="Network status: online">
        <span aria-hidden="true"></span>
        Network online
      </div>
    </header>
    <main id="main-content" class="app-shell" tabindex="-1">
      ${content}
    </main>
    <footer>
      <span>© ${new Date().getFullYear()}, Alliance of Galactic Travellers</span>
    </footer>
  `;
}

function loadingView() {
  return shell(`
    <section class="panel status-panel" aria-live="polite">
      <div class="loader" aria-hidden="true"></div>
      <p class="eyebrow">Synchronizing archives</p>
      <h1>Opening the knowledge uplink…</h1>
      <p>Retrieving the latest categories and questions.</p>
    </section>
  `);
}

function errorView() {
  return shell(`
    <section class="panel status-panel" role="alert">
      <div class="status-icon status-icon--error" aria-hidden="true">!</div>
      <p class="eyebrow">Uplink interrupted</p>
      <h1>Trivia data could not be loaded</h1>
      <p>${escapeHtml(state.error)}</p>
      <button class="button button--primary" type="button" data-action="reload">
        Retry connection
      </button>
    </section>
  `);
}

function categoryView() {
  const categories = sortCategories(state.categories);
  const cards = categories
    .map((category, index) => {
      const questionCount = questionsForCategory(
        state.questions,
        category.name,
      ).length;
      const isDisabled = questionCount === 0;

      return `
        <button
          class="category-card"
          type="button"
          data-category="${escapeHtml(category.shortName)}"
          ${isDisabled ? "disabled" : ""}
        >
          <span class="category-card__index">${String(index + 1).padStart(2, "0")}</span>
          <span class="category-card__body">
            <span class="category-card__meta">
              ${escapeHtml(category.shortName)} · ${questionCount} ${questionCount === 1 ? "question" : "questions"}
            </span>
            <strong>${escapeHtml(category.name)}</strong>
            <span>${escapeHtml(category.description)}</span>
          </span>
          <span class="category-card__arrow" aria-hidden="true">→</span>
        </button>
      `;
    })
    .join("");

  return shell(`
    <section aria-labelledby="category-heading">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Available channels</p>
          <h2 id="category-heading">Choose a category</h2>
        </div>
        <span>${state.questions.length} questions indexed</span>
      </div>
      <div class="category-grid">${cards}</div>
    </section>
  `);
}

function quizLengthView() {
  const questionCount = questionsForCategory(
    state.questions,
    state.activeCategory.name,
  ).length;
  const choices = [
    {
      value: "10",
      label: "Short quiz",
      meta: "10 questions",
      description: "A quick run of up to 10 randomly selected questions.",
    },
    {
      value: "30",
      label: "Long quiz",
      meta: "30 questions",
      description: "An extended run of up to 30 randomly selected questions.",
    },
    {
      value: "all",
      label: "Full quiz",
      meta: `All ${questionCount} ${questionCount === 1 ? "question" : "questions"}`,
      description: "Complete every available question in this category.",
    },
  ];
  const cards = choices
    .map(
      (choice, index) => `
        <button
          class="category-card"
          type="button"
          data-quiz-length="${choice.value}"
        >
          <span class="category-card__index">${String(index + 1).padStart(2, "0")}</span>
          <span class="category-card__body">
            <span class="category-card__meta">${choice.meta}</span>
            <strong>${choice.label}</strong>
            <span>${choice.description}</span>
          </span>
          <span class="category-card__arrow" aria-hidden="true">→</span>
        </button>
      `,
    )
    .join("");

  return shell(`
    <section class="quiz-header">
      <button class="text-button" type="button" data-action="categories">← Categories</button>
      <div class="quiz-header__score">
        ${escapeHtml(state.activeCategory.shortName)}
      </div>
    </section>
    <section aria-labelledby="quiz-length-heading">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(state.activeCategory.name)}</p>
          <h1 id="quiz-length-heading">Choose quiz length</h1>
        </div>
        <span>${questionCount} ${questionCount === 1 ? "question" : "questions"} available</span>
      </div>
      <div class="category-grid">${cards}</div>
    </section>
  `);
}

function answerClass(answer, question) {
  if (!state.answered) return "";
  if (question.correctAnswers.includes(answer)) return "answer--correct";
  if (state.selectedAnswers.has(answer)) return "answer--incorrect";
  return "answer--muted";
}

function quizView() {
  const question = state.activeQuestions[state.questionIndex];
  const progress = ((state.questionIndex + 1) / state.activeQuestions.length) * 100;
  const inputType = question.isMultiAnswer ? "checkbox" : "radio";
  const selectionHint = question.isMultiAnswer
    ? "Select every correct answer"
    : "Select one answer";
  const answers = question.answers
    .map(
      (answer, index) => `
        <label class="answer ${answerClass(answer, question)}">
          <input
            type="${inputType}"
            name="answer"
            value="${index}"
            ${state.selectedAnswers.has(answer) ? "checked" : ""}
            ${state.answered ? "disabled" : ""}
          />
          <span class="answer__marker" aria-hidden="true">${String.fromCharCode(65 + index)}</span>
          <span class="answer__text">${escapeHtml(answer)}</span>
          <span class="answer__status" aria-hidden="true"></span>
        </label>
      `,
    )
    .join("");

  const feedbackMessage = state.lastAnswerCorrect
    ? "Signal accepted. Your score has been updated."
    : `Correct answer${question.correctAnswers.length > 1 ? "s" : ""}: ${escapeHtml(question.correctAnswers.join(", "))}`;
  const feedback = state.answered
    ? `
      <div class="feedback ${state.lastAnswerCorrect ? "feedback--correct" : "feedback--incorrect"}" role="status">
        <strong>${state.lastAnswerCorrect ? "Archive match confirmed" : "Archive mismatch"}</strong>
        <span>${feedbackMessage}</span>
      </div>
    `
    : "";

  return shell(`
    <section class="quiz-header">
      <button class="text-button" type="button" data-action="categories">← Categories</button>
      <div class="quiz-header__score">
        Score <strong>${state.score}</strong>
      </div>
    </section>
    <section class="panel quiz-panel">
      <div class="quiz-meta">
        <span>${escapeHtml(state.activeCategory.shortName)}</span>
        <span>Question ${state.questionIndex + 1} / ${state.activeQuestions.length}</span>
      </div>
      <div class="progress" aria-label="Quiz progress">
        <span style="width: ${progress}%"></span>
      </div>
      <p class="selection-hint">${selectionHint}</p>
      <h1 class="question">${escapeHtml(question.prompt)}</h1>
      <form id="answer-form">
        <fieldset>
          <legend class="visually-hidden">Possible answers</legend>
          <div class="answer-list">${answers}</div>
        </fieldset>
        ${feedback}
        <div class="quiz-actions">
          ${question.author ? `<span>Submitted by ${escapeHtml(question.author)}</span>` : "<span>Alliance archive</span>"}
          <button
            class="button button--primary"
            type="submit"
            ${state.selectedAnswers.size === 0 ? "disabled" : ""}
          >
            ${state.answered ? (state.questionIndex === state.activeQuestions.length - 1 ? "View results" : "Next question") : "Lock answer"}
          </button>
        </div>
      </form>
    </section>
  `);
}

function resultsView() {
  const total = state.activeQuestions.length;
  const percent = Math.round((state.score / total) * 100);
  let rank = "Pathfinder";
  if (percent === 100) rank = "Atlas Archivist";
  else if (percent >= 75) rank = "Galactic Cartographer";
  else if (percent >= 50) rank = "Seasoned Traveller";

  return shell(`
    <section class="panel results-panel">
      <div class="result-orbit" style="--score: ${percent}" aria-label="Score: ${percent} percent">
        <div>
          <strong>${state.score}<small>/${total}</small></strong>
          <span>correct</span>
        </div>
      </div>
      <div class="results-copy">
        <p class="eyebrow">Transmission complete</p>
        <h1>${escapeHtml(rank)}</h1>
        <p>
          You completed <strong>${escapeHtml(state.activeCategory.name)}</strong>
          with a ${percent}% archive match.
        </p>
        <div class="result-actions">
          <button class="button button--primary" type="button" data-action="replay">Replay category</button>
          <button class="button button--secondary" type="button" data-action="categories">Choose another</button>
        </div>
      </div>
    </section>
  `);
}

function render() {
  if (state.loading) app.innerHTML = loadingView();
  else if (state.error) app.innerHTML = errorView();
  else if (!state.activeCategory) app.innerHTML = categoryView();
  else if (!state.quizLength) app.innerHTML = quizLengthView();
  else if (state.questionIndex >= state.activeQuestions.length) {
    app.innerHTML = resultsView();
  } else app.innerHTML = quizView();

  bindEvents();
}

function updateCategoryUrl(shortName) {
  const url = new URL(window.location.href);
  if (shortName) url.searchParams.set("category", shortName);
  else url.searchParams.delete("category");
  window.history.pushState({}, "", url);
}

function startCategory(shortName, updateUrl = true) {
  const category = state.categories.find(
    (item) =>
      item.shortName.toLocaleLowerCase() === shortName.toLocaleLowerCase(),
  );
  if (!category) return false;

  const questions = questionsForCategory(state.questions, category.name);
  if (!questions.length) return false;

  state.activeCategory = category;
  state.activeQuestions = [];
  state.quizLength = null;
  state.questionIndex = 0;
  state.selectedAnswers = new Set();
  state.answered = false;
  state.score = 0;
  if (updateUrl) updateCategoryUrl(category.shortName);
  render();
  document.querySelector("#main-content")?.focus();
  return true;
}

function startQuiz(length) {
  if (!state.activeCategory || !["10", "30", "all"].includes(length)) {
    return false;
  }

  const questions = questionsForCategory(
    state.questions,
    state.activeCategory.name,
  );
  const questionCount = length === "all" ? undefined : Number(length);
  const activeQuestions = questionsForQuiz(questions, questionCount);
  if (!activeQuestions.length) return false;

  state.activeQuestions = activeQuestions;
  state.quizLength = length;
  state.questionIndex = 0;
  state.selectedAnswers = new Set();
  state.answered = false;
  state.lastAnswerCorrect = false;
  state.score = 0;
  render();
  document.querySelector("#main-content")?.focus();
  return true;
}

function showCategories() {
  state.activeCategory = null;
  state.activeQuestions = [];
  state.quizLength = null;
  state.questionIndex = 0;
  state.selectedAnswers = new Set();
  state.answered = false;
  updateCategoryUrl("");
  render();
  document.querySelector("#main-content")?.focus();
}

function submitAnswer(event) {
  event.preventDefault();

  if (state.answered) {
    state.questionIndex += 1;
    state.selectedAnswers = new Set();
    state.answered = false;
    render();
    document.querySelector(".question, .results-panel h1")?.focus?.();
    return;
  }

  if (!state.selectedAnswers.size) return;

  const question = state.activeQuestions[state.questionIndex];
  state.lastAnswerCorrect = isCorrectSelection(
    [...state.selectedAnswers],
    question.correctAnswers,
  );
  if (state.lastAnswerCorrect) state.score += 1;
  state.answered = true;
  render();
  document.querySelector(".feedback")?.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
  });
}

function bindEvents() {
  document.querySelectorAll("[data-action='home'], [data-action='categories']")
    .forEach((button) => button.addEventListener("click", showCategories));

  document.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => startCategory(button.dataset.category));
  });
  document.querySelectorAll("[data-quiz-length]").forEach((button) => {
    button.addEventListener("click", () => startQuiz(button.dataset.quizLength));
  });

  document.querySelector("[data-action='reload']")?.addEventListener("click", init);
  document.querySelector("[data-action='replay']")?.addEventListener("click", () => {
    startQuiz(state.quizLength);
  });

  const form = document.querySelector("#answer-form");
  form?.addEventListener("submit", submitAnswer);
  form?.addEventListener("change", (event) => {
    const question = state.activeQuestions[state.questionIndex];
    const answer = question.answers[Number(event.target.value)];

    if (question.isMultiAnswer) {
      if (event.target.checked) state.selectedAnswers.add(answer);
      else state.selectedAnswers.delete(answer);
    } else {
      state.selectedAnswers = new Set([answer]);
    }

    const submitButton = form.querySelector("button[type='submit']");
    submitButton.disabled = state.selectedAnswers.size === 0;
  });
}

async function init() {
  state.loading = true;
  state.error = "";
  render();

  try {
    const data = await loadQuizData(
      APP_CONFIG.categoriesCsvUrl,
      APP_CONFIG.questionsCsvUrl,
    );
    state.categories = data.categories;
    state.questions = data.questions;
    state.loading = false;
    render();

    const requestedCategory = new URLSearchParams(window.location.search).get(
      "category",
    );
    if (requestedCategory) startCategory(requestedCategory, false);
  } catch (error) {
    state.loading = false;
    state.error = error instanceof Error ? error.message : "Unexpected data error.";
    render();
  }
}

window.addEventListener("popstate", () => {
  const requestedCategory = new URLSearchParams(window.location.search).get(
    "category",
  );
  if (requestedCategory) startCategory(requestedCategory, false);
  else {
    state.activeCategory = null;
    state.activeQuestions = [];
    state.quizLength = null;
    render();
  }
});

init();
