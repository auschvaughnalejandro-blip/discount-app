import { useState } from 'react';

import { ActivityRow } from '../components/ActivityRow.js';
import { AppShell } from '../components/AppShell.js';
import { BackButton } from '../components/BackButton.js';
import { Button } from '../components/Button.js';
import { Chip } from '../components/Chip.js';
import { DetailRow } from '../components/DetailRow.js';
import { Eyebrow } from '../components/Eyebrow.js';
import { Field } from '../components/Field.js';
import { HeroImage } from '../components/HeroImage.js';
import { InfoPanel } from '../components/InfoPanel.js';
import { Lockup } from '../components/Lockup.js';
import { MembershipCard } from '../components/MembershipCard.js';
import { MembershipCardBack } from '../components/MembershipCardBack.js';
import { OtpInput } from '../components/OtpInput.js';
import { StatBar } from '../components/StatBar.js';
import { Toggle } from '../components/Toggle.js';
import { BenefitCard } from '../components/BenefitCard.js';
import { useSession } from '../session.js';

/** Correct card-code shape and length, but deliberately not a valid signature. */
const STRUCTURAL_CARD_CODE = `v2.00000000-0000-4000-8000-000000000000.${'A'.repeat(43)}`;

/**
 * `/styleguide` — every component, in every state, on one page.
 *
 * **Nothing here is mock data.** A gallery has to pass props to render, so the
 * strings below are structural — "Label", "Value", "Title" — chosen precisely
 * because they could never be mistaken for a benefit, a member or an amount.
 * The two sections that need real shapes read them from the API through the
 * same session every other screen uses, and say so when there is no session.
 *
 * That constraint is also enforced from outside: `client-invariants.test.ts`
 * scans every `.tsx` in this app for benefit titles and reservation numbers, so
 * a styleguide that "borrowed" a real-looking benefit would fail the build.
 *
 * The page is not behind the member guard. It renders components, not a
 * member's data, and needing to sign in to look at a button is friction with
 * nothing behind it.
 */
export function Styleguide() {
  const { benefits, redemptions } = useSession();

  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);

  return (
    <AppShell>
      <header className="screen-head">
        <h1 className="title">Styleguide</h1>
        <p className="lede">Every component, in every state.</p>
      </header>

      <Section title="Type">
        <p className="title">Screen title</p>
        <p className="title-auth">Screen title, auth</p>
        <p className="hero-figure">00%</p>
        <Eyebrow tone="sand">Eyebrow, sand</Eyebrow>
        <Eyebrow tone="muted">Eyebrow, muted</Eyebrow>
        <p className="lede">Lede — the sentence under a title.</p>
        <p>Body — the default paragraph.</p>
        <p className="legal">Micro — legal and validity lines.</p>
      </Section>

      <Section title="Buttons">
        <Button>Primary</Button>
        <Button disabled>Primary, disabled</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="outline" disabled>
          Outline, disabled
        </Button>
        <Button href="#styleguide">Primary, as a link</Button>
        <p>
          <button type="button" className="text-link">
            Text link
          </button>
        </p>
      </Section>

      <Section title="Chips">
        <div className="benefit-actions">
          <Chip>Outline</Chip>
          <Chip variant="filled">Filled</Chip>
        </div>
      </Section>

      <Section title="Fields">
        <Field label="Label" placeholder="Placeholder" value={text} onChange={(e) => setText(e.target.value)} />
        <Field
          label="Label with a prefix"
          prefix="+000"
          placeholder="Placeholder"
          value={text}
          onChange={(e) => setText(e.target.value)}
          helper="Helper text sits under the field."
        />
        <Field
          label="Label in error"
          value={text}
          onChange={(e) => setText(e.target.value)}
          error="The error is stated under the field, never in an alert."
        />
        <Field label="Hidden label" hideLabel placeholder="Label is there for a screen reader" />
      </Section>

      <Section title="Passcode">
        <OtpInput value={code} onChange={setCode} />
        <p className="lede">Type, paste six digits, or press backspace on an empty box.</p>
        <OtpInput value="12" onChange={() => undefined} error label="Passcode in error" />
      </Section>

      <Section title="Toggles">
        <Toggle label="On" checked={on} onChange={setOn} />
        <Toggle label="Off" description="With a description" checked={off} onChange={setOff} />
        <Toggle label="Disabled" checked={false} disabled onChange={() => undefined} />
      </Section>

      <Section title="Stat bar">
        <StatBar
          stats={[
            { label: 'Label', value: 'Value', tone: 'sand' },
            { label: 'Label', value: 'Value' },
            { label: 'Unknown', value: null },
          ]}
        />
      </Section>

      <Section title="Detail rows">
        <dl className="detail-list">
          <DetailRow label="Label">Value</DetailRow>
          <DetailRow label="Label, sand value" tone="sand">
            Value
          </DetailRow>
        </dl>
      </Section>

      <Section title="Info panel">
        <InfoPanel title="Good to know">
          <p>The tinted aside that carries a benefit&rsquo;s full conditions.</p>
        </InfoPanel>
      </Section>

      <Section title="Hero">
        <p className="lede">No photography exists yet, so the placeholder is the state you see.</p>
        <HeroImage height={160}>
          <BackButton to="/styleguide" label="Back" />
        </HeroImage>
        <HeroImage height={160}>
          <Lockup />
          <Eyebrow tone="sand">Privilege Guest</Eyebrow>
        </HeroImage>
      </Section>

      <Section title="Lockup">
        <Lockup />
      </Section>

      <Section title="Membership card">
        <p className="lede">Both sides, loading then with structural values.</p>
        <MembershipCard fullName={null} memberNumber={null} />
        <MembershipCard fullName="Name" memberNumber="Number" href="/profile/card" />
        <MembershipCardBack cardCode={null} memberNumber={null} />
        <MembershipCardBack cardCode={STRUCTURAL_CARD_CODE} memberNumber="Number" />
      </Section>

      <Section title="Benefit card">
        {benefits === null ? (
          <p className="empty">
            Needs a signed-in session — these render whatever the API returns, and there is no
            stand-in for it.
          </p>
        ) : (
          <ul className="benefit-list">
            {benefits.map((benefit, index) => (
              <BenefitCard key={benefit.key} benefit={benefit} index={index} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Activity row">
        {redemptions === null || redemptions.length === 0 ? (
          <p className="empty">Needs a signed-in session with at least one recorded visit.</p>
        ) : (
          <ul className="activity-list">
            {redemptions.slice(0, 3).map((row) => (
              <ActivityRow
                key={row.id}
                redemption={row}
                category={benefits?.find((b) => b.key === row.benefit.key)?.category}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Skeletons">
        <span className="skeleton skeleton-line skeleton-title" />
        <span className="skeleton skeleton-line skeleton-sub" />
        <span className="skeleton skeleton-figure" />
      </Section>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section styleguide-section">
      <Eyebrow tone="muted">{title}</Eyebrow>
      {children}
    </section>
  );
}
