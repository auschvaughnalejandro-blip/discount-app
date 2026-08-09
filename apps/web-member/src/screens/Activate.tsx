import { useState } from 'react';

import { api } from '../api.js';
import { AppShell } from '../components/AppShell.js';
import { BackButton } from '../components/BackButton.js';
import { Button } from '../components/Button.js';
import { Eyebrow } from '../components/Eyebrow.js';
import { Field } from '../components/Field.js';
import { HeroImage } from '../components/HeroImage.js';
import { Toggle } from '../components/Toggle.js';
import { AppLink, useAppNavigate } from '../navigation.js';
import { useSession } from '../session.js';
import { HERO } from './heroes.js';
import { DIAL_CODE, formatNational, looksLikeMobile, toE164, toNationalDigits } from './phone.js';

/**
 * `/activate` — invitation code plus mobile number.
 *
 * Activation is one call. The invitation code arrived in the member's inbox, so
 * receiving it already proved they control that address; there is no second
 * code to wait for.
 *
 * The two consent switches default to email on and SMS off, per the design.
 * Both are recorded per channel and neither is a condition of activating —
 * Qatar's data protection law requires explicit prior consent for direct
 * electronic marketing, so a switch that cannot be turned off would not be
 * consent at all.
 */
export function Activate() {
  const navigate = useAppNavigate();
  const { signIn } = useSession();

  const [claimCode, setClaimCode] = useState('');
  const [national, setNational] = useState('');
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = claimCode.trim().length > 0 && looksLikeMobile(national);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      signIn(
        await api.claimComplete({
          claimCode: claimCode.trim(),
          phone: toE164(national),
          consent: { email, sms },
        }),
      );
      navigate('/offers', { replace: true });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That invitation code was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell bleed>
      <HeroImage height={196} src={HERO.activate}>
        <BackButton to="/signin" label="Back to sign in" />
      </HeroImage>

      <section className="auth">
        <Eyebrow tone="sand">Activate membership</Eyebrow>
        <h1 className="title-auth">Welcome, Privilege Guest</h1>
        <p className="lede">Use the code from your welcome email.</p>

        <form className="panel-card" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            label="Invitation code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="PG–XXXX–XXXX"
            value={claimCode}
            onChange={(event) => {
              setClaimCode(event.target.value);
              setError(null);
            }}
          />

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
            helper="This becomes your sign-in method."
            error={error}
          />

          <hr className="rule" />

          {/* The board reads "NOTIRCATIONS". Corrected on the way in — it is a
              typo in an outlined-text export, not a name. */}
          <Eyebrow tone="muted">Notifications</Eyebrow>

          <Toggle label="Email" checked={email} onChange={setEmail} />
          <Toggle label="SMS" checked={sms} onChange={setSms} />

          <Button type="submit" disabled={!ready || busy}>
            {busy ? 'Activating…' : 'Activate membership'}
          </Button>
        </form>

        <p className="auth-alt">
          <AppLink to="/signin" kind="pop" className="text-link">
            Already activated? Sign in
          </AppLink>
        </p>
      </section>
    </AppShell>
  );
}
