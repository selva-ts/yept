# Licence sources

`npm run check:licenses` regenerates the ignored `build/THIRD_PARTY_NOTICES.txt` and checks the installed dependency tree offline. Builds regenerate the same notices, which are available in About and packaged beside the project's MIT licence.

The inventory covers every installed lockfile package instance, including build dependencies: React, Monaco and other renderer libraries are bundled even though they are development dependencies. Duplicate versions retain separate entries. Absent optional packages for other platforms are reported and skipped. First-party workspaces share the root licence; the local requests stand-in has its own copy.

Installed licence documents, copyright files and supplemental third-party notices are retained. When an exact published version omits a licence document, `sources.json` records one of these sources:

- `upstream-source`: the project's complete licence at the published revision, with its source URL and SHA-256.
- `published-readme`: a complete grant and copyright notice extracted from the published README, with both the README and extracted text checksums.
- `declared-standard`: standard SPDX terms matching the exact published package's declaration and lockfile integrity. These are explicitly labelled in the notices. Published author metadata is included when supplied; it is not asserted to be a copyright notice. No copyright owner or year is invented. The pinned SPDX source and processing note are recorded under `standards`.

The current inventory uses standard terms for 18 package versions whose published sources omit a complete document. This records the available declaration and attribution; it does not claim that an upstream copyright notice was recovered. Binary platform families are limited to exact versions and the expected upstream repository.

The checker permits an explicit set of permissive software licences. `OR` selects a permitted option with matching terms (Apache-2.0 for DOMPurify); `AND` requires terms for both. Unknown expressions and unsupported exceptions fail. The `metadata` records separately bind reviews of json-query's missing declaration, tv4's public-domain notice and caniuse-lite's CC-BY-4.0 browser-support data to exact versions, original declarations, package integrity and evidence checksums. These records do not generally allow arbitrary custom or attribution-data licences.

The extension test harness also brings in pako, which requires both MIT and Zlib terms. Its root licence contains MIT; the complete Zlib grant and attribution are embedded in `lib/zlib/README`. The `supplements` record retains that installed document in notices and checks both its SHA-256 and the exact package integrity before accepting it.

After a dependency change, review upstream terms before updating records. Keep the exact version, integrity, source URL and checksums; preserve copyright and supplemental notices. A missing licence must be resolved explicitly rather than silently omitted. The generator and checker never fetch source documents.

Electron and Chromium ship their own runtime licence files separately as `LICENSE.electron.txt` and `LICENSES.chromium.html`. When validating a package, compare its notices and project licence with the generated files and check the dependency names and versions in `resources/app.asar` against the inventory. The inventory's build-dependency coverage also includes libraries embedded in renderer bundles.
