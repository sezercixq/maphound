## What does this change?

<!-- One or two sentences. Link the issue it closes, e.g. "Closes #12". -->

## Type

- [ ] New or changed detector rule
- [ ] Bug fix
- [ ] Feature
- [ ] Documentation or tooling

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass locally
- [ ] Tests cover the change (unit, rule samples or e2e)

### For detector rules

- [ ] `pnpm rules:check` passes (schema, samples and ReDoS proof)
- [ ] The rule has at least one positive and one negative sample, including a placeholder that must **not** match
- [ ] Positive samples are randomly generated and carry the `{{}}` split marker inside the secret
- [ ] **No real, active or previously valid credential appears anywhere in this pull request**
- [ ] `references` links to the provider's documentation of the format
- [ ] Severity reflects what an attacker could do; publishable keys use `public: true`

### For changes that touch permissions, network or storage

- [ ] No new permission, no new outbound request, no remote code; or the reason is explained above and `docs/PRIVACY.md` is updated
