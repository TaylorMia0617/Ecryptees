# `.emp4` v1 format

`.emp4` is an Ecryptees container for one byte-exact MP4 file. It is not an MP4 codec, DRM scheme, or fragmented-MP4 variant. Decrypting the complete payload restores the original input bytes without transcoding or remuxing.

All integers are unsigned big-endian. Sizes and offsets are bytes.

## Layout

```text
160-byte fixed header
encrypted UTF-8 JSON manifest || 16-byte GCM tag       counter 0
encrypted MP4 chunk 0 || 16-byte GCM tag               counter 1
encrypted MP4 chunk 1 || 16-byte GCM tag               counter 2
...
```

The content chunk size is exactly 1 MiB. The final chunk may be shorter. The archive must end immediately after the final authentication tag.

## Fixed header

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | ASCII magic `ECRVID1\0` |
| 8 | 1 | version, `1` |
| 9 | 1 | key mode: `0` built-in |
| 10 | 1 | KDF: `1` HKDF-SHA-256 |
| 11 | 1 | cipher: `1` AES-256-GCM |
| 12 | 4 | flags, currently zero |
| 16 | 4 | header size, `160` |
| 20 | 4 | chunk size, `1048576` |
| 24 | 4 | encrypted manifest length including its tag |
| 28 | 4 | MP4 chunk count |
| 32 | 8 | original MP4 size |
| 40 | 4 | reserved, zero |
| 44 | 4 | reserved, zero |
| 48 | 16 | KDF salt |
| 64 | 12 | content-key wrapping nonce |
| 76 | 4 | reserved, zero |
| 80 | 8 | content nonce prefix |
| 88 | 8 | built-in key ID |
| 96 | 48 | wrapped 32-byte content key plus GCM tag |
| 144 | 16 | reserved, zero |

The key-encryption key is derived with HKDF-SHA-256 and the application key material. Each file has a fresh random 256-bit content key. `.emp4` v1 deliberately has no user-password mode; readers must reject any other key-mode or KDF value.

The wrapping AAD is the complete header with bytes 96–143 replaced by zero. The content-key wrapping IV is bytes 64–75.

## Manifest

The encrypted manifest is JSON with these authenticated fields:

- `version`
- `title`
- `originalName`
- `mime`, always `video/mp4` in v1
- `size`
- `chunkCount`
- `lastModified`
- `createdAt`

The manifest plaintext is limited to 64 KiB. It uses content counter zero.

## Content authentication

Every manifest or MP4 chunk uses AES-256-GCM with a 128-bit tag.

```text
nonce = 8-byte content nonce prefix || uint32(counter)
AAD   = complete 160-byte header || uint32(counter) || uint32(plain length)
```

The MP4 chunk at zero-based index `i` uses counter `i + 1`. A reader must authenticate a complete encrypted chunk before releasing any bytes from it.

For MP4 chunk `i`:

```text
plainLength  = min(1 MiB, originalSize - i * 1 MiB)
cipherOffset = 160 + manifestCipherLength + i * (1 MiB + 16)
```

The random content key is unique per archive, and counters must never be reused when rewriting content under the same key.

## Application storage and playback

The archive layout still permits a plaintext byte range to be mapped to the authenticated chunks containing its first and last byte. This is a format property, not the current asset-storage model.

Current Ecryptees versions authenticate and decrypt an imported `.emp4` completely, then commit the restored original MP4 to app-private storage. Playback and original-file export read that MP4 directly. Exporting `.emp4` performs the reverse conversion into a temporary file and removes it after the download handoff. A legacy encrypted asset is deleted only after its restored MP4 and metadata have both committed successfully.

When `index.html` is opened directly through `file://`, Chromium can forbid persistent origin storage. The compatibility path still authenticates and decrypts the archive in the current page so it can be played or exported, but clearly reports that the transient MP4 was not added to persistent assets.

## Security boundary

The built-in key detects damage and hides bytes but is not private because its key material ships with the application. Playback is not DRM: a hostile runtime can capture decrypted bytes or record the screen.
