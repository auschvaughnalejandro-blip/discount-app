import { BrowserQRCodeReader } from '@zxing/browser';
import { useEffect, useRef, useState } from 'react';

/**
 * Camera scanning for the outlet screen.
 *
 * Deliberately not the only way in. Typing the membership number has to work as
 * well as scanning, because many members present the printed card rather than the
 * app — and a camera that will not start must never be the reason a guest is
 * turned away at a counter. This component can fail entirely and the screen still
 * works.
 *
 * `@zxing/browser` rather than the native `BarcodeDetector`, which is faster and
 * needs no library but is unavailable in Safari. Staff use whatever is already
 * behind the counter, and in a hotel that is very often an iPad.
 */

/** What ZXing hands back on every frame; a miss is an exception, not a null. */
type ScannerControls = { stop(): void };

export function Scanner({ onScan }: { onScan: (payload: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  /** Guards against the continuous callback firing a second lookup mid-request. */
  const handledRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * `getUserMedia` refuses outside a secure context, so the camera cannot work
   * over plain HTTP. `localhost` counts as secure and a deployed HTTPS host counts
   * as secure; a LAN address like http://192.168.1.40:5176 does not. Staff testing
   * on a counter tablet before TLS exists land here, so the message says what is
   * wrong rather than leaving a dead black rectangle.
   */
  const secure = window.isSecureContext;

  // Stop the camera if this component goes away while running. A camera light left
  // on behind a hotel counter is a support call.
  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  async function start() {
    setError(null);
    handledRef.current = false;

    const video = videoRef.current;
    if (!video) return;

    try {
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromConstraints(
        // The rear camera. A laptop with only a front camera ignores this and still
        // works; a tablet would otherwise point at the member's face.
        { video: { facingMode: 'environment' } },
        video,
        (result) => {
          if (!result || handledRef.current) return;
          handledRef.current = true;
          // Stop before handing off, so the camera is already off by the time the
          // member's record renders.
          controlsRef.current?.stop();
          controlsRef.current = null;
          setRunning(false);
          onScan(result.getText());
        },
      );

      controlsRef.current = controls;
      setRunning(true);
    } catch (cause) {
      // Distinguish "you said no" from "there is no camera", because the fix
      // differs and staff cannot be expected to guess.
      const name = cause instanceof Error ? cause.name : '';
      setError(
        name === 'NotAllowedError'
          ? 'Camera permission was refused. Allow it in the browser, or type the membership number.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera was found on this device. Type the membership number instead.'
            : 'The camera could not be started. Type the membership number instead.',
      );
      setRunning(false);
    }
  }

  function stop() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setRunning(false);
  }

  if (!secure) {
    return (
      <p className="notice" role="status">
        Camera scanning needs a secure (HTTPS) connection. Type the membership number below, or
        paste the code from the guest&rsquo;s app.
      </p>
    );
  }

  return (
    <div className="scanner">
      {/* Not started automatically. A permission prompt on page load gets
          dismissed by reflex, and once refused it is awkward to re-grant. */}
      <button
        type="button"
        className={running ? 'btn btn-outline' : 'btn'}
        onClick={running ? stop : () => void start()}
      >
        {running ? 'Stop camera' : 'Scan a card'}
      </button>

      {/* `playsInline` matters: without it iOS Safari takes the video fullscreen
          and the rest of the screen becomes unreachable. */}
      <video ref={videoRef} className="scanner-preview" hidden={!running} muted playsInline />

      {running ? (
        <p className="notice" role="status">
          Point the camera at the code — on the back of the card, or in the guest&rsquo;s app.
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
