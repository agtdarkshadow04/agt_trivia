import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import type { MemberSession } from '../lib/api';
import { canAuthor } from '../lib/questionRules';
import type { Page } from '../lib/routes';
import { COMMON_TRANSLATIONS, formatTranslation } from '../translations';
import { Dialog } from './Dialog';
import { DisplaySettings } from './DisplaySettings';
import { useI18n } from './I18n';
import { ClipboardCheckIcon, FolderIcon, LogInIcon, PencilIcon, SettingsIcon, TrophyIcon, UserRoundIcon } from './Icons';
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

/**
 * The public page chrome (UI-7): the `site-header` with the brand lockup and
 * the round icon buttons (Sign in, or the signed-in member's account menu, and
 * Settings), the maintenance notice (FE-5), the status of a sign-in or
 * sign-out (A11Y-4), `<main id="main-content">`, and the `site-footer` with the
 * Alliance links and the support link. The brand returns to the category list.
 */
export function Layout({ siteTitle, supportUrl, member, status, reviewCount, onHome, onOpenPage, onMemberChanged, onSignedOut, children }: {
  siteTitle: string;
  /** `site.supportUrl`, once the public settings have loaded. */
  supportUrl: string | null;
  /** The signed-in member; undefined while the session is being read. */
  member: MemberSession | null | undefined;
  status: string;
  /** Moderators: the questions waiting for review (#19); null for everyone else or while unknown. */
  reviewCount: number | null;
  onHome(): void;
  onOpenPage(page: Page): void;
  onMemberChanged(member: MemberSession): void;
  onSignedOut(): void;
  children: ReactNode;
}) {
  const { t, number } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const follow = (action: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    action();
  };
  const home = follow(onHome);
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
            {member && (
              <a className="button button-icon" href="/?page=scores" onClick={follow(() => onOpenPage('scores'))} aria-label={t.layout.myScores} title={t.layout.myScores}>
                <TrophyIcon />
              </a>
            )}
            {member && canAuthor(member.role) && (
              <a className="button button-icon" href="/?page=questions" onClick={follow(() => onOpenPage('questions'))} aria-label={t.layout.myQuestions} title={t.layout.myQuestions}>
                <PencilIcon />
              </a>
            )}
            {member && member.role === 'Moderator' && (
              <span className="icon-with-count">
                <a
                  className="button button-icon"
                  href="/?page=review"
                  onClick={follow(() => onOpenPage('review'))}
                  aria-label={reviewCount ? formatTranslation(t.layout.reviewQueueCount, { count: number(reviewCount) }) : t.layout.reviewQueue}
                  title={t.layout.reviewQueue}
                >
                  <ClipboardCheckIcon />
                </a>
                {reviewCount ? <span className="count-badge" aria-hidden="true">{reviewCount > 99 ? `${number(99)}+` : number(reviewCount)}</span> : null}
              </span>
            )}
            {member && member.role === 'Moderator' && (
              <a className="button button-icon" href="/?page=categories" onClick={follow(() => onOpenPage('categories'))} aria-label={t.layout.categories} title={t.layout.categories}>
                <FolderIcon />
              </a>
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
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} returnFocusRef={settingsButton} />}
      {accountOpen && member && (
        <AccountDialog
          member={member}
          returnFocusRef={accountButton}
          onClose={() => setAccountOpen(false)}
          onChanged={onMemberChanged}
          onSignedOut={() => { setAccountOpen(false); onSignedOut(); }}
        />
      )}
    </div>
  );
}
