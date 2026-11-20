import { useCallback, useEffect, useState } from 'react';
import type { MemberSession, PublicCategory, PublicQuiz, PublicSettings, QuizLength } from './lib/api';
import { getMemberSession, getPublicSettings, getQuestionCounts, getQuiz, listCategories } from './lib/playerApi';
import { canAuthor } from './lib/questionRules';
import { choose, isFinished, lockAnswer, nextQuestion, startSession, type QuizSession } from './lib/quizSession';
import { categoryParam, findCategory, pageParam, searchForPage, searchWithCategory, type Page } from './lib/routes';
import { COMMON_TRANSLATIONS, formatTranslation } from './translations';
import { CategoryList } from './components/CategoryList';
import { useI18n } from './components/I18n';
import { RefreshIcon } from './components/Icons';
import { Layout } from './components/Layout';
import { SignIn } from './components/MemberAccount';
import { BackToCategories, LengthChoice, QuestionView, Results } from './components/QuizPlay';
import { QuestionWorkshop } from './components/QuestionWorkshop';
import { CategoryManager } from './components/CategoryManager';
import { SaveResult, ScoresPage } from './components/ScoreHistory';

type Data =
  | { status: 'loading' }
  | { status: 'error'; cause: unknown }
  | { status: 'ready'; settings: PublicSettings; categories: PublicCategory[] };

/** The quiz of the chosen category: none yet (choose a length), loading, failed, or being played. */
type Play =
  | null
  | { status: 'loading'; length: QuizLength }
  | { status: 'error'; length: QuizLength; cause: unknown }
  | { status: 'playing'; length: QuizLength; quiz: PublicQuiz; session: QuizSession };

/** A visible loading or error state with a retry (FE-5, A11Y-4). */
function LoadState({ message, cause, onRetry }: { message: string; cause?: unknown; onRetry?(): void }) {
  const { t, error } = useI18n();
  if (cause === undefined) {
    return <section className="status-panel" role="status"><span className="loader" aria-hidden="true" /><p>{message}</p></section>;
  }
  return (
    <section className="status-panel" role="alert">
      <p className="error-note">{error(cause)}</p>
      {onRetry && <button className="button button-primary button-with-icon" type="button" onClick={onRetry}><RefreshIcon />{t.common.retry}</button>}
    </section>
  );
}

/**
 * The player UI (#16), ported from 1.x: the categories, a quiz length, the
 * questions with feedback, and the results. The chosen category lives in the
 * address as `?category=<shortName>` (FE-4), so it can be shared and Back works.
 */
export function App() {
  const { t, number } = useI18n();
  const [data, setData] = useState<Data>({ status: 'loading' });
  const [search, setSearch] = useState(() => window.location.search);
  const [play, setPlay] = useState<Play>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // #17: the signed-in member; undefined until the session has been read.
  const [member, setMember] = useState<MemberSession | null | undefined>(undefined);
  const [status, setStatus] = useState('');
  // #19: the questions waiting for review, for a Moderator's header.
  const [reviewCount, setReviewCount] = useState<number | null>(null);

  useEffect(() => {
    getMemberSession().then(setMember, () => setMember(null));
  }, []);

  const load = useCallback(async () => {
    setData({ status: 'loading' });
    try {
      const [settings, categories] = await Promise.all([getPublicSettings(), listCategories()]);
      setData({ status: 'ready', settings, categories });
    } catch (cause) {
      setData({ status: 'error', cause });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** After an approval or unpublishing the categories' question counts change; reload them quietly. */
  const reloadCategories = useCallback(async () => {
    try {
      const categories = await listCategories();
      setData((current) => (current.status === 'ready' ? { ...current, categories } : current));
    } catch {
      // The old counts stay until the next load.
    }
  }, []);

  const memberId = member?.id ?? null;
  const memberRole = member?.role ?? null;
  const refreshCounts = useCallback(() => {
    if (memberRole !== 'Moderator') { setReviewCount(null); return; }
    getQuestionCounts().then((counts) => setReviewCount(counts.reviewQueue), () => setReviewCount(null));
  }, [memberRole]);
  useEffect(() => { refreshCounts(); }, [refreshCounts, memberId]);

  // Back and Forward move between the list and the categories (FE-4).
  useEffect(() => {
    const follow = () => { setSearch(window.location.search); setPlay(null); setNotice(null); setStatus(''); };
    window.addEventListener('popstate', follow);
    return () => window.removeEventListener('popstate', follow);
  }, []);

  const siteTitle = data.status === 'ready' ? data.settings.siteTitle : COMMON_TRANSLATIONS.product;
  useEffect(() => { document.title = siteTitle; }, [siteTitle]);

  const page = pageParam(search);
  const code = page ? null : categoryParam(search);
  const category = data.status === 'ready' ? findCategory(data.categories, code) : null;
  const playable = category !== null && category.questionCount > 0;

  // FE-4: normalize a deep link: the category's own spelling, or back to the list when it cannot be played.
  useEffect(() => {
    if (data.status !== 'ready' || code === null) return;
    const next = searchWithCategory(window.location.search, playable ? category.shortName : null);
    if (next !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`);
      setSearch(next);
    }
    if (!playable) setNotice(formatTranslation(category ? t.quiz.emptyCategory : t.quiz.unknownCategory, { code }));
  }, [data, code, category, playable, t]);

  const go = useCallback((next: string) => {
    window.history.pushState(null, '', `${window.location.pathname}${next}`);
    setSearch(next);
    setPlay(null);
    setNotice(null);
  }, []);
  /** A category, or the list for null; a page such as the sign-in is left behind. */
  const navigate = useCallback((shortName: string | null) => { setStatus(''); go(searchWithCategory('', shortName)); }, [go]);
  const openPage = useCallback((target: Page) => { setStatus(''); go(searchForPage(target)); }, [go]);

  // A signed-in member has nothing to do on the sign-in page, and only Editors and Moderators have question
  // pages (Moderators the review queue); anyone else goes back to the game (FE-4).
  const allowedPage = page === null || member === undefined
    || (page === 'login' ? member === null
      : page === 'scores' ? member !== null
        : page === 'questions' ? member !== null && canAuthor(member.role)
          : member?.role === 'Moderator');
  useEffect(() => {
    if (!allowedPage) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
      setSearch('');
    }
  }, [allowedPage]);

  const startQuiz = useCallback(async (target: PublicCategory, length: QuizLength) => {
    setPlay({ status: 'loading', length });
    try {
      const quiz = await getQuiz(target.id, length);
      setPlay({ status: 'playing', length, quiz, session: startSession(quiz.questions) });
    } catch (cause) {
      setPlay({ status: 'error', length, cause });
    }
  }, []);

  const update = (change: (session: QuizSession) => QuizSession) => setPlay((current) => (
    current?.status === 'playing' ? { ...current, session: change(current.session) } : current
  ));

  let content;
  if (!allowedPage || (page !== null && page !== 'login' && member === undefined)) {
    content = <LoadState message={t.common.loading} />;
  } else if ((page === 'questions' || page === 'review') && member) {
    content = data.status === 'ready'
      ? <QuestionWorkshop mode={page} member={member} categories={data.categories} onChanged={() => { refreshCounts(); void reloadCategories(); }} />
      : data.status === 'error' ? <LoadState message="" cause={data.cause} onRetry={() => void load()} /> : <LoadState message={t.common.loading} />;
  } else if (page === 'scores' && member) {
    content = <ScoresPage />;
  } else if (page === 'categories' && member) {
    content = <CategoryManager onChanged={() => void reloadCategories()} />;
  } else if (page === 'login') {
    content = member === null
      ? <SignIn agtSignIn={data.status === 'ready' && data.settings.agtSignIn} onSignedIn={(signedIn) => { setMember(signedIn); go(''); setStatus(formatTranslation(t.login.signedIn, { name: signedIn.displayName })); }} />
      : <LoadState message={t.quiz.loadingCategories} />;
  } else if (data.status === 'loading') content = <LoadState message={t.quiz.loadingCategories} />;
  else if (data.status === 'error') content = <LoadState message="" cause={data.cause} onRetry={() => void load()} />;
  else if (!playable) {
    content = <CategoryList categories={data.categories} notice={notice} onChoose={(chosen) => navigate(chosen.shortName)} />;
  } else if (play === null) {
    content = (
      <>
        <BackToCategories onBack={() => navigate(null)} />
        <LengthChoice
          category={category}
          shortLength={data.settings.quizShortLength}
          longLength={data.settings.quizLongLength}
          onChoose={(length) => void startQuiz(category, length)}
        />
      </>
    );
  } else if (play.status !== 'playing') {
    content = (
      <>
        <BackToCategories onBack={() => navigate(null)} />
        {play.status === 'loading'
          ? <LoadState message={t.quiz.loadingQuiz} />
          : <LoadState message="" cause={play.cause} onRetry={() => void startQuiz(category, play.length)} />}
      </>
    );
  } else if (play.quiz.questions.length === 0) {
    content = (
      <>
        <BackToCategories onBack={() => navigate(null)} />
        <p className="admin-notice" role="status">{t.quiz.emptyQuiz}</p>
      </>
    );
  } else if (isFinished(play.session)) {
    content = (
      <Results category={category} session={play.session} onReplay={() => void startQuiz(category, play.length)} onAnother={() => navigate(null)}>
        <SaveResult member={member} categoryId={category.id} length={play.length} attemptToken={play.quiz.attempt.token} answers={play.session.answers} onSignIn={() => openPage('login')} />
      </Results>
    );
  } else {
    content = (
      <>
        <BackToCategories onBack={() => navigate(null)}>
          <p className="quiz-score">{formatTranslation(t.quiz.score, { score: number(play.session.score) })}</p>
        </BackToCategories>
        <QuestionView
          category={category}
          session={play.session}
          onChoose={(choiceId, checked) => update((session) => choose(session, choiceId, checked))}
          onLock={() => update(lockAnswer)}
          onNext={() => update(nextQuestion)}
        />
      </>
    );
  }

  return (
    <Layout
      siteTitle={siteTitle}
      supportUrl={data.status === 'ready' ? data.settings.supportUrl : null}
      member={member}
      status={status}
      reviewCount={reviewCount}
      onHome={() => navigate(null)}
      onOpenPage={openPage}
      onMemberChanged={setMember}
      onSignedOut={() => { setMember(null); setStatus(t.login.signedOut); }}
    >
      <div className="player">{content}</div>
    </Layout>
  );
}
