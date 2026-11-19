import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import { COMMON_TRANSLATIONS, formatTranslation } from '../translations';
import { Dialog } from './Dialog';
import { DisplaySettings } from './DisplaySettings';
import { useI18n } from './I18n';
import { SettingsIcon } from './Icons';
import { MaintenanceNotice } from './MaintenanceNotice';

/** I18N-4: the reader's language and text size; the player UI shows no times yet, so no time zone. */
function SettingsDialog({ onClose, returnFocusRef }: { onClose(): void; returnFocusRef: React.RefObject<HTMLButtonElement | null> }) {
  const { t } = useI18n();
  return (
    <Dialog title={t.settings.title} eyebrow={t.settings.eyebrow} onClose={onClose} closeLabel={t.settings.close} returnFocusRef={returnFocusRef}>
      <h3 className="settings-heading">{t.settings.display}</h3>
      <DisplaySettings timeZone={false} />
    </Dialog>
  );
}

/**
 * The public page chrome (UI-7): the `site-header` with the brand lockup and
 * the round icon buttons, the maintenance notice (FE-5), `<main
 * id="main-content">`, and the `site-footer` with the Alliance links and the
 * support link. The brand returns to the category list.
 */
export function Layout({ siteTitle, supportUrl, onHome, children }: {
  siteTitle: string;
  /** `site.supportUrl`, once the public settings have loaded. */
  supportUrl: string | null;
  onHome(): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const home = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onHome();
  };
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
    </div>
  );
}
