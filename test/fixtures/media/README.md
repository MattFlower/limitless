These are generated audit fixtures, with two complete, distinct variants of each format.
Images are colored squares (FFmpeg; lossless WebP via cwebp), audio is a short sine wave
(FFmpeg), and fonts contain only an original triangle glyph (fontTools FontBuilder).
JPEG encoder comments were removed; ICO embeds the PNG; WOFF2 covers both untransformed
CFF and transformed TrueType outlines. The bytes are base64 in files.json, following the
existing binary fixture convention; tests decode them and need no encoders.

Opaque fixtures are a small binary PDF, ZIP/JAR containing JavaScript, USTAR containing
a UTF-8 filename, and WASM containing a custom section. Archives were generated with
Python's standard library. None of these formats receives a media exemption.

regressions.json contains a hand-packed lossless WebP whose left predictor reconstructs
the ZIP fixture as RGBA pixels (verified with dwebp), literal and color-indexed versions
of that payload, plus two clean transform-free literal WebPs. Predicted FLAC fixtures
were encoded with the stock flac encoder at levels 0 and 8 from 16-bit mono PCM
containing zeros, the ZIP fixture, and zeros; variants cross a frame boundary and use
big-endian PCM. The WOFF pair reorders the original font tables with correct checksums
and zlib compression: OS/2
ends in `PK`, while the adjacent hmtx starts in `\x03\x04` only in the payload variant.
No payload fixture contains the ZIP local-header signature in its raw encoded bytes.
Tests use these stored bytes without invoking an encoder or decoder.
