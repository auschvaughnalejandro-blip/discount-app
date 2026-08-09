import { useState } from 'react';

import { api } from '../api.js';
import { AppLink, useAppNavigate } from '../navigation.js';
import { AppShell } from '../components/AppShell.js';
import { Button } from '../components/Button.js';
import { Eyebrow } from '../components/Eyebrow.js';
import { Field } from '../components/Field.js';
import { HeroImage } from '../components/HeroImage.js';
import { Lockup } from '../components/Lockup.js';
import { HERO } from './heroes.js';
import { DIAL_CODE, formatNational, looksLikeMobile, toE164, toNationalDigits } from './phone.js';

/**
 * `/signin` — the mobile number.
 *
 * The number is carried to the passcode screen in router state rather than in
 * the URL. A phone number in a path or a query string reaches browser history,
 * the referrer header and any server log in between, which is the same argument
 * `security-implementation.md` §4 makes about tokens; a member's number is not
 * a credential but it is personal data and there is no reason to publish it.
 *
 * The consequence is that reloading `/signin/verify` has no number to show, so
 * that screen sends the member back here rather than guessing.
 */
export function SignIn() {
  const navigate = useAppNavigate();
  const [national, setNational] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = looksLikeMobile(national);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const phone = toE164(national);
      await api.signInRequestOtp(phone);
      navigate('/signin/verify', { state: { phone, national } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell bleed>
      <HeroImage height={260} src={HERO.auth}>
        <Lockup />
        <Eyebrow tone="sand">Privilege Guest</Eyebrow>
      </HeroImage>

      <section className="auth">
        <h1 className="title-auth">Welcome back</h1>
        <p className="lede">Sign in with your mobile number.</p>

        <form className="panel-card" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            label="Mobile number"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="3312 3456"
            prefix={DIAL_CODE}
            value={formatNational(national)}
            onChange={(event) => {
              setNational(toNationalDigits(event.target.value));
              setError(null);
            }}
            error={error}
          />

          <Button type="submit" disabled={!ready || busy}>
            {busy ? 'Sending…' : 'Send passcode'}
          </Button>
        </form>

        <p className="auth-alt">
          <AppLink to="/activate" className="text-link">
            Have an invitation code?
          </AppLink>
        </p>

        <p className="legal">
          Membership is by invitation. By continuing you agree to the programme terms and to us
          contacting you about your membership.
        </p>
      </section>
    </AppShell>
  );
}
