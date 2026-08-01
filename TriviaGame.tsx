"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  fetchQuizData,
  isSelectionCorrect,
  LOGO_PATH,
  shuffled,
} from "./trivia-data";

type Category = {
  name: string;
  shortName: string;
  description: string;
  priority: number;
};

type Question = {
  category: string;
  multiAnswer: boolean;
  question: string;
  answers: string[];
  correctAnswers: string[];
  author: string;
};

type Phase = "categories" | "quiz" | "results";

export default function TriviaGame() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [activeQuestions, setActiveQuestions] = useState<Question[]>([]);
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);
  const [phase, setPhase] = useState<Phase>("categories");
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<string[]>([]);
  const [answerLocked, setAnswerLocked] = useState(false);
  const [lastAnswerCorrect, setLastAnswerCorrect] = useState(false);
  const [score, setScore] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetchQuizData()
      .then((data) => {
        if (cancelled) return;
        setCategories(data.categories);
        setQuestions(data.questions);

        const requested = new URLSearchParams(window.location.search).get("category");
        const matched = data.categories.find(
          (category) => category.shortName.toLowerCase() === requested?.toLowerCase(),
        );
        if (matched) {
          const pool = data.questions.filter((question) => question.category === matched.name);
          if (pool.length) {
            setActiveCategory(matched);
            setActiveQuestions(shuffled(pool));
            setPhase("quiz");
          }
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Unknown archive error.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const questionCounts = useMemo(
    () =>
      Object.fromEntries(
        categories.map((category) => [
          category.name,
          questions.filter((question) => question.category === category.name).length,
        ]),
      ),
    [categories, questions],
  );

  const currentQuestion = activeQuestions[questionIndex];

  function setCategoryInUrl(shortName?: string) {
    const url = new URL(window.location.href);
    if (shortName) url.searchParams.set("category", shortName);
    else url.searchParams.delete("category");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function startQuiz(category: Category) {
    const pool = questions.filter((question) => question.category === category.name);
    if (!pool.length) return;
    setActiveCategory(category);
    setActiveQuestions(shuffled(pool));
    setQuestionIndex(0);
    setSelectedAnswers([]);
    setAnswerLocked(false);
    setLastAnswerCorrect(false);
    setScore(0);
    setPhase("quiz");
    setCategoryInUrl(category.shortName);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function returnToCategories() {
    setPhase("categories");
    setActiveCategory(null);
    setActiveQuestions([]);
    setCategoryInUrl();
  }

  function toggleAnswer(answer: string) {
    if (answerLocked || !currentQuestion) return;
    if (!currentQuestion.multiAnswer) {
      setSelectedAnswers([answer]);
      return;
    }
    setSelectedAnswers((current) =>
      current.includes(answer)
        ? current.filter((selection) => selection !== answer)
        : [...current, answer],
    );
  }

  function submitAnswer() {
    if (!currentQuestion || !selectedAnswers.length || answerLocked) return;
    const correct = isSelectionCorrect(selectedAnswers, currentQuestion.correctAnswers);
    setLastAnswerCorrect(correct);
    setAnswerLocked(true);
    if (correct) setScore((current) => current + 1);
  }

  function advanceQuestion() {
    if (questionIndex + 1 >= activeQuestions.length) {
      setPhase("results");
      return;
    }
    setQuestionIndex((current) => current + 1);
    setSelectedAnswers([]);
    setAnswerLocked(false);
    setLastAnswerCorrect(false);
  }

  function renderStatus() {
    if (loading) {
      return (
        <section className="status-panel" aria-live="polite">
          <span className="status-pulse" />
          <p>Synchronizing with the knowledge archive…</p>
        </section>
      );
    }
    if (error) {
      return (
        <section className="status-panel error-panel" role="alert">
          <span className="eyebrow">Archive link interrupted</span>
          <h2>Trivia data unavailable</h2>
          <p>{error}</p>
          <button className="primary-button" onClick={() => window.location.reload()}>
            Retry connection
          </button>
        </section>
      );
    }
    return null;
  }

  return (
    <main className="site-shell">
      <div className="star-field" aria-hidden="true" />
      <header className="topbar">
        <button className="brand" type="button" onClick={returnToCategories} aria-label="Return to category selection">
          <Image
            src={LOGO_PATH}
            alt="Alliance of Galactic Travellers"
            width={43}
            height={43}
            priority
          />
          <span className="brand-copy">
            <strong>ALLIANCE</strong>
            <small>OF GALACTIC TRAVELLERS</small>
          </span>
        </button>
        <div className="network-status" aria-label="Archive network online">
          <span className="network-dot" />
          ARCHIVE NETWORK / ONLINE
        </div>
      </header>

      {loading || error ? (
        <div className="content-frame centered-frame">{renderStatus()}</div>
      ) : phase === "categories" ? (
        <div className="content-frame">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow"><span>AGT</span> KNOWLEDGE ARCHIVE</p>
              <h1>How far does your<br /><em>knowledge</em> travel?</h1>
              <p className="hero-description">
                Select a transmission channel and test what you know about the
                universe of No Man&apos;s Sky. Every answer adds to the archive.
              </p>
            </div>
            <div className="orbital-mark" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="planet" />
              <span>AGT // 16</span>
            </div>
          </section>

          <section className="category-section" aria-labelledby="category-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">AVAILABLE TRANSMISSIONS</p>
                <h2 id="category-title">Choose a category</h2>
              </div>
              <span>{String(categories.length).padStart(2, "0")} CHANNELS DETECTED</span>
            </div>
            <div className="category-grid">
              {categories.map((category, index) => {
                const count = questionCounts[category.name] ?? 0;
                return (
                  <button
                    className="category-card"
                    type="button"
                    key={category.shortName}
                    onClick={() => startQuiz(category)}
                    disabled={!count}
                  >
                    <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="card-code">{category.shortName}</span>
                    <strong>{category.name}</strong>
                    <span className="card-description">{category.description}</span>
                    <span className="card-footer">
                      {count} {count === 1 ? "question" : "questions"}
                      <span aria-hidden="true">↗</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : phase === "quiz" && currentQuestion ? (
        <div className="content-frame quiz-frame">
          <section className="quiz-heading">
            <button className="text-button" type="button" onClick={returnToCategories}>← All categories</button>
            <div className="quiz-meta">
              <span>{activeCategory?.shortName}</span>
              <strong>{activeCategory?.name}</strong>
            </div>
            <div className="score-readout"><span>SCORE</span><strong>{String(score).padStart(2, "0")}</strong></div>
          </section>

          <div className="progress-track" aria-label={`Question ${questionIndex + 1} of ${activeQuestions.length}`}>
            <span style={{ width: `${((questionIndex + 1) / activeQuestions.length) * 100}%` }} />
          </div>

          <section className="question-panel" aria-live="polite">
            <div className="question-number">TRANSMISSION {String(questionIndex + 1).padStart(2, "0")} / {String(activeQuestions.length).padStart(2, "0")}</div>
            <h1>{currentQuestion.question}</h1>
            <p className="selection-note">
              {currentQuestion.multiAnswer ? "Select every correct answer." : "Select one answer."}
            </p>
            <div className="answer-grid">
              {currentQuestion.answers.map((answer, index) => {
                const selected = selectedAnswers.includes(answer);
                const correct = currentQuestion.correctAnswers.includes(answer);
                const stateClass = answerLocked
                  ? correct
                    ? "is-correct"
                    : selected
                      ? "is-incorrect"
                      : ""
                  : selected
                    ? "is-selected"
                    : "";
                return (
                  <button
                    type="button"
                    className={`answer-option ${stateClass}`}
                    key={answer}
                    onClick={() => toggleAnswer(answer)}
                    aria-pressed={selected}
                    disabled={answerLocked}
                  >
                    <span>{String.fromCharCode(65 + index)}</span>
                    <strong>{answer}</strong>
                    <i aria-hidden="true" />
                  </button>
                );
              })}
            </div>

            {answerLocked ? (
              <div className={`feedback-panel ${lastAnswerCorrect ? "correct-feedback" : "incorrect-feedback"}`} role="status">
                <div>
                  <span className="eyebrow">{lastAnswerCorrect ? "SIGNAL CONFIRMED" : "SIGNAL CORRECTION"}</span>
                  <p>{lastAnswerCorrect ? "Archive match. Well travelled." : `Correct: ${currentQuestion.correctAnswers.join(" + ")}`}</p>
                </div>
                <button className="primary-button" type="button" onClick={advanceQuestion}>
                  {questionIndex + 1 === activeQuestions.length ? "View results" : "Next transmission"} <span>→</span>
                </button>
              </div>
            ) : (
              <div className="question-actions">
                <span>Submitted by {currentQuestion.author}</span>
                <button className="primary-button" type="button" onClick={submitAnswer} disabled={!selectedAnswers.length}>
                  Confirm answer <span>→</span>
                </button>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="content-frame results-frame">
          <section className="results-panel">
            <div className="result-rings" aria-hidden="true"><span>{score}</span><small>/{activeQuestions.length}</small></div>
            <p className="eyebrow">TRANSMISSION COMPLETE</p>
            <h1>{score === activeQuestions.length ? "Atlas-grade recall." : score / activeQuestions.length >= 0.6 ? "A seasoned Traveller." : "The archive awaits your return."}</h1>
            <p>You matched {score} of {activeQuestions.length} signals in <strong>{activeCategory?.name}</strong>.</p>
            <div className="result-actions">
              {activeCategory && <button className="primary-button" type="button" onClick={() => startQuiz(activeCategory)}>Run again ↻</button>}
              <button className="secondary-button" type="button" onClick={returnToCategories}>Choose another category</button>
            </div>
          </section>
        </div>
      )}

      <footer className="site-footer">
        <span>AGT KNOWLEDGE SYSTEMS</span>
        <span>TRAVELLERS CONNECTED ACROSS THE GALAXY</span>
        <span>ARCHIVE // 2026</span>
      </footer>
    </main>
  );
}
