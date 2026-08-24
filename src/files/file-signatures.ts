/**
 * Checks that a file's bytes look like the type it claims to be.
 *
 * The allow-list in `FilesService` reads `Content-Type` from the multipart part,
 * which is whatever the client wrote there — so on its own it stops an honest
 * client from uploading a `.exe` and does nothing about a dishonest one. This is
 * the half that looks at the file.
 *
 * What it prevents is a store of executables and HTML pages sitting inside a
 * school's document list, labelled as images, waiting for the day somebody
 * serves them `inline` or a browser sniffs past the header. Downloads go out as
 * `attachment` today; this is what keeps that from being the only thing standing
 * in the way.
 *
 * Hand-rolled rather than a library: nine types, each identified by a handful of
 * bytes at a known offset, against a dependency that brings a few hundred
 * formats nobody here accepts.
 */

/** Bytes that must appear at a given offset for the type to be plausible. */
type Signature = { offset: number; bytes: readonly number[] };

const ascii = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

/**
 * One or more acceptable signatures per type. Several, where a format has
 * variants — HEIC's brand box and the OOXML container are both like this.
 */
const SIGNATURES: Record<string, readonly Signature[]> = {
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [
    { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  ],
  // ISO base media format: the brand sits after the box header, and phones write
  // several brands for what a person calls a HEIC photo.
  'image/heic': [
    { offset: 4, bytes: ascii('ftypheic') },
    { offset: 4, bytes: ascii('ftypheix') },
    { offset: 4, bytes: ascii('ftyphevc') },
    { offset: 4, bytes: ascii('ftypmif1') },
    { offset: 4, bytes: ascii('ftypmsf1') },
  ],
  // RIFF container with a WEBP form type: both halves, or a WAV file would pass.
  'image/webp': [{ offset: 0, bytes: ascii('RIFF') }],
  'application/pdf': [{ offset: 0, bytes: ascii('%PDF-') }],
  // The old Office format is an OLE2 compound document.
  'application/msword': [
    { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  ],
  // The modern ones are zip archives. That is as far as a signature can go: a
  // `.docx` and a `.zip` are the same bytes at the front, so this rules out
  // everything that is not an archive and no more.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { offset: 0, bytes: ascii('PK') },
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    { offset: 0, bytes: ascii('PK') },
  ],
};

function matches(buffer: Buffer, signature: Signature): boolean {
  if (buffer.length < signature.offset + signature.bytes.length) return false;

  return signature.bytes.every(
    (byte, index) => buffer[signature.offset + index] === byte,
  );
}

/**
 * Whether these bytes are plausibly the declared type.
 *
 * A type with no signature is judged by what it must *not* contain instead:
 * plain text has no header, so the check is that it reads as text at all. A NUL
 * byte is the giveaway — no encoding of a text document contains one, and every
 * compiled binary does.
 *
 * Unknown types are rejected. This is only ever reached for a type the
 * allow-list already accepted, so an unknown one here means the two lists have
 * drifted apart, and failing closed is what makes that a bug somebody notices
 * rather than a hole.
 */
export function bytesLookLike(mimeType: string, buffer: Buffer): boolean {
  if (mimeType === 'text/plain') {
    return !buffer.includes(0);
  }

  if (mimeType === 'image/webp') {
    return (
      matches(buffer, { offset: 0, bytes: ascii('RIFF') }) &&
      matches(buffer, { offset: 8, bytes: ascii('WEBP') })
    );
  }

  const candidates = SIGNATURES[mimeType];
  if (!candidates) return false;

  return candidates.some((signature) => matches(buffer, signature));
}
