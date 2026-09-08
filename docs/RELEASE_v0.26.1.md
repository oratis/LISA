# Lisa v0.26.1

**The v0.26.0 DMG.** v0.26.0 is the release that makes Lisa.app self-contained,
and its Mac job failed before producing a disk image — so it shipped the CLI
bundles with the one asset it was about missing. Same contents, plus the
one-character fix that lets the DMG build.

## 🔧 `embed-runtime.sh` under a UTF-8 locale

The release job died at `embed-runtime.sh: line 124: tarball<U+2026>: unbound
variable`. Under a UTF-8 locale, bash 3.2 — still `/bin/bash` on macOS, GitHub
runners included — swallows the bytes of a following multibyte character into an
identifier, so `"$tarball…"` expands a variable named `tarball` *plus the
ellipsis*, which is unset, and `set -u` aborts:

```sh
LC_ALL=en_US.UTF-8 bash -uc 'v=x; echo "$v…"'   # -> v…: unbound variable
LC_ALL=C           bash -uc 'v=x; echo "$v…"'   # -> fine
```

Note the direction — the **UTF-8** locale is the one that breaks. Every local
run and every `bash 5` passes, which is why this only ever surfaced on the
tag-triggered release job, running for the first time now that there is
something to embed.

Braced, and the tree swept for the same shape: it was the only occurrence.
Verified end to end under `LC_ALL=en_US.UTF-8`, the exact locale CI uses.

See [v0.26.0's notes](RELEASE_v0.26.0.md) for what actually changed.
