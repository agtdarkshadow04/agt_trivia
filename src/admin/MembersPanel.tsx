import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { formErrors, noFormErrors, SelectField, TextField } from '../components/Field';
import { PencilIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { memberRoles, type AdminMember, type MemberRole } from '../lib/api';
import { displayNameError, errorsOf, memberUsernameError, newPasswordError } from '../lib/validation';
import { formatTranslation } from '../translations';
import { createMember, deleteMember, listMembers, replaceMember, setMemberPassword } from './api';
import { useAdminI18n } from './context';

/** The role select, with what each role may do in its help (#17). */
function RoleField({ defaultValue, error }: { defaultValue: MemberRole; error?: string }) {
  const { a } = useAdminI18n();
  return (
    <SelectField label={a.members.role} name="role" defaultValue={defaultValue} error={error} help={a.members.rolesHelp}>
      {memberRoles.map((role) => <option key={role} value={role}>{a.roles[role]}</option>)}
    </SelectField>
  );
}

/** FE-6: the create form, checked with the server's own validators first. */
function CreateMember({ onCreated }: { onCreated(member: AdminMember): void }) {
  const { t, a } = useAdminI18n();
  const [errors, setErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = {
      username: String(data.get('username')),
      displayName: String(data.get('displayName')),
      role: String(data.get('role')) as MemberRole,
      password: String(data.get('password')),
    };
    const problems = errorsOf(memberUsernameError(input.username), displayNameError(input.displayName), newPasswordError(input.password));
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      const { member } = await createMember(input);
      form.reset();
      onCreated(member);
    } catch (cause) {
      setErrors(formErrors(cause, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby="member-create-title">
      <h2 id="member-create-title">{a.members.createTitle}</h2>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      <form className="stack-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextField label={a.members.username} name="username" autoComplete="off" required error={errors.fields.username} help={a.members.usernameHelp} />
        <TextField label={a.members.displayName} name="displayName" autoComplete="off" required error={errors.fields.displayName} />
        <RoleField defaultValue="Player" error={errors.fields.role} />
        <TextField label={a.members.initialPassword} name="password" type="password" autoComplete="new-password" required error={errors.fields.password} help={a.members.passwordHelp} />
        <div className="form-actions">
          <button className="button button-primary button-with-icon" type="submit" disabled={busy}><PlusIcon />{busy ? a.members.creating : a.members.create}</button>
        </div>
      </form>
    </section>
  );
}

/**
 * Edits one member (#17): display name, role and the active flag, and, for a
 * local member, a new password. A role change, deactivation or new password
 * signs the member out everywhere (AUTH-4).
 */
function EditMember({ member, onClose, onSaved, returnFocusRef }: {
  member: AdminMember;
  onClose(): void;
  onSaved(member: AdminMember, notice: string): void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const { t, a } = useAdminI18n();
  const [errors, setErrors] = useState(noFormErrors);
  const [passwordErrors, setPasswordErrors] = useState(noFormErrors);
  const [busy, setBusy] = useState(false);
  const name = member.username ?? member.displayName;
  const managed = member.authSource === 'agt_iam';

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = { displayName: String(data.get('displayName')), role: String(data.get('role')) as MemberRole, isActive: data.get('isActive') === 'on' };
    const problems = errorsOf(displayNameError(input.displayName));
    setErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      onSaved((await replaceMember(member.id, input)).member, a.members.saved);
    } catch (cause) {
      setErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    const problems = errorsOf(newPasswordError(password));
    setPasswordErrors(formErrors(problems, t));
    if (problems.length) return;
    setBusy(true);
    try {
      onSaved(await setMemberPassword(member.id, password), a.members.passwordChanged);
    } catch (cause) {
      setPasswordErrors(formErrors(cause, t));
      setBusy(false);
    }
  }

  return (
    <Dialog title={formatTranslation(a.members.editTitle, { name })} eyebrow={a.tabs.members} onClose={onClose} returnFocusRef={returnFocusRef}>
      {errors.form && <p className="error-note" role="alert">{errors.form}</p>}
      {managed && <p className="admin-notice">{a.members.agtManaged}</p>}
      <form className="stack-form" noValidate onSubmit={(event) => void save(event)}>
        {managed ? (
          <>
            <input type="hidden" name="displayName" value={member.displayName} />
            <input type="hidden" name="role" value={member.role} />
            <dl className="account-details">
              <div><dt>{a.members.displayName}</dt><dd>{member.displayName}</dd></div>
              <div><dt>{a.members.role}</dt><dd>{a.roles[member.role]}</dd></div>
              <div><dt>{a.members.travellerId}</dt><dd>{member.travellerId}</dd></div>
              <div><dt>{a.members.iamPermission}</dt><dd>{member.iamPermission ?? '—'}</dd></div>
            </dl>
          </>
        ) : (
          <>
            <TextField label={a.members.displayName} name="displayName" defaultValue={member.displayName} required error={errors.fields.displayName} />
            <RoleField defaultValue={member.role} error={errors.fields.role} />
          </>
        )}
        <label className="check-field">
          <input type="checkbox" name="isActive" defaultChecked={member.isActive} />
          {t.fields.isActive}
        </label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{a.members.save}</button></div>
      </form>
      {member.authSource === 'local' && (
        <>
          <h3 className="settings-heading">{a.members.passwordTitle}</h3>
          {passwordErrors.form && <p className="error-note" role="alert">{passwordErrors.form}</p>}
          <form className="stack-form" noValidate onSubmit={(event) => void resetPassword(event)}>
            <TextField label={a.members.newPassword} name="password" type="password" autoComplete="new-password" required error={passwordErrors.fields.password} help={a.members.passwordHelp} />
            <div className="form-actions"><button className="button button-secondary" type="submit" disabled={busy}>{a.members.setPassword}</button></div>
          </form>
        </>
      )}
    </Dialog>
  );
}

/** UI-8 Members (#17): the Admin creates, edits, deactivates and deletes member accounts. */
export function MembersPanel() {
  const { t, a, error: describe } = useAdminI18n();
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [deleting, setDeleting] = useState<AdminMember | null>(null);
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const load = useCallback(async (query: string, cursor: string | null = null) => {
    setLoadError(null);
    try {
      const page = await listMembers(query, cursor);
      setMembers((current) => (cursor && current ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setLoadError(cause);
    }
  }, []);

  useEffect(() => { void load(''); }, [load]);

  const label = (member: AdminMember) => member.username ?? member.displayName;

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteMember(deleting.id);
      setStatus(formatTranslation(a.members.deleted, { username: label(deleting) }));
      setDeleting(null);
      await load(search);
    } catch (cause) {
      setStatus(describe(cause));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="members-sections">
      <div role="status" aria-live="polite">{status && <p className="success-note">{status}</p>}</div>
      <CreateMember onCreated={(member) => { setStatus(formatTranslation(a.members.created, { username: label(member) })); void load(search); }} />
      <section className="admin-panel log-panel" aria-labelledby="member-list-title">
        <h2 id="member-list-title">{a.tabs.members}</h2>
        <form className="log-filters" role="search" onSubmit={(event) => { event.preventDefault(); void load(search); }}>
          <TextField label={a.members.search} name="q" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="form-actions"><button className="button button-secondary" type="submit">{a.members.searchSubmit}</button></div>
        </form>
        {loadError !== null && (
          <div role="alert">
            <p className="error-note">{describe(loadError)}</p>
            <button className="button button-secondary" type="button" onClick={() => void load(search)}>{t.common.retry}</button>
          </div>
        )}
        {members === null && loadError === null && <p role="status">{a.members.loading}</p>}
        {members !== null && members.length === 0 && <p className="field-help">{a.members.empty}</p>}
        {members !== null && members.length > 0 && (
          <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="member-list-title">
            <table className="log-table">
              <thead>
                <tr>
                  <th scope="col">{a.members.username}</th>
                  <th scope="col">{a.members.displayName}</th>
                  <th scope="col">{a.members.role}</th>
                  <th scope="col">{a.members.status}</th>
                  <th scope="col"><span className="sr-only">{a.members.actions}</span></th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>{member.username ?? <span className="log-muted">{a.members.agtBadge}{member.iamPermission ? ` · ${member.iamPermission}` : ''}</span>}</td>
                    <td>{member.displayName}</td>
                    <td>{a.roles[member.role]}</td>
                    <td>{member.isActive ? a.members.active : a.members.inactive}</td>
                    <td>
                      <div className="form-actions">
                        <button
                          className="button button-icon"
                          type="button"
                          aria-label={formatTranslation(a.members.editTitle, { name: label(member) })}
                          title={formatTranslation(a.members.editTitle, { name: label(member) })}
                          aria-haspopup="dialog"
                          aria-expanded={editing?.id === member.id}
                          onClick={(event) => { opener.current = event.currentTarget; setEditing(member); }}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="button button-icon"
                          type="button"
                          aria-label={formatTranslation(a.members.deleteTitle, { name: label(member) })}
                          title={formatTranslation(a.members.deleteTitle, { name: label(member) })}
                          aria-haspopup="dialog"
                          aria-expanded={deleting?.id === member.id}
                          onClick={() => setDeleting(member)}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <div className="form-actions log-more">
            <button className="button button-secondary" type="button" onClick={() => void load(search, nextCursor)}>{a.members.loadMore}</button>
          </div>
        )}
      </section>
      {editing && (
        <EditMember
          member={editing}
          returnFocusRef={opener}
          onClose={() => setEditing(null)}
          onSaved={(_member, notice) => { setEditing(null); setStatus(notice); void load(search); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={formatTranslation(a.members.deleteTitle, { name: label(deleting) })}
          description={a.members.deleteText}
          confirmLabel={a.members.deleteConfirm}
          danger
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
