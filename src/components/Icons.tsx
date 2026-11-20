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

export function DownloadIcon(props: IconProps) {
  return <Icon name="download" {...props}><path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /></Icon>;
}

export function SearchIcon(props: IconProps) {
  return <Icon name="search" {...props}><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></Icon>;
}

export function TrashIcon(props: IconProps) {
  return <Icon name="trash" {...props}><path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></Icon>;
}

export function EyeIcon(props: IconProps) {
  return <Icon name="eye" {...props}><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></Icon>;
}

export function UploadIcon(props: IconProps) {
  return <Icon name="upload" {...props}><path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></Icon>;
}

export function ArrowLeftIcon(props: IconProps) {
  return <Icon name="arrow-left" {...props}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></Icon>;
}

export function ArrowRightIcon(props: IconProps) {
  return <Icon name="arrow-right" {...props}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></Icon>;
}

export function CheckCircleIcon(props: IconProps) {
  return <Icon name="circle-check" {...props}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></Icon>;
}

export function FlagIcon(props: IconProps) {
  return <Icon name="flag" {...props}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" x2="4" y1="22" y2="15" /></Icon>;
}

export function XCircleIcon(props: IconProps) {
  return <Icon name="circle-x" {...props}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></Icon>;
}

export function RotateCcwIcon(props: IconProps) {
  return <Icon name="rotate-ccw" {...props}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></Icon>;
}

export function RefreshIcon(props: IconProps) {
  return <Icon name="refresh-cw" {...props}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></Icon>;
}

export function LogInIcon(props: IconProps) {
  return <Icon name="log-in" {...props}><path d="m10 17 5-5-5-5" /><path d="M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /></Icon>;
}

export function UserRoundIcon(props: IconProps) {
  return <Icon name="user-round" {...props}><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></Icon>;
}

export function PencilIcon(props: IconProps) {
  return <Icon name="pencil" {...props}><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></Icon>;
}

export function PlusIcon(props: IconProps) {
  return <Icon name="plus" {...props}><path d="M5 12h14" /><path d="M12 5v14" /></Icon>;
}

export function ClipboardCheckIcon(props: IconProps) {
  return <Icon name="clipboard-check" {...props}><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></Icon>;
}

export function SendIcon(props: IconProps) {
  return <Icon name="send" {...props}><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /><path d="m21.854 2.147-10.94 10.939" /></Icon>;
}

export function FolderIcon(props: IconProps) {
  return <Icon name="folder" {...props}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Icon>;
}

export function TrophyIcon(props: IconProps) {
  return <Icon name="trophy" {...props}><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></Icon>;
}
