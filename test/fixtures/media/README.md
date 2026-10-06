These are generated audit fixtures, with two complete, distinct variants of each format.
Images are colored squares (FFmpeg; lossless WebP via cwebp), audio is a short sine wave
(FFmpeg), and fonts contain only an original triangle glyph (fontTools FontBuilder).
JPEG encoder comments were removed; ICO embeds the PNG; WOFF2 covers both untransformed
CFF and transformed TrueType outlines. The bytes are base64 in files.json, following the
existing binary fixture convention; tests decode them and need no encoders.

Opaque fixtures are a small binary PDF, ZIP/JAR containing JavaScript, USTAR containing
a UTF-8 filename, and WASM containing a custom section. Archives were generated with
Python's standard library. None of these formats receives a media exemption.
