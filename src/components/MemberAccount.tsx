import { type FormEvent, type RefObject, useState } from 'react';
import type { MemberSession } from '../lib/api';
import { changeMemberPassword, memberSignIn, memberSignOut } from '../lib/playerApi';
import { confirmationError, errorsOf, newPasswordError, requiredError } from '../lib/validation';
import { Dialog } from './Dialog';
import { formErrors, noFormErrors, TextField } from './Field';
import { useI18n } from './I18n';
import { LogInIcon, LogOutIcon } from './Icons';
import { useViewHeading } from './useViewHeading';

/**
 * `?page=login` (#17): the member sign-in. Accounts are created by the Admin;
 * there is no self-registration. Anonymous visitors can play without one.
 */
export function SignIn({ onSignedIn }: { onSignedIn(member: MemberSession): void }) {
  const { t } = useI18n();
  const heading = useViewHeading('login');
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
      onSignedIn(await memberSignIn(username, password));
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="member-login-title">
      <p className="eyebrow">{t.login.eyebrow}</p>
      <h1 id="member-login-title" ref={heading} tabIndex={-1}>{t.login.title}</h1>
      <p>{t.login.text}</p>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label={t.fields.username} name="username" autoComplete="username" autoCapitalize="none" required error={errors.fields.username} />
        <TextField label={t.fields.password} name="password" type="password" autoComplete="current-password" required error={errors.fields.password} />
        <div className="form-actions">
          <button className="button button-primary button-with-icon" disabled={busy} type="submit"><LogInIcon />{busy ? t.login.submitting : t.login.submit}</button>
        </div>
      </form>
    </section>
  );
}

/** A local member changes their password (AUTH-4): their other sessions end. */
function ChangePassword({ onChanged }: { onChanged(member: MemberSession): void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState(noFormErrors);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get('currentPassword'));
    const password = String(data.get('password'));
    setDone(false);
    // FE-6: the server's own rules first; it stays the authority.
    const problems = errorsOf(requiredError('currentPassword', currentPassword), newPasswordError(password), confirmationError(password, String(data.get('passwordConfirmation'))));
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      const member = await changeMemberPassword(currentPassword, password);
      form.reset();
      setDone(true);
      onChanged(member);
    } catch (cause) {
      setErrors(formErrors(cause, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 className="settings-heading">{t.account.passwordTitle}</h3>
      <div role="status">{done && <p className="success-note">{t.account.done}</p>}</div>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label={t.account.currentPassword} name="currentPassword" type="password" autoComplete="current-password" required error={errors.fields.currentPassword} />
        <TextField label={t.account.newPassword} name="password" type="password" autoComplete="new-password" required error={errors.fields.password} help={t.account.passwordHelp} />
        <TextField label={t.account.confirm} name="passwordConfirmation" type="password" autoComplete="new-password" required error={errors.fields.passwordConfirmation} />
        <div className="form-actions">
          <button className="button button-secondary" disabled={busy} type="submit">{busy ? t.account.submitting : t.account.submit}</button>
        </div>
      </form>
    </>
  );
}

/** The member menu (#17): who is signed in, the password change and Sign out. */
export function AccountDialog({ member, onClose, onChanged, onSignedOut, returnFocusRef }: {
  member: MemberSession;
  onClose(): void;
  onChanged(member: MemberSession): void;
  onSignedOut(): void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t, error } = useI18n();
  const [signOutError, setSignOutError] = useState('');

  async function signOut() {
    try {
      await memberSignOut();
      onSignedOut();
    } catch (cause) {
      setSignOutError(error(cause));
    }
  }

  return (
    <Dialog title={t.account.title} eyebrow={t.login.eyebrow} onClose={onClose} returnFocusRef={returnFocusRef}>
      <dl className="account-details">
        <div><dt>{t.fields.displayName}</dt><dd>{member.displayName}</dd></div>
        {member.username && <div><dt>{t.fields.username}</dt><dd>{member.username}</dd></div>}
        <div><dt>{t.fields.role}</dt><dd>{t.roles[member.role]}</dd></div>
      </dl>
      {member.authSource === 'local' ? <ChangePassword onChanged={onChanged} /> : <p className="field-help">{t.account.agtPassword}</p>}
      {signOutError && <p className="error-note" role="alert">{signOutError}</p>}
      <div className="form-actions account-sign-out">
        <button className="button button-secondary button-with-icon" type="button" onClick={() => void signOut()}><LogOutIcon />{t.layout.signOut}</button>
      </div>
    </Dialog>
  );
}
