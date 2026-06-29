import type { ItemKind } from "./api";

type P = { className?: string };
const S = ({ children, className = "ico" }: { children: React.ReactNode; className?: string }) => (
  <svg className={className} viewBox="0 0 24 24">{children}</svg>
);

export const IconOverview = (p: P) => (
  <S {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></S>
);
export const IconItems = (p: P) => (
  <S {...p}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5" /></S>
);
export const IconShelf = (p: P) => (
  <S {...p}><path d="M4 5h16M4 12h16M4 19h16" /><rect x="6" y="3" width="3" height="4" rx="1" /><rect x="13" y="10" width="3" height="4" rx="1" /></S>
);
export const IconBundles = (p: P) => (
  <S {...p}><path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" /></S>
);
export const IconActivity = (p: P) => (<S {...p}><path d="M3 12h4l2 6 4-14 2 8h6" /></S>);
export const IconSettings = (p: P) => (
  <S {...p}><circle cx="12" cy="12" r="3.2" /><path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.8 7.8 0 0 0-1.7-1l-.4-2.6h-4l-.3 2.6a7.8 7.8 0 0 0-1.8 1l-2.3-1-2 3.4L4.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.8 7.8 0 0 0 1.8 1l.3 2.6h4l.4-2.6a7.8 7.8 0 0 0 1.7-1l2.3 1 2-3.4z" /></S>
);
export const IconSearch = (p: P) => (<S {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></S>);
export const IconSync = (p: P) => (<S {...p}><path d="M20 11a8 8 0 0 0-14-4M4 5v3h3M4 13a8 8 0 0 0 14 4M20 19v-3h-3" /></S>);
export const IconCheck = (p: P) => (<S {...p}><path d="M5 12l5 5 9-11" /></S>);
export const IconClose = (p: P) => (<S {...p}><path d="M6 6l12 12M18 6L6 18" /></S>);
export const IconMore = (p: P) => (<S {...p}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></S>);
export const IconChevron = (p: P) => (<S {...p}><path d="M8 9l4-4 4 4M8 15l4 4 4-4" /></S>);
export const IconClock = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></S>);
export const IconCopy = (p: P) => (<S {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></S>);
export const IconMenu = (p: P) => (<S {...p}><path d="M4 6h16M4 12h16M4 18h16" /></S>);

export function KindIcon({ kind, className }: { kind: ItemKind; className?: string }) {
  switch (kind) {
    case "skills":
      return <S className={className}><path d="M4 6h16M4 12h10M4 18h7" /></S>;
    case "settings":
      return <S className={className}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /></S>;
    case "mcp":
      return <S className={className}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></S>;
    case "codex-config":
      return <S className={className}><path d="M12 3v18M5 8l7-5 7 5" /></S>;
  }
}
