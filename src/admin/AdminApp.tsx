import { type FormEvent, type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { BrandLockup } from '../components/BrandLockup';
import { Dialog } from '../components/Dialog';
import { DisplaySettings } from '../components/DisplaySettings';
import { formErrors, noFormErrors, TextField } from '../components/Field';
import { LogOutIcon, SettingsIcon } from '../components/Icons';
import { MaintenanceNotice } from '../components/MaintenanceNotice';
import { adminUsernameError, confirmationError, errorsOf, newPasswordError, requiredError } from '../lib/validation';
import { formatTranslation } from '../translations';
import { AccountPanel } from './AccountPanel';
import { BackupPanel } from './BackupPanel';
import { ImportPanel } from './ImportPanel';
import {
  adminUnauthorizedEvent, completeSetup, getServerLogSummary, getSession, getSetupStatus, markServerLogSeen, signIn, signOut,
  type AdminSession, type ServerLogSummary, type SetupStatus,
} from './api';
import { useAdminI18n } from './context';
import type { AdminTranslations } from './i18n';
import { LogPanel } from './LogPanel';
import { MembersPanel } from './MembersPanel';
import { SettingsPanel } from './SettingsPanel';

type Phase =
  | { name: 'loading' }
  | { name: 'error'; cause: unknown }
  | { name: 'setup'; status: SetupStatus }
  | { name: 'login'; notice?: Notice }
  | { name: 'dashboard'; session: AdminSession };

/** UI-8, in order: the resource tabs (Members), Settings, Server log, Audit log, Import (#22, before Backup & restore), Backup & restore, Account. */
type Tab = 'members' | 'settings' | 'serverLog' | 'auditLog' | 'import' | 'backup' | 'account';
const tabs: Tab[] = ['members', 'settings', 'serverLog', 'auditLog', 'import', 'backup', 'account'];

/** Why the sign-in screen is shown again. */
type Notice = 'signedOut' | 'sessionEnded' | 'restored';
const noticeText = (notice: Notice, a: AdminTranslations) => ({ signedOut: a.app.signedOut, sessionEnded: a.app.sessionEnded, restored: a.app.restored })[notice];

const tabId = (tab: Tab) => `admin-tab-${tab}`;
const panelId = (tab: Tab) => `admin-panel-${tab}`;

/** AUTH-5: the first-run setup form, or why setup is unavailable. */
function SetupScreen({ status, onComplete }: { status: SetupStatus; onComplete(session: AdminSession | null): void }) {
  const { t, a } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(noFormErrors);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = { setupPassword: String(data.get('setupPassword')), username: String(data.get('username')), password: String(data.get('password')) };
    const problems = errorsOf(
      requiredError('setupPassword', input.setupPassword),
      adminUsernameError(input.username),
      newPasswordError(input.password),
      confirmationError(input.password, String(data.get('passwordConfirmation'))),
    );
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      onComplete(await completeSetup(input));
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="admin-setup-title">
      <p className="eyebrow">{a.setup.eyebrow}</p>
      <h2 id="admin-setup-title">{a.setup.title}</h2>
      {!status.setupPasswordConfigured ? (
        <div className="admin-notice danger" role="alert">{a.setup.unavailable}</div>
      ) : (
        <>
          <p>{a.setup.intro}</p>
          {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
          <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
            <TextField label={a.setup.setupPassword} name="setupPassword" type="password" autoComplete="off" required error={errors.fields.setupPassword} />
            <TextField label={a.setup.username} name="username" autoComplete="username" required error={errors.fields.username} />
            <TextField label={a.setup.password} name="password" type="password" autoComplete="new-password" required error={errors.fields.password} help={a.setup.passwordHelp} />
            <TextField label={a.setup.confirm} name="passwordConfirmation" type="password" autoComplete="new-password" required error={errors.fields.passwordConfirmation} />
            <button className="button button-primary" disabled={busy} type="submit">{busy ? a.setup.submitting : a.setup.submit}</button>
          </form>
        </>
      )}
    </section>
  );
}

function LoginScreen({ notice, onSignedIn }: { notice?: Notice; onSignedIn(session: AdminSession | null): void }) {
  const { t, a } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(noFormErrors);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get('username'));
    const password = String(data.get('password'));
    const problems = errorsOf(requiredError('username', username.trim()), requiredError('password', password));
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      onSignedIn(await signIn(username, password));
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="admin-login-title">
      <p className="eyebrow">{a.login.eyebrow}</p>
      <h2 id="admin-login-title">{a.login.title}</h2>
      <div role="status" aria-live="polite">{notice && <p className="success-note">{noticeText(notice, a)}</p>}</div>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label={a.login.username} name="username" autoComplete="username" required error={errors.fields.username} />
        <TextField label={a.login.password} name="password" type="password" autoComplete="current-password" required error={errors.fields.password} />
        <button className="button button-primary" disabled={busy} type="submit">{busy ? a.login.submitting : a.login.submit}</button>
      </form>
    </section>
  );
}

function Dashboard({ session, onSessionChange, onRestored }: { session: AdminSession; onSessionChange(session: AdminSession): void; onRestored(): void }) {
  const { a, number } = useAdminI18n();
  // BAK-11: after a failed restore only the Backup & restore tab works.
  const [tab, setTab] = useState<Tab>(session.restoreFailed ? 'backup' : 'settings');
  const [summary, setSummary] = useState<ServerLogSummary | null>(null);

  // LOG-21: the summary when the dashboard loads and whenever the tab changes, never in the background.
  // Opening the Server log tab marks it seen.
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        if (tab === 'serverLog') await markServerLogSeen();
        const next = await getServerLogSummary();
        if (current) setSummary(next);
      } catch {
        if (current) setSummary(null);
      }
    })();
    return () => { current = false; };
  }, [tab]);
  const unseen = summary ? summary.unseenWarnings + summary.unseenErrors : 0;
  const showUnseen = unseen > 0 && tab !== 'serverLog';

  /** WAI-ARIA tabs: arrow keys, Home and End move between the tabs. */
  function selectWithKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = tabs[(moves[event.key] + tabs.length) % tabs.length];
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  }

  return (
    <>
      {session.restoreFailed && <div className="admin-notice danger" role="alert">{a.app.restoreFailed}</div>}
      {session.setupPasswordStillSet && <div className="admin-notice danger" role="alert">{a.app.setupPasswordStillSet}</div>}
      {showUnseen && (
        <div className="admin-notice" role="status">
          {formatTranslation(a.app.unseenLog, { count: number(unseen) })}{' '}
          <button className="link-button" type="button" onClick={() => setTab('serverLog')}>{a.app.openServerLog}</button>
        </div>
      )}
      <div className="admin-tabs" role="tablist" aria-label={a.app.sections}>
        {tabs.map((id, index) => (
          <button
            key={id}
            id={tabId(id)}
            type="button"
            role="tab"
            className="button"
            aria-selected={tab === id}
            aria-controls={panelId(id)}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => selectWithKeys(event, index)}
          >
            {a.tabs[id]}
            {id === 'serverLog' && showUnseen && (
              <span className={`admin-badge${summary!.unseenErrors > 0 ? ' admin-badge-error' : ''}`}>
                {number(unseen)}<span className="sr-only"> {summary!.unseenErrors > 0 ? a.app.unseenErrors : a.app.unseenWarnings}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="admin-tab-panel" role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} tabIndex={0}>
        {tab === 'members' && <MembersPanel />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'serverLog' && <LogPanel kind="server" />}
        {tab === 'auditLog' && <LogPanel kind="audit" />}
        {tab === 'import' && <ImportPanel />}
        {tab === 'backup' && <BackupPanel onRestored={onRestored} />}
        {tab === 'account' && <AccountPanel session={session} onSessionRenewed={onSessionChange} />}
      </div>
    </>
  );
}

/** The language and text size, shared with the player UI (I18N-4, A11Y-6). */
function PreferencesDialog({ onClose, returnFocusRef }: { onClose(): void; returnFocusRef: RefObject<HTMLButtonElement | null> }) {
  const { a } = useAdminI18n();
  return (
    <Dialog title={a.preferences.title} eyebrow={a.preferences.eyebrow} onClose={onClose} closeLabel={a.preferences.close} returnFocusRef={returnFocusRef}>
      <p className="field-help">{a.preferences.text}</p>
      <DisplaySettings />
    </Dialog>
  );
}

/**
 * The admin dashboard at `/admin` (UI-8): first-run setup, sign-in, then the
 * tabs. It has its own session cookie and never touches the player UI.
 */
export function AdminApp() {
  const { t, a, error: describe } = useAdminI18n();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const preferencesButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const status = await getSetupStatus();
      if (!status.adminExists) { setPhase({ name: 'setup', status }); return; }
      const session = await getSession();
      setPhase(session ? { name: 'dashboard', session } : { name: 'login' });
    } catch (cause) {
      setPhase({ name: 'error', cause });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const expired = () => setPhase((current) => (current.name === 'dashboard' ? { name: 'login', notice: 'sessionEnded' } : current));
    window.addEventListener(adminUnauthorizedEvent, expired);
    return () => window.removeEventListener(adminUnauthorizedEvent, expired);
  }, []);

  const signedIn = (session: AdminSession | null) => setPhase(session ? { name: 'dashboard', session } : { name: 'login' });

  async function leave() {
    try { await signOut(); } finally { setPhase({ name: 'login', notice: 'signedOut' }); }
  }

  const session = phase.name === 'dashboard' ? phase.session : null;
  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">{t.common.skipToContent}</a>
      <header className="admin-header">
        <div className="admin-title">
          <BrandLockup />
          <h1>{a.app.title}</h1>
        </div>
        <div className="admin-identity">
          {session && <span className="admin-version">{formatTranslation(a.app.version, { version: session.version })}</span>}
          {session && <span className="identity-badge">{session.username}</span>}
          <button
            ref={preferencesButton}
            className="button button-icon"
            type="button"
            aria-label={a.app.settings}
            title={a.app.settings}
            aria-haspopup="dialog"
            aria-expanded={preferencesOpen}
            onClick={() => setPreferencesOpen(true)}
          >
            <SettingsIcon />
          </button>
          <a className="button button-secondary" href="/">{a.app.viewSite}</a>
          {session && <button className="button button-secondary button-with-icon" type="button" onClick={() => void leave()}><LogOutIcon />{a.app.signOut}</button>}
        </div>
      </header>
      <MaintenanceNotice />
      <main id="main-content" className="admin-main" tabIndex={-1}>
        <div role="status" aria-live="polite">{phase.name === 'loading' && <p>{a.app.checkingSession}</p>}</div>
        {phase.name === 'error' && (
          <section className="auth-card">
            <div className="admin-notice danger" role="alert">{describe(phase.cause)}</div>
            <button className="button button-secondary" type="button" onClick={() => { setPhase({ name: 'loading' }); void load(); }}>{a.app.tryAgain}</button>
          </section>
        )}
        {phase.name === 'setup' && <SetupScreen status={phase.status} onComplete={signedIn} />}
        {phase.name === 'login' && <LoginScreen notice={phase.notice} onSignedIn={signedIn} />}
        {phase.name === 'dashboard' && (
          <Dashboard
            session={phase.session}
            onSessionChange={(next) => setPhase({ name: 'dashboard', session: next })}
            onRestored={() => setPhase({ name: 'login', notice: 'restored' })}
          />
        )}
      </main>
      {preferencesOpen && <PreferencesDialog onClose={() => setPreferencesOpen(false)} returnFocusRef={preferencesButton} />}
    </div>
  );
}
