import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, type BenefitRequest } from '../api.js';
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
    if (
      benefit === null ||
      (currentRequest?.status !== 'PENDING' && currentRequest?.status !== 'APPROVED')
    ) {
      return;
    }

    // A member may leave this screen open while staff work in the dashboard.
    // Keep the visible status honest without making them reload or sign in
    // again; email remains the out-of-app notification channel.
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

  async function requestBenefit() {
    if (benefit === null || requesting) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const created = await api.requestBenefit(benefit.key, requestNote.trim() || undefined);
      setCurrentRequest(created);
      setRequestNote('');
    } catch (cause) {
      setRequestError(cause instanceof Error ? cause.message : 'Could not send your request.');
    } finally {
      setRequesting(false);
    }
  }

  const canRequest =
    !requestLoading &&
    (currentRequest === null ||
      currentRequest.status === 'DECLINED' ||
      currentRequest.status === 'FULFILLED');

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

        {benefit === null || requestLoading ? null : currentRequest?.status === 'PENDING' ? (
          <div className="request-status" data-status="pending" role="status">
            <strong>Request sent</strong>
            <span>The hotel has been notified. This page will show when it is approved.</span>
          </div>
        ) : currentRequest?.status === 'APPROVED' ? (
          <div className="request-status" data-status="approved" role="status">
            <strong>Approved</strong>
            <span>
              Your benefit is ready. Complete any required reservation, and staff will record it
              after applying the offer.
            </span>
          </div>
        ) : currentRequest?.status === 'DECLINED' ? (
          <div className="request-status" data-status="declined" role="status">
            <strong>Not approved</strong>
            <span>{currentRequest.decisionReason ?? 'Contact the hotel if you need help.'}</span>
          </div>
        ) : currentRequest?.status === 'FULFILLED' ? (
          <div className="request-status" data-status="fulfilled" role="status">
            <strong>Previous use recorded</strong>
            <span>You can send another request when you would like to use this benefit again.</span>
          </div>
        ) : null}

        {canRequest ? (
          <div className="request-action">
            <label className="field-label" htmlFor="benefit-request-note">
              Request details <span className="field-optional">(optional)</span>
            </label>
            <textarea
              id="benefit-request-note"
              className="request-note"
              maxLength={500}
              rows={3}
              placeholder={
                benefit?.reservationPhone
                  ? 'Preferred date, time, and number of guests'
                  : 'Anything the hotel should know'
              }
              value={requestNote}
              onChange={(event) => {
                setRequestNote(event.target.value);
                setRequestError(null);
              }}
            />
            <Button onClick={() => void requestBenefit()} disabled={requesting}>
              {requesting
                ? 'Sending request…'
                : currentRequest === null
                  ? 'Request this benefit'
                  : 'Request this benefit again'}
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
