## Summary

<!-- What does this PR do? Why? Related issue: #N -->

## Change type

- [ ] Feature
- [ ] Bugfix
- [ ] Refactor / performance
- [ ] Docs
- [ ] CI / build / deploy
- [ ] Other

## Checklist

- [ ] Ran `npm start` locally; homepage / subscription / projection endpoints work
- [ ] Updated relevant docs (README / env vars / projection.json fields)
- [ ] If touching credentials/auth: no hardcoded ANTHROPIC_API_KEY, Resend API key, or auth tokens; logs and errors do not leak secrets
- [ ] If touching scheduled tasks (node-cron): cron expression timezone/frequency is correct and will not send duplicate emails
- [ ] If touching subscriber data / projection.json: documented compatibility impact on existing data

## How to test

<!-- How to verify? Consider covering: homepage render, subscribe/unsubscribe, competitor crawl, scheduled email, /api/projection, etc. -->

## Notes

<!-- Extra context for reviewers (optional) -->
