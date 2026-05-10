# Homebrew packaging

The master formula template lives in [`lisa.rb`](lisa.rb).

The actual formula that users install lives in a **separate** GitHub repo:
`github.com/oratis/homebrew-tap`. Per release:

1. Cut a tagged release in this repo (`git tag v0.X.Y && git push --tags`, then make a GitHub Release).
2. Compute the sha256 of the release tarball:

   ```sh
   curl -sL "https://github.com/oratis/LISA/archive/refs/tags/v0.X.Y.tar.gz" \
     | shasum -a 256 | cut -d' ' -f1
   ```

3. In the `homebrew-tap` repo, update `Formula/lisa.rb`:
   - `url` → new tag URL
   - `sha256` → output of step 2
   - `version` (bump)

4. Commit + push the tap. Users running `brew update` will see the new version.

## Why a separate tap repo?

Homebrew's convention. The `homebrew-tap` naming pattern is what `brew tap oratis/tap` discovers. Putting the formula in this repo (LISA) instead would force users to do `brew install --HEAD oratis/LISA/lisa` which is awkward.

## User-side install

```sh
brew tap oratis/tap
brew install lisa

# Updates:
brew update && brew upgrade lisa
```

## Verifying the formula locally before publishing

```sh
brew install --build-from-source ./packaging/homebrew/lisa.rb
brew test lisa
brew audit --strict --new ./packaging/homebrew/lisa.rb
```

(Audit warnings about `version` line being unnecessary are fine — `brew audit` is strict; the formula matches the upstream tap conventions.)
