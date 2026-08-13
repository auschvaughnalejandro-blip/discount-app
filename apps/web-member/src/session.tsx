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
  /** A background history refresh failed; kept separate for the same reason. */
  activityError: string | null;
  signIn: (tokens: { accessToken: string }) => void;
  signOut: () => void;
  /** Re-read the current offer configuration after an administrator changes it. */
  refreshBenefits: () => Promise<void>;
  /**
   * Re-read the redemption history after an outlet records a visit.
   *
   * The member is not the one who writes this. Staff record the visit on their
   * own device, at the counter, while the member is standing there holding a
   * phone that already loaded its history — so unlike every other value in here,
   * this one goes stale through somebody else's action and nothing in the app
   * would ever hear about it. Without an explicit re-read the visit is invisible
   * until the member signs out and back in, which reads as the redemption not
   * having been recorded at all.
   */
  refreshActivity: () => Promise<void>;
  setConsent: (channel: 'email' | 'sms', granted: boolean) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The two fetches a screen may ask for again, as stable module-level functions.
 *
 * Defined out here so `useDedupedFetch` below receives the same identity on
 * every render — a loader rebuilt per render would rebuild the refresh callback,
 * which would restart the visibility listener effect on every render.
 */
const loadBenefits = (fresh: boolean) => api.benefits(fresh).then((result) => result.benefits);
const loadRedemptions = (fresh: boolean) =>
  api.redemptions(fresh).then((result) => result.redemptions);

/**
 * One in-flight request per resource, with the two guarantees the screens rely on.
 *
 * *Deduplication* — `Offers` and `Profile` each refresh their own data when they
 * mount, moments after the initial `load` asked for the same thing. Sharing the
 * pending promise means opening the app makes one request, not two.
 *
 * *Ordering* — a foreground refresh must not be swallowed by an older
 * cache-eligible request, so it queues behind that request instead of joining
 * it, and the sequence check makes the newest response the only one that reaches
 * state. An earlier reply arriving late cannot overwrite a later one.
 *
 * Both rules were written for the benefit fetch and are needed verbatim by the
 * history fetch. Keeping one copy is what stops the two drifting apart.
 */
function useDedupedFetch<T>(
  load: (fresh: boolean) => Promise<T>,
  apply: (value: T) => void,
): (fresh?: boolean) => Promise<T> {
  const inFlight = useRef<{ fresh: boolean; promise: Promise<T> } | null>(null);
  const sequence = useRef(0);

  return useCallback(
    (fresh = false): Promise<T> => {
      const current = inFlight.current;
      if (current !== null && (!fresh || current.fresh)) return current.promise;

      const waitForCurrent = current?.promise.then(
        () => undefined,
        () => undefined,
      );
      const ticket = ++sequence.current;
      const pending = (waitForCurrent ?? Promise.resolve())
        .then(() => load(fresh))
        .then((result) => {
          if (sequence.current === ticket) apply(result);
          return result;
        });
      const request = { fresh, promise: pending };
      inFlight.current = request;
      const clearPending = () => {
        if (inFlight.current === request) inFlight.current = null;
      };
      void pending.then(clearPending, clearPending);
      return pending;
    },
    [load, apply],
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('resuming');
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [benefits, setBenefits] = useState<Benefit[] | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [benefitsError, setBenefitsError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const fetchBenefits = useDedupedFetch(loadBenefits, setBenefits);
  const fetchRedemptions = useDedupedFetch(loadRedemptions, setRedemptions);

  const load = useCallback(async () => {
    try {
      // In parallel: none of the three depends on another, and on a hotel
      // network three round trips in series is the difference between a screen
      // that fills in and one that arrives.
      //
      // The two fetches own their own state, so an older initial request can
      // never overwrite a newer foreground refresh that overtook it.
      const [me] = await Promise.all([api.me(), fetchBenefits(), fetchRedemptions()]);
      setProfile(me);
      setError(null);
      setBenefitsError(null);
      setActivityError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your membership.');
    }
  }, [fetchBenefits, fetchRedemptions]);

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
    setActivityError(null);
  }, []);

  const refreshBenefits = useCallback(async () => {
    try {
      await fetchBenefits(true);
      setBenefitsError(null);
    } catch (cause) {
      setBenefitsError(cause instanceof Error ? cause.message : 'Could not refresh your benefits.');
    }
  }, [fetchBenefits]);

  const refreshActivity = useCallback(async () => {
    try {
      await fetchRedemptions(true);
      setActivityError(null);
    } catch (cause) {
      // Deliberately not `setError`: the history already on screen is still
      // worth reading, and a whole-screen alert over a failed background re-read
      // would tell a member something is wrong with a membership that is fine.
      setActivityError(cause instanceof Error ? cause.message : 'Could not refresh your visits.');
    }
  }, [fetchRedemptions]);

  useEffect(() => {
    if (status !== 'signed-in') return;

    // A member may leave the installed app open for days. Re-read when they
    // return to it, so neither an administrator's rate change nor a visit an
    // outlet recorded at the counter waits for the next sign-in to appear.
    //
    // The history belongs here as much as the rates do, and for a stronger
    // reason: the member cannot cause it to change from inside this app, so a
    // foreground re-read is the *only* moment the app can learn about a
    // redemption somebody else wrote.
    const refreshAll = () => {
      void refreshBenefits();
      void refreshActivity();
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshAll();
      }
    };

    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('online', refreshAll);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('online', refreshAll);
    };
  }, [status, refreshBenefits, refreshActivity]);

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
      activityError,
      signIn,
      signOut,
      refreshBenefits,
      refreshActivity,
      setConsent,
    }),
    [
      status,
      profile,
      benefits,
      redemptions,
      error,
      benefitsError,
      activityError,
      signIn,
      signOut,
      refreshBenefits,
      refreshActivity,
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
