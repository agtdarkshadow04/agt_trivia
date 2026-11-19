import { BrandLockup } from '../components/BrandLockup';
import { COMMON_TRANSLATIONS } from '../translations';

/**
 * The admin shell (UI-8). First-run setup, sign-in and the tabs arrive in #11.
 */
export function AdminApp() {
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <BrandLockup />
      </header>
      <main id="main-content" className="admin-main" tabIndex={-1}>
        <h1 className="sr-only">{COMMON_TRANSLATIONS.product}</h1>
      </main>
    </div>
  );
}
