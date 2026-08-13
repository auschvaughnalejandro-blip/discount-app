import QRCode from 'react-qr-code';

/**
 * The back of the membership card, using the supplied artwork unchanged.
 *
 * The artwork already contains the rounded white QR well. The live symbol is
 * laid over that well because an SVG loaded through `<img>` cannot receive
 * per-member React content. Both layers remain SVG, so the card stays sharp at
 * every size.
 *
 * `cardCode` is nullable only while `/member/me` is loading. The API derives it
 * from the member created by the administrator, and the same stable value is
 * used by the outlet scanner and the card-print export.
 */
export function MembershipCardBack({
  cardCode,
  memberNumber,
}: {
  cardCode: string | null;
  memberNumber: string | null;
}) {
  return (
    <div className="membership-card membership-card-back">
      <img
        className="card-face"
        src="/assets/card-back.svg"
        alt="Back of the Privilege Guest membership card"
      />

      {/*
       * A level-M code for the current 83-character card payload is 37 modules
       * square. Padding the artwork's well by 4/45 on every side reserves the
       * four-module quiet zone scanners need around those 37 live modules.
       */}
      <div className="card-back-qr-quiet-zone">
        {cardCode === null ? (
          <span className="skeleton card-back-qr-placeholder" aria-hidden="true" />
        ) : (
          <QRCode
            value={cardCode}
            level="M"
            title={`Membership code for ${memberNumber ?? 'this member'}`}
          />
        )}
      </div>
    </div>
  );
}
