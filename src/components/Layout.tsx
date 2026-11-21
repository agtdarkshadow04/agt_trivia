import { type MouseEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { MemberSession } from '../lib/api';
import { canAuthor } from '../lib/questionRules';
import type { Page } from '../lib/routes';
import { COMMON_TRANSLATIONS, formatTranslation } from '../translations';
import { Dialog } from './Dialog';
import { DisplaySettings } from './DisplaySettings';
import { useI18n } from './I18n';
import { ClipboardCheckIcon, FolderIcon, LogInIcon, MenuIcon, PencilIcon, SettingsIcon, TimerIcon, TrophyIcon, UserRoundIcon } from './Icons';
import { AccountDialog } from './MemberAccount';
import { MaintenanceNotice } from './MaintenanceNotice';

/** I18N-4: the reader's language, time zone (for the score history's dates, #21) and text size. */
function SettingsDialog({ onClose, returnFocusRef }: { onClose(): void; returnFocusRef: React.RefObject<HTMLButtonElement | null> }) {
  const { t } = useI18n();
  return (
    <Dialog title={t.settings.title} eyebrow={t.settings.eyebrow} onClose={onClose} closeLabel={t.settings.close} returnFocusRef={returnFocusRef}>
      <h3 className="settings-heading">{t.settings.display}</h3>
      <DisplaySettings />
    </Dialog>
  );
}

/** A member's page in the header (#70): its icon link on wide screens, a named link in the menu on narrow ones. */
interface PageLink {
  page: Page;
  label: string;
  /** The accessible name, when it says more than the label (the review queue's count). */
  name: string;
  icon: ReactNode;
  count: number | null;
}

/**
 * The page links of a narrow header (#70), in a dialog (A11Y-2): each with its
 * icon and its name, the current page marked `aria-current="page"`.
 */
function PageMenu({ links, currentPage, returnFocusRef, onClose, onOpenPage }: {
  links: readonly PageLink[];
  currentPage: Page | null;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onOpenPage(page: Page): void;
}) {
  const { t, number } = useI18n();
  const id = useId();
  return (
    <Dialog title={t.layout.menu} onClose={onClose} returnFocusRef={returnFocusRef} className="page-menu-dialog">
      <nav aria-label={t.layout.mainNavigation}>
        <ul className="page-menu">
          {links.map((link) => (
            <li key={link.page}>
              <a
                className="button button-secondary button-with-icon"
                href={`/?page=${link.page}`}
                aria-current={link.page === currentPage ? 'page' : undefined}
                // The visible name is the accessible name (WCAG 2.5.3); the count is its description.
                aria-describedby={link.name === link.label ? undefined : `${id}-${link.page}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                  event.preventDefault();
                  onClose();
                  onOpenPage(link.page);
                }}
              >
                {link.icon}{link.label}
                {link.count ? <span className="page-menu-count" aria-hidden="true">{number(link.count)}</span> : null}
              </a>
              {link.name !== link.label && <span id={`${id}-${link.page}`} className="sr-only">{link.name}</span>}
            </li>
          ))}
        </ul>
      </nav>
    </Dialog>
  );
}

/**
 * The public page chrome (UI-7): the `site-header` with the brand lockup and
 * the round icon buttons (Sign in, or the signed-in member's account menu, and
 * Settings), the maintenance notice (FE-5), the status of a sign-in or
 * sign-out (A11Y-4), `<main id="main-content">`, and the `site-footer` with the
 * Alliance links and the support link. The brand returns to the category list.
 */
export function Layout({ siteTitle, supportUrl, member, status, reviewCount, leaderboards = false, ranked = false, currentPage = null, onHome, onOpenPage, onMemberChanged, onSignedOut, children }: {
  siteTitle: string;
  /** `site.supportUrl`, once the public settings have loaded. */
  supportUrl: string | null;
  /** The signed-in member; undefined while the session is being read. */
  member: MemberSession | null | undefined;
  status: string;
  /** Moderators: the questions waiting for review (#19); null for everyone else or while unknown. */
  reviewCount: number | null;
  /** `leaderboards.enabled` (#49): the account menu offers the opt-in. */
  leaderboards?: boolean;
  /** `ranked.enabled` (#66): members get the Ranked page. */
  ranked?: boolean;
  /** The member page being shown (`?page=`), marked `aria-current="page"` (#70). */
  currentPage?: Page | null;
  onHome(): void;
  onOpenPage(page: Page): void;
  onMemberChanged(member: MemberSession): void;
  onSignedOut(): void;
  children: ReactNode;
}) {
  const { t, number } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const follow = (action: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    action();
  };
  const home = follow(onHome);
  const reviewName = reviewCount ? formatTranslation(t.layout.reviewQueueCount, { count: number(reviewCount) }) : t.layout.reviewQueue;
  const badge = (count: number) => (count > 99 ? `${number(99)}+` : number(count));
  const links: PageLink[] = !member ? [] : [
    ...(ranked ? [{ page: 'ranked' as const, label: t.layout.ranked, name: t.layout.ranked, icon: <TimerIcon />, count: null }] : []),
    { page: 'scores', label: t.layout.myScores, name: t.layout.myScores, icon: <TrophyIcon />, count: null },
    ...(canAuthor(member.role) ? [{ page: 'questions' as const, label: t.layout.myQuestions, name: t.layout.myQuestions, icon: <PencilIcon />, count: null }] : []),
    ...(member.role === 'Moderator' ? [
      { page: 'review' as const, label: t.layout.reviewQueue, name: reviewName, icon: <ClipboardCheckIcon />, count: reviewCount || null },
      { page: 'categories' as const, label: t.layout.categories, name: t.layout.categories, icon: <FolderIcon />, count: null },
    ] : []),
  ];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t.common.skipToContent}</a>
      <header className="site-header">
        <div className="header-inner">
          <a href="/" className="brand" onClick={home} aria-label={formatTranslation(t.layout.homeLabel, { alliance: COMMON_TRANSLATIONS.alliance, product: siteTitle })}>
            <img className="brand-logo" src="/AgtOfficialLogo.webp" alt="" aria-hidden="true" width="44" height="44" />
            <span className="brand-copy">
              <span className="brand-name">{COMMON_TRANSLATIONS.alliance}</span>{' '}
              <span className="brand-product">{siteTitle}</span>
            </span>
          </a>
          <nav className="header-actions" aria-label={t.layout.mainNavigation}>
            {member && <span className="identity-badge">{member.displayName} · {t.roles[member.role]}</span>}
            {links.length > 0 && (
              <span className="header-page-links">
                {links.map((link) => {
                  const anchor = (
                    <a
                      key={link.page}
                      className="button button-icon"
                      href={`/?page=${link.page}`}
                      onClick={follow(() => onOpenPage(link.page))}
                      aria-label={link.name}
                      title={link.label}
                      aria-current={link.page === currentPage ? 'page' : undefined}
                    >
                      {link.icon}
                    </a>
                  );
                  return link.page === 'review' ? (
                    <span key={link.page} className="icon-with-count">
                      {anchor}
                      {link.count ? <span className="count-badge" aria-hidden="true">{badge(link.count)}</span> : null}
                    </span>
                  ) : anchor;
                })}
              </span>
            )}
            {links.length > 0 && (
              <span className="icon-with-count header-menu-button">
                <button
                  ref={menuButton}
                  className="button button-icon"
                  type="button"
                  onClick={() => setMenuOpen(true)}
                  aria-label={reviewCount ? formatTranslation(t.layout.menuCount, { count: number(reviewCount) }) : t.layout.menu}
                  title={t.layout.menu}
                  aria-haspopup="dialog"
                  aria-expanded={menuOpen}
                >
                  <MenuIcon />
                </button>
                {reviewCount ? <span className="count-badge" aria-hidden="true">{badge(reviewCount)}</span> : null}
              </span>
            )}
            {member ? (
              <button
                ref={accountButton}
                className="button button-icon"
                type="button"
                onClick={() => setAccountOpen(true)}
                aria-label={t.layout.account}
                title={t.layout.account}
                aria-haspopup="dialog"
                aria-expanded={accountOpen}
              >
                <UserRoundIcon />
              </button>
            ) : member === null && (
              <a className="button button-icon" href="/?page=login" onClick={follow(() => onOpenPage('login'))} aria-label={t.layout.signIn} title={t.layout.signIn}>
                <LogInIcon />
              </a>
            )}
            <button
              ref={settingsButton}
              className="button button-icon"
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label={t.layout.settings}
              title={t.layout.settings}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <SettingsIcon />
            </button>
          </nav>
        </div>
      </header>
      <MaintenanceNotice />
      <div className="status-region" role="status" aria-live="polite">{status && <p className="success-note">{status}</p>}</div>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <nav aria-label={t.layout.allianceLinks}>
          <a href="https://www.nms-agt.com" target="_blank" rel="noreferrer">{t.layout.footerHome}</a>
          <a href="https://www.nms-agt.com/about-the-agt" target="_blank" rel="noreferrer">{t.layout.footerAbout}</a>
          <a href="https://www.nms-agt.com/contribute" target="_blank" rel="noreferrer">{t.layout.footerContribute}</a>
          {supportUrl && <a href={supportUrl} target="_blank" rel="noreferrer">{t.layout.footerSupport}</a>}
        </nav>
        <p>{formatTranslation(t.layout.copyright, { year: new Date().getUTCFullYear(), alliance: COMMON_TRANSLATIONS.alliance })}</p>
      </footer>
      {menuOpen && links.length > 0 && (
        <PageMenu links={links} currentPage={currentPage} returnFocusRef={menuButton} onClose={() => setMenuOpen(false)} onOpenPage={onOpenPage} />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} returnFocusRef={settingsButton} />}
      {accountOpen && member && (
        <AccountDialog
          member={member}
          leaderboards={leaderboards}
          returnFocusRef={accountButton}
          onClose={() => setAccountOpen(false)}
          onChanged={onMemberChanged}
          onSignedOut={() => { setAccountOpen(false); onSignedOut(); }}
        />
      )}
    </div>
  );
}
