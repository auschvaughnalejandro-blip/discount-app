import { AppLink } from '../navigation.js';

/**
 * Offers and Profile — the app's two sections.
 *
 * `kind="fade"` on both: they are peers, and a slide between them would imply
 * one sits to the side of the other. That is the grammar of a hierarchy the tab
 * bar does not have, and it makes the direction of travel meaningless because
 * both directions are equally "forward".
 *
 * The active state is carried by `aria-current="page"` and styled off that
 * attribute, so what a screen reader announces and what the eye sees cannot
 * drift apart.
 */

/* Drawn here rather than pulled from an icon font or a sprite: two marks is
   less than either of those costs, and they inherit the link's colour through
   `currentColor` so the active state needs no second rule. */
const GLYPHS = {
  /* Three rules, evenly spaced — the list the tab opens onto. */
  offers: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),
  /* Head and shoulders: the standard mark for "you". */
  profile: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </>
  ),
} as const;

const TABS = [
  { key: 'offers', label: 'Offers', to: '/offers' },
  { key: 'profile', label: 'Profile', to: '/profile' },
] as const;

export function TabBar({ active }: { active: 'offers' | 'profile' }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      <ul className="tabbar-list">
        {TABS.map((tab) => (
          <li key={tab.key} className="tabbar-item">
            <AppLink
              to={tab.to}
              kind="fade"
              className="tabbar-link"
              aria-current={active === tab.key ? 'page' : undefined}
            >
              <svg
                className="tabbar-glyph"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {GLYPHS[tab.key]}
              </svg>
              <span className="tabbar-label">{tab.label}</span>
            </AppLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
