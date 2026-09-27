/**
 * ORAIN-0739 — download body validation (pure functions).
 *
 * RED phase of TDD: tests written BEFORE the implementation. The file
 * this covers (`download-validation.ts`) does not exist yet, so the
 * import below is expected to fail with "Cannot find module".
 *
 * Plan reference: Task 1 (validateAudioBody) and Task 2
 * (validateDownloadSize). The size tests are appended at the end of
 * the same file.
 */
import { describe, it, expect } from 'vitest';
import { validateAudioBody, isProbablyTextual } from './download-validation';

const HEX = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('validateAudioBody', () => {
  it('accepts an ID3v2 MP3 header (track A)', () => {
    const buf = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from([0x03, 0x00]),
      HEX('00001000'),
      Buffer.alloc(2048),
    ]);
    expect(validateAudioBody(buf)).toEqual({ ok: true });
  });

  it('accepts a raw MPEG sync (0xFF 0xFB) without ID3', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(2048)]);
    expect(validateAudioBody(buf).ok).toBe(true);
  });

  it('accepts fLaC', () => {
    expect(validateAudioBody(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(1024)])).ok).toBe(
      true,
    );
  });

  it('accepts OggS', () => {
    expect(validateAudioBody(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(1024)])).ok).toBe(
      true,
    );
  });

  it('accepts RIFF…WAVE', () => {
    const buf = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x10, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE'),
      Buffer.alloc(1024),
    ]);
    expect(validateAudioBody(buf).ok).toBe(true);
  });

  it('accepts MP4 ftyp box', () => {
    const buf = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from('ftyp'),
      Buffer.from('M4A '),
      Buffer.alloc(1024),
    ]);
    expect(validateAudioBody(buf).ok).toBe(true);
  });

  it('accepts FORM…AIFF', () => {
    const buf = Buffer.concat([
      Buffer.from('FORM'),
      Buffer.from([0, 0, 0, 0x10]),
      Buffer.from('AIFF'),
      Buffer.alloc(1024),
    ]);
    expect(validateAudioBody(buf).ok).toBe(true);
  });

  it('accepts wvpk (WavPack)', () => {
    expect(validateAudioBody(Buffer.concat([Buffer.from('wvpk'), Buffer.alloc(1024)])).ok).toBe(
      true,
    );
  });

  it('accepts MAC  (Monkey Audio, trailing space)', () => {
    expect(validateAudioBody(Buffer.concat([Buffer.from('MAC '), Buffer.alloc(1024)])).ok).toBe(
      true,
    );
  });

  it('accepts ASF/WMA (0x30 0x26 0xB2 0x75 0x8E 0x66 0xCF 0x11)', () => {
    expect(
      validateAudioBody(
        Buffer.concat([
          Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]),
          Buffer.alloc(1024),
        ]),
      ).ok,
    ).toBe(true);
  });

  it('rejects an HTML body (GitHub #23 372B mpegts372 payload)', () => {
    const html = Buffer.from('<!DOCTYPE html><html><head><title>Error</title></head>'.repeat(3));
    const result = validateAudioBody(html);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/HTML|no es audio|textual/i);
  });

  it('rejects a JSON body', () => {
    expect(validateAudioBody(Buffer.from('{"title":"Not Found","status":404}')).ok).toBe(false);
  });

  it('rejects empty buffer as zero-byte (AC2 zero-edge case)', () => {
    const r = validateAudioBody(Buffer.alloc(0));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/0 B|vacío/i) });
  });

  it('rejects when first byte is `{` followed by printable text', () => {
    expect(validateAudioBody(Buffer.from('{ "error": "not found" }')).ok).toBe(false);
  });

  it('rejects plain ASCII text', () => {
    expect(
      validateAudioBody(
        Buffer.from(
          'Welcome to nginx!\nIf you see this page, the web server is installed and working.',
        ),
      ).ok,
    ).toBe(false);
  });
});

describe('isProbablyTextual', () => {
  it('detects <!doctype html> as textual', () => {
    expect(isProbablyTextual(Buffer.from('<!DOCTYPE html><html><head>'), 64)).toBe(true);
  });
  it('detects a JSON object as textual', () => {
    expect(isProbablyTextual(Buffer.from('{"a":1}'), 64)).toBe(true);
  });
  it('does NOT tag binary audio (16 bytes all 0xFF) as textual', () => {
    expect(isProbablyTextual(Buffer.alloc(16, 0xff), 64)).toBe(false);
  });
  it('does NOT tag a 16-byte ID3 header as textual', () => {
    expect(
      isProbablyTextual(Buffer.from('ID3\x03\x00\x00\x00\x10\x00\x00\x00\x00\x00\x00'), 64),
    ).toBe(false);
  });
});

// =============================================================================
// ORAIN-0739 — Task 2: size validation table (AC2)
// =============================================================================
import { validateDownloadSize, MAX_DOWNLOAD_BYTES } from './download-validation';

describe('validateDownloadSize — AC2(a) Content-Length + identity', () => {
  it('accepts when receivedBytes === contentLength', () => {
    expect(
      validateDownloadSize({
        contentLength: 1024,
        contentEncoding: 'identity',
        receivedBytes: 1024,
      }),
    ).toEqual({ ok: true });
  });
  it('fails when receivedBytes < contentLength', () => {
    const r = validateDownloadSize({
      contentLength: 1024,
      contentEncoding: 'identity',
      receivedBytes: 800,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('Descarga incompleta (800 de 1024 bytes)');
  });
  it('fails when contentLength is 0 (zero-length is not audio)', () => {
    const r = validateDownloadSize({
      contentLength: 0,
      contentEncoding: 'identity',
      receivedBytes: 0,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/incompleta|0 de 0/i);
  });
  it('treats missing contentEncoding as identity (proxy default)', () => {
    expect(validateDownloadSize({ contentLength: 1024, receivedBytes: 1024 })).toEqual({
      ok: true,
    });
  });
});

describe('validateDownloadSize — AC2(b) encoded body', () => {
  it('skips the comparison when contentEncoding === gzip', () => {
    expect(
      validateDownloadSize({ contentLength: 4096, contentEncoding: 'gzip', receivedBytes: 1024 }),
    ).toEqual({ ok: true });
  });
  it('skips the comparison when contentEncoding === br', () => {
    expect(
      validateDownloadSize({ contentLength: 4096, contentEncoding: 'br', receivedBytes: 1024 }),
    ).toEqual({ ok: true });
  });
});

describe('validateDownloadSize — AC2(c) declaredSize (track.size) stability', () => {
  it('accepts when receivedBytes === declaredSize', () => {
    expect(validateDownloadSize({ declaredSize: 1024, receivedBytes: 1024 })).toEqual({ ok: true });
  });
  it('returns repeat-advice when receivedBytes differs from declaredSize but matches previousReceivedBytes', () => {
    const r = validateDownloadSize({
      declaredSize: 1024,
      receivedBytes: 800,
      previousReceivedBytes: 800,
    });
    expect(r.ok).toBe(true);
    expect((r as { warning?: string }).warning).toMatch(/tamaño distinto al declarado/i);
  });
  it('fails when receivedBytes differs from both declaredSize and previousReceivedBytes', () => {
    const r = validateDownloadSize({
      declaredSize: 1024,
      receivedBytes: 700,
      previousReceivedBytes: 800,
    });
    expect(r.ok).toBe(false);
  });
  it('ignores declaredSize === 0 (invalid metadata)', () => {
    expect(validateDownloadSize({ declaredSize: 0, receivedBytes: 1024 })).toEqual({ ok: true });
  });
});

describe('validateDownloadSize — AC2(d) no info, AC6 cap', () => {
  it('skips the check when no size info is available', () => {
    expect(validateDownloadSize({ receivedBytes: 1024 })).toEqual({ ok: true });
  });
  it('fails when receivedBytes > 2 GiB and there is no upper bound', () => {
    const r = validateDownloadSize({ receivedBytes: Number(MAX_DOWNLOAD_BYTES) + 1 });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('Archivo demasiado grande (>2 GiB)');
  });
});
