import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ApiError, api, type BenefitRequest, type OutletChoice } from '../api.js';
import { AppShell } from '../components/AppShell.js';
import { BackButton } from '../components/BackButton.js';
import { Button } from '../components/Button.js';
import { DetailRow } from '../components/DetailRow.js';
import { HeroImage } from '../components/HeroImage.js';
import { InfoPanel } from '../components/InfoPanel.js';
import { heroForBenefit } from './heroes.js';
import { useSession } from '../session.js';

/**
 * `/offers/:slug` — one benefit in full.
 *
 * The reservation number is the highest-value thing on this screen. Three
 * benefits carry three different numbers, currently living on a sheet that gets
 * lost, so it appears twice: as a detail row and as the screen's call to
 * action — a real `tel:` link, which is what makes it one tap from here to a
 * table rather than a number to copy out.
 *
 * `slug` is the benefit's public key. It is the same key `GET /benefits`
 * returns and the same one a benefit request quotes back, so a URL a member
 * bookmarks keeps working across a rename of the benefit's title.
 */
export function OfferDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { benefits } = useSession();
  const [currentRequest, setCurrentRequest] = useState<BenefitRequest | null>(null);
  const [requestNote, setRequestNote] = useState('');
  const [requestLoading, setRequestLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  /**
   * Where the guest is going.
   *
   * Empty until the server says it needs one. A benefit honoured by a single
   * outlet never asks — the server fills it in — so a picker rendered up front
   * would be a required-looking field with one option in it on most screens.
   */
  const [outlets, setOutlets] = useState<OutletChoice[]>([]);
  const [chosenOutlet, setChosenOutlet] = useState<string>('');

  const benefit = benefits?.find((row) => row.key === slug) ?? null;

  useEffect(() => {
    if (benefit === null) {
      setRequestLoading(benefits === null);
      return;
    }

    let cancelled = false;
    setRequestLoading(true);
    setRequestError(null);
    void api
      .requests()
      .then(({ requests }) => {
        if (!cancelled) {
          // The endpoint is newest-first. A fulfilled or declined request stays
          // visible as history, while a new request replaces it here.
          setCurrentRequest(requests.find((row) => row.benefit.key === benefit.key) ?? null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setRequestError(
            cause instanceof Error ? cause.message : 'Could not load your request status.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRequestLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [benefit?.key, benefits]);

  useEffect(() => {
    // Only while a notice is open. There is nothing else worth watching: every
    // other state is terminal, so polling one would be asking a settled question
    // every fifteen seconds for as long as the screen stays open.
    if (benefit === null || currentRequest?.status !== 'SENT') {
      return;
    }

    // A member may leave this screen open while the outlet confirms them at the
    // counter. Keep the visible status honest without making them reload or sign
    // in again; email remains the out-of-app notification channel.
    const timer = window.setInterval(() => {
      void api.requests().then(({ requests }) => {
        setCurrentRequest(requests.find((row) => row.benefit.key === benefit.key) ?? null);
      }).catch(() => {
        // A transient refresh failure must not replace a known-good status
        // with an error. The next interval gets another chance.
      });
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [benefit?.key, currentRequest?.status]);

  async function announce() {
    if (benefit === null || requesting) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const created = await api.announceVisit(benefit.key, {
        ...(chosenOutlet ? { outletId: chosenOutlet } : {}),
        ...(requestNote.trim() ? { note: requestNote.trim() } : {}),
      });
      setCurrentRequest(created);
      setRequestNote('');
      setOutlets([]);
      setChosenOutlet('');
    } catch (cause) {
      // The server refuses to guess which outlet, and sends the list with the
      // refusal. Reading it here is what turns a dead end into the next step —
      // and avoids a second round trip for something already in hand.
      if (
        cause instanceof ApiError &&
        (cause.code === 'outlet_required' || cause.code === 'outlet_not_valid') &&
        Array.isArray(cause.details['outlets'])
      ) {
        setOutlets(cause.details['outlets'] as OutletChoice[]);
        setChosenOutlet('');
      }
      setRequestError(cause instanceof Error ? cause.message : 'Could not tell the outlet.');
    } finally {
      setRequesting(false);
    }
  }

  /**
   * A notice is open, or it is not. There is nothing in between any more — no
   * approval to wait for, so the only state that blocks announcing again is one
   * the outlet has not closed out yet.
   */
  const canAnnounce = !requestLoading && currentRequest?.status !== 'SENT';

  if (benefits !== null && benefit === null) {
    return (
      <AppShell>
        <header className="screen-head screen-head-inset">
          <BackButton to="/offers" label="Back to benefits" />
          <h1 className="title">Not available</h1>
          <p className="lede">That benefit is not part of your membership.</p>
        </header>
      </AppShell>
    );
  }

  return (
    <AppShell bleed>
      <HeroImage height={300} src={benefit === null ? undefined : heroForBenefit(benefit.key)}>
        <BackButton to="/offers" label="Back to benefits" />
      </HeroImage>

      <section className="detail">
        <h1 className="title">
          {benefit?.title ?? <span className="skeleton skeleton-line skeleton-title" />}
        </h1>

        <div className="detail-figure">
          <p className="hero-figure">
            {benefit === null ? (
              <span className="skeleton skeleton-figure" />
            ) : (
              `${benefit.discountPct}%`
            )}
          </p>
          <p className="detail-qualifier">
            off across
            <br />
            this benefit
          </p>
        </div>

        <hr className="rule rule-sand" />

        <dl className="detail-list">
          {benefit?.secondaryLabel != null && benefit.secondaryPct != null ? (
            <DetailRow label={benefit.secondaryLabel}>{benefit.secondaryPct}%</DetailRow>
          ) : null}

          {benefit?.maxGuests == null ? null : (
            <DetailRow label="Maximum guests">{benefit.maxGuests}</DetailRow>
          )}
          {benefit?.minGuests == null ? null : (
            <DetailRow label="Minimum guests">{benefit.minGuests}</DetailRow>
          )}

          {benefit?.reservationPhone == null ? null : (
            <DetailRow label="Reservations" tone="sand">
              {benefit.reservationPhone}
            </DetailRow>
          )}
        </dl>

        {benefit === null ? null : (
          <InfoPanel title="Good to know">
            {/* The full conditions, verbatim from the API. This is where a
                disagreement at a spa reception gets prevented, so it is not
                summarised or truncated. */}
            <p>{benefit.terms}</p>
          </InfoPanel>
        )}

        {benefit === null || requestLoading ? null : currentRequest?.status === 'SENT' ? (
          <div className="request-status" data-status="approved" role="status">
            <strong>{currentRequest.outlet?.name ?? 'The outlet'} knows you are coming</strong>
            <span>
              Nothing to wait for — just turn up and show your card. The discount is applied
              at the outlet and recorded afterwards.
            </span>
          </div>
        ) : currentRequest?.status === 'NOT_USED' ? (
          <div className="request-status" data-status="declined" role="status">
            <strong>Not used</strong>
            <span>
              {currentRequest.closedReason ??
                'That visit did not happen, so nothing was recorded.'}{' '}
              Your benefit is untouched — use it whenever you like.
            </span>
          </div>
        ) : currentRequest?.status === 'FULFILLED' ? (
          <div className="request-status" data-status="fulfilled" role="status">
            <strong>Previous use recorded</strong>
            <span>Let an outlet know again whenever you would like to use this benefit.</span>
          </div>
        ) : currentRequest?.status === 'APPROVED' || currentRequest?.status === 'PENDING' ? (
          /* A row from before outlets closed their own notices. Shown so the
             history is not a blank, and worded so nobody waits for an approval
             that is never coming. */
          <div className="request-status" data-status="approved" role="status">
            <strong>Earlier request</strong>
            <span>Go ahead and show your card at the outlet — nothing else is needed.</span>
          </div>
        ) : currentRequest?.status === 'DECLINED' ? (
          <div className="request-status" data-status="declined" role="status">
            <strong>Earlier request was not approved</strong>
            <span>{currentRequest.closedReason ?? 'You can use this benefit now regardless.'}</span>
          </div>
        ) : null}

        {canAnnounce ? (
          <div className="request-action">
            {/* Only rendered once the server has said it needs one, and it arrives
                with the list already attached to the refusal. */}
            {outlets.length > 0 ? (
              <>
                <label className="field-label" htmlFor="benefit-outlet">
                  Where are you going?
                </label>
                <select
                  id="benefit-outlet"
                  className="request-outlet"
                  value={chosenOutlet}
                  onChange={(event) => {
                    setChosenOutlet(event.target.value);
                    setRequestError(null);
                  }}
                >
                  <option value="">Choose an outlet…</option>
                  {outlets.map((outlet) => (
                    <option key={outlet.id} value={outlet.id}>
                      {outlet.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <label className="field-label" htmlFor="benefit-request-note">
              Anything they should know <span className="field-optional">(optional)</span>
            </label>
            <textarea
              id="benefit-request-note"
              className="request-note"
              maxLength={500}
              rows={3}
              placeholder={
                benefit?.reservationPhone
                  ? 'Preferred date, time, and number of guests'
                  : 'Anything the outlet should know'
              }
              value={requestNote}
              onChange={(event) => {
                setRequestNote(event.target.value);
                setRequestError(null);
              }}
            />
            <Button
              onClick={() => void announce()}
              disabled={requesting || (outlets.length > 0 && chosenOutlet === '')}
            >
              {requesting
                ? 'Telling the outlet…'
                : currentRequest === null
                  ? 'Let the outlet know'
                  : 'Let the outlet know again'}
            </Button>
          </div>
        ) : null}

        {requestError ? (
          <p className="field-error request-error" role="alert">
            {requestError}
          </p>
        ) : null}

        {benefit?.reservationPhone == null ? null : (
          <Button
            href={`tel:${benefit.reservationPhone.replace(/\s/g, '')}`}
            variant="outline"
            className="reservation-call"
          >
            Call {benefit.reservationPhone}
          </Button>
        )}

        <p className="legal">
          Benefits are subject to change. You will be notified of significant changes.
        </p>
      </section>
    </AppShell>
  );
}
