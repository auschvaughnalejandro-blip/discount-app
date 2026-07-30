import { BrowserQRCodeReader } from '@zxing/browser';
import { useEffect, useRef, useState } from 'react';

import './scanner.css';

/**
 * Camera scanning for the staff verification page (wireframes screen 9).
 *
 * Deliberately not the only way in. Screen 9 note 2 requires typing the
 * membership number to work as well as scanning, because many members present
 * the printed card rather than the app — and a camera that will not start must
 * never be the reason a member is turned away at a counter. This component can
 * fail entirely and the page still works.
 *
 * `@zxing/browser` rather than the native `BarcodeDetector`, which is faster and
 * needs no library but is unavailable in Safari. §6 says staff use "any device
 * already behind the counter", and in a hotel that is very often an iPad.
 */

/** What ZXing hands back on every frame; a miss is an exception, not a null. */
type ScannerControls = { stop(): void };

export default function Scanner({ onScan }: { onScan: (payload: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  /** Guards against the continuous callback firing a second lookup mid-request. */
  const handledRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * `getUserMedia` refuses outside a secure context, so the camera cannot work
   * over plain HTTP. `localhost` counts as secure and a deployed HTTPS host
   * counts as secure; a LAN IP like http://192.168.1.40:5174 does not. Staff
   * testing on a counter tablet before TLS exists will land here, so the
   * message says what is wrong rather than leaving a dead black rectangle.
   */
  const secure = window.isSecureContext;

  // Stop the camera if this component goes away while running. A camera light
  // left on behind a hotel counter is a support call.
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
    if (!video) {
      return;
    }

    try {
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromConstraints(
        // The rear camera. A laptop with only a front camera ignores this and
        // still works; a tablet would otherwise point at the member's face.
        { video: { facingMode: 'environment' } },
        video,
        (result) => {
          if (!result || handledRef.current) {
            return;
          }
          handledRef.current = true;
          // Stop before handing off, so the camera is already off by the time
          // the member's record renders.
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
          ? 'Camera permission was refused. Allow it in the browser, or enter the membership number below.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera was found on this device. Enter the membership number below.'
            : 'The camera could not be started. Enter the membership number below.',
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
      <p role="status">
        Camera scanning needs a secure (HTTPS) connection. Paste the scanned code or enter the
        membership number below.
      </p>
    );
  }

  return (
    <div>
      {/* Not started automatically. A permission prompt on page load gets
          dismissed by reflex, and once refused it is awkward to re-grant. */}
      <p>
        <button type="button" onClick={running ? stop : () => void start()}>
          {running ? 'Stop camera' : 'Scan with camera'}
        </button>
      </p>

      {/* `playsInline` matters: without it iOS Safari takes the video
          fullscreen and the rest of the form becomes unreachable. */}
      <video ref={videoRef} className="scanner-preview" hidden={!running} muted playsInline />

      {running ? <p role="status">Point the camera at the member&rsquo;s code.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
