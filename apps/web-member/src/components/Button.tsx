import type { ReactNode } from 'react';

/**
 * The two buttons the design system has.
 *
 * `primary` is the sand pill — one per screen, the action that screen exists
 * for. `outline` is the same metrics with a hairline border and no fill, for
 * everything that is a real action but not *the* action ("Sign out", "Screen
 * brightness").
 *
 * Rendering as an `<a>` when `href` is present is not a convenience. The offer
 * detail screen's call-to-action is a `tel:` link, and a `<button>` with an
 * onClick that sets `location.href` loses long-press, "copy number", and the
 * fact that a screen reader announces it as a link to a phone number. The
 * design draws them identically; the markup should not pretend they are.
 */

type Variant = 'primary' | 'outline';

interface CommonProps {
  variant?: Variant;
  children: ReactNode;
  /** Stretches to the container. The default for a screen's main action. */
  full?: boolean;
  className?: string;
}

interface ButtonProps extends CommonProps {
  href?: undefined;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
}

interface LinkProps extends CommonProps {
  href: string;
  type?: undefined;
  onClick?: undefined;
  disabled?: undefined;
}

export function Button(props: ButtonProps | LinkProps) {
  const { variant = 'primary', children, full = true, className } = props;
  const classes = ['btn', `btn-${variant}`, full ? 'btn-full' : null, className]
    .filter(Boolean)
    .join(' ');

  if (props.href !== undefined) {
    return (
      <a className={classes} href={props.href}>
        {children}
      </a>
    );
  }

  return (
    <button
      className={classes}
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled ?? false}
    >
      {children}
    </button>
  );
}
