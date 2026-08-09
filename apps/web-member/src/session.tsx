import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  api,
  clearTokens,
  resumeSession,
  setTokens,
  type Benefit,
  type ConsentState,
  type MemberProfile,
  type Redemption,
} from './api.js';

/**
 * Who is signed in, and everything the screens read.
 *
 * The seven screens share three fetches — the profile, the benefits and the
 * redemption history — and two of them are needed by more than one screen: the
 * card modal wants the profile, Recent Activity wants both the history and the
 * benefits (for each visit's category). Fetching per screen would mean the card
 * modal re-requesting a profile the Profile screen behind it already has, on
 * every open.
 *
 * `status` distinguishes three states that look alike and are not:
 *
 * - `resuming` — we do not yet know whether the refresh cookie holds a session.
 *   Rendering the sign-in screen here would show every returning member a form
 *   they never needed, for as long as one request takes.
 * - `signed-out` — nobody is signed in. The ordinary case, not an error.
 * - `signed-in` — there is an access token; the data may still be arriving.
 *
 * Nothing in here holds a token. The access token lives in `api.ts` as a module
 * variable and the refresh token is an httpOnly cookie this code cannot read —
 * see the note there. Putting either in React state would place a credential in
 * a devtools panel.
 */

type Status = 'resuming' | 'signed-out' | 'signed-in';

interface SessionValue {
  status: Status;
  profile: MemberProfile | null;
  benefits: Benefit[] | null;
  redemptions: Redemption[] | null;
  /** A failure to load, in words a member can read. Never a stack trace. */
  error: string | null;
  /** A background offer refresh failed; kept separate from profile/history errors. */
  benefitsError: string | null;
  signIn: (tokens: { accessToken: string }) => void;
  signOut: () => void;
  /** Re-read the current offer configuration after an administrator changes it. */
  refreshBenefits: () => Promise<void>;
  setConsent: (channel: 'email' | 'sms', granted: boolean) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('resuming');
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [benefits, setBenefits] = useState<Benefit[] | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [benefitsError, setBenefitsError] = useState<string | null>(null);
  const benefitsRequest = useRef<{ fresh: boolean; promise: Promise<Benefit[]> } | null>(null);
  const benefitsRequestSequence = useRef(0);

  const fetchBenefits = useCallback((fresh = false): Promise<Benefit[]> => {
    const current = benefitsRequest.current;
    if (current !== null && (!fresh || current.fresh)) return current.promise;

    // A foreground refresh must not be swallowed by an older cache-eligible
    // request. Queue it immediately after that request so the authoritative
    // response is always the final one applied to state.
    const waitForCurrent = current?.promise.then(
      () => undefined,
      () => undefined,
    );
    const sequence = ++benefitsRequestSequence.current;
    const pending = (waitForCurrent ?? Promise.resolve())
      .then(() => api.benefits(fresh))
      .then((result) => {
        if (benefitsRequestSequence.current === sequence) {
          setBenefits(result.benefits);
        }
        return result.benefits;
      });
    const request = { fresh, promise: pending };
    benefitsRequest.current = request;
    const clearPending = () => {
      if (benefitsRequest.current === request) benefitsRequest.current = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }, []);

  const load = useCallback(async () => {
    try {
      // In parallel: none of the three depends on another, and on a hotel
      // network three round trips in series is the difference between a screen
      // that fills in and one that arrives.
      const [me, , history] = await Promise.all([
        api.me(),
        fetchBenefits(),
        api.redemptions(),
      ]);
      setProfile(me);
      // `fetchBenefits` owns the benefit state so an older initial request can
      // never overwrite a newer foreground refresh.
      setRedemptions(history.redemptions);
      setError(null);
      setBenefitsError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your membership.');
    }
  }, [fetchBenefits]);

  useEffect(() => {
    void (async () => {
      const resumed = await resumeSession();
      setStatus(resumed ? 'signed-in' : 'signed-out');
    })();
  }, []);

  useEffect(() => {
    if (status === 'signed-in') {
      void load();
    }
  }, [status, load]);

  const signIn = useCallback((tokens: { accessToken: string }) => {
    setTokens(tokens);
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(() => {
    clearTokens();
    setStatus('signed-out');
    setProfile(null);
    setBenefits(null);
    setRedemptions(null);
    setError(null);
    setBenefitsError(null);
  }, []);

  const refreshBenefits = useCallback(async () => {
    try {
      await fetchBenefits(true);
      setBenefitsError(null);
    } catch (cause) {
      setBenefitsError(cause instanceof Error ? cause.message : 'Could not refresh your benefits.');
    }
  }, [fetchBenefits]);

  useEffect(() => {
    if (status !== 'signed-in') return;

    // A member may leave the installed app open for days. Re-read the current
    // rates when they return to it so an administrator's edit does not wait for
    // the next sign-in before it reaches the screen.
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshBenefits();
      }
    };

    const refreshWhenOnline = () => void refreshBenefits();

    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('online', refreshWhenOnline);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('online', refreshWhenOnline);
    };
  }, [status, refreshBenefits]);

  const setConsent = useCallback(async (channel: 'email' | 'sms', granted: boolean) => {
    try {
      // The server appends a new consent record and the newest wins, so the
      // response is the authority on the resulting state — not the boolean we
      // just sent it.
      const result = await api.updateConsent({ [channel]: granted });
      setProfile((current) =>
        current === null ? current : { ...current, consent: result.consent },
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that.');
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      profile,
      benefits,
      redemptions,
      error,
      benefitsError,
      signIn,
      signOut,
      refreshBenefits,
      setConsent,
    }),
    [
      status,
      profile,
      benefits,
      redemptions,
      error,
      benefitsError,
      signIn,
      signOut,
      refreshBenefits,
      setConsent,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession was called outside SessionProvider.');
  }
  return value;
}

/** The current state of one consent channel, or false if it was never set. */
export function consentGranted(
  consent: Record<string, ConsentState | null> | undefined,
  channel: 'email' | 'sms',
): boolean {
  return consent?.[channel.toUpperCase()]?.granted ?? false;
}
