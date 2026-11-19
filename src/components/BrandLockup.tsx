import { COMMON_TRANSLATIONS } from '../translations';

/** The brand lockup (UI-5, UI-7): the decorative logo next to the visible brand and product names. */
export function BrandLockup() {
  return (
    <span className="brand">
      <img className="brand-logo" src="/AgtOfficialLogo.webp" alt="" aria-hidden="true" width="44" height="44" />
      <span className="brand-copy">
        <span className="brand-name">{COMMON_TRANSLATIONS.alliance}</span>{' '}
        <span className="brand-product">{COMMON_TRANSLATIONS.product}</span>
      </span>
    </span>
  );
}
