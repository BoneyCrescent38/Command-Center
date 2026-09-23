# Explicit service roots: phase-3 preparation

The controller resolves KIF production at C:\ChatGPT App\KIF\Hovedserver and preview at C:\ChatGPT App\KIF\Testserver. Its production adapter is maintained in Command-Center. Dashboard lifecycle scripts resolve under C:\ChatGPT App\Dashboard\Nettleser-app. No KIF product source is changed.

A reachable health endpoint is not proof of process ownership. The controller accepts a verified identity only when service ID, explicit root, port, Git commit, running release and process ownership agree.

## Activation gate still blocked

On 2026-09-23 the read-only preflight against the existing production root returned the approved KIF 3.5.0/schema0022/build114/126af7c health under both tokens. The ordinary controller token could not read the LOCAL SERVICE process executable, working directory or owner, so ownedProcess and identityVerified were false. The same Status probe with UAC verified all three and returned Running.

Do not integrate or activate this branch until ongoing process identity can be verified under an explicitly accepted controller privilege model. Do not remove the ownership check, broaden production permissions, elevate the whole controller by default, or change KIF product code merely to make the status green.

The isolated build and targeted policy/contract tests passed. No active service was stopped or moved. No new autostart model was created.
