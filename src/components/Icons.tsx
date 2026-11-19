import type { SVGProps } from 'react';

/**
 * The app's icons (FE-7): inline SVG components, always `aria-hidden="true"`, so
 * an icon-only control needs its own `aria-label` (A11Y-3). The shapes come from
 * Lucide (https://lucide.dev), ISC licence: Copyright (c) for portions of Lucide
 * are held by Cole Bemis 2013-2023 as part of Feather (MIT). All other copyright
 * (c) for Lucide are held by Lucide Contributors 2025. Permission to use, copy,
 * modify, and/or distribute this software for any purpose with or without fee is
 * hereby granted, provided that the above copyright notice and this permission
 * notice appear in all copies.
 */

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ name, className, children, ...props }: IconProps & { name: string; children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : 'icon'}
      focusable="false"
      data-icon={name}
      {...props}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}


export function WarningIcon(props: IconProps) {
  return <Icon name="warning" {...props}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></Icon>;
}

export function LogOutIcon(props: IconProps) {
  return <Icon name="log-out" {...props}><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /></Icon>;
}

export function SettingsIcon(props: IconProps) {
  return <Icon name="settings" {...props}><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></Icon>;
}

export function CloseIcon(props: IconProps) {
  return <Icon name="close" {...props}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>;
}
