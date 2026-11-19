import { BrandLockup } from './components/BrandLockup';
import { COMMON_TRANSLATIONS } from './translations';

/**
 * The public page chrome (UI-7). The quiz itself replaces the empty main
 * area in #16.
 */
export function App() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <BrandLockup />
        </div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <h1 className="sr-only">{COMMON_TRANSLATIONS.product}</h1>
      </main>
      <footer className="site-footer">
        <p>© {new Date().getUTCFullYear()} {COMMON_TRANSLATIONS.alliance}</p>
      </footer>
    </div>
  );
}
